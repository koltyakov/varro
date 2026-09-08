/* oxlint-disable anti-slop/no-runtime-typeof -- Validate caller options and persisted JSON at I/O boundaries. */
import { createHash } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  buildReplayTimeline,
  importHistoricalPlayback,
  readPlaybackCapture,
} from './ai-session-playback.mjs';

const SCAN_LIMIT = 500;
const WEIGHTS = {
  reasoning: 2,
  text: 1,
  tools: 2,
  edits: 3,
  long_output: 2,
  markdown: 2,
  baseline_virtualization: 3,
};
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Returns the schema-versioned manifest also written to outputDirectory/manifest.json. */
export async function prepareStreamingRun({
  sourceDatabase,
  directory,
  controllerSessionId,
  seed,
  count = 3,
  outputDirectory,
}) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  for (const [name, value] of Object.entries({
    sourceDatabase,
    directory,
    controllerSessionId,
    outputDirectory,
  })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > SCAN_LIMIT) {
    throw new Error(`count must be an integer between 1 and ${SCAN_LIMIT}`);
  }
  if (!((typeof seed === 'string' && seed.trim()) || Number.isSafeInteger(seed))) {
    throw new Error('seed must be a nonempty string or a safe integer');
  }
  sourceDatabase = path.resolve(sourceDatabase);
  outputDirectory = path.resolve(outputDirectory);
  const playbackDatabase = path.join(outputDirectory, 'playback.db');
  const manifestPath = path.join(outputDirectory, 'manifest.json');
  const rejected = [];
  const candidates = [];
  let scanned;
  let truncated;
  const source = new DatabaseSync(sourceDatabase, { readOnly: true });
  try {
    source.exec('PRAGMA query_only = ON; BEGIN');
    // Bound candidate materialization, but check inactivity against the entire session.
    const rows = source
      .prepare(`
      SELECT m.* FROM message m JOIN session s ON s.id = m.session_id
      WHERE s.directory = ? COLLATE BINARY AND json_extract(m.data, '$.role') = 'assistant'
      ORDER BY m.time_created DESC, m.id DESC LIMIT ?
    `)
      .all(directory, SCAN_LIMIT + 1);
    truncated = rows.length > SCAN_LIMIT;
    scanned = Math.min(rows.length, SCAN_LIMIT);
    const incomplete = source.prepare(`
      SELECT 1 FROM message WHERE session_id = ?
      AND json_extract(data, '$.role') = 'assistant'
      AND (json_type(data, '$.time.completed') IS NULL
        OR json_type(data, '$.time.completed') NOT IN ('integer', 'real')
        OR json_extract(data, '$.time.completed') <= 0) LIMIT 1
    `);
    const parent = source.prepare('SELECT * FROM message WHERE id = ? AND session_id = ?');
    const partsQuery = source.prepare(
      'SELECT data FROM part WHERE message_id = ? AND session_id = ? ORDER BY time_created, id'
    );
    const baselineQuery = source.prepare(`
      SELECT id FROM message WHERE session_id = ? AND time_created < ?
      ORDER BY time_created DESC, id DESC LIMIT 120
    `);
    const inactive = new Map();
    for (const row of rows.slice(0, SCAN_LIMIT)) {
      const ids = { sourceSessionId: row.session_id, sourceMessageId: row.id };
      const data = JSON.parse(row.data);
      let reason;
      if (row.session_id === controllerSessionId) reason = 'controller-session';
      else {
        if (!inactive.has(row.session_id)) {
          inactive.set(row.session_id, !incomplete.get(row.session_id));
        }
        if (!inactive.get(row.session_id)) reason = 'session-has-incomplete-assistant';
      }
      const user =
        typeof data.parentID === 'string' ? parent.get(data.parentID, row.session_id) : undefined;
      if (!reason && (!user || JSON.parse(user.data).role !== 'user')) {
        reason = 'not-linked-to-user';
      }
      if (reason) {
        rejected.push({ ...ids, reason });
        continue;
      }
      const parts = partsQuery.all(row.id, row.session_id).map((part) => JSON.parse(part.data));
      const text = parts
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
      const reasoning = parts.some((part) => part.type === 'reasoning' && part.text?.length > 0);
      const tools = parts.filter((part) => part.type === 'tool');
      const outputCharacters =
        text.length +
        tools.reduce(
          (total, part) =>
            total + (typeof part.state?.output === 'string' ? part.state.output.length : 0),
          0
        );
      const baselineMessages = baselineQuery.all(row.session_id, user.time_created).length;
      const flags = {
        reasoning,
        text: text.length > 0,
        tools: tools.length > 0,
        edits:
          tools.some((part) =>
            ['edit', 'write', 'apply_patch', 'multiedit'].includes(part.tool?.toLowerCase())
          ) || parts.some((part) => part.type === 'patch'),
        long_output: outputCharacters >= 4_000,
        markdown:
          /(^|\n)(#{1,6} |```|~~~|\s*[-*+] |\s*\d+\. |\|)|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*/.test(
            text
          ),
        baseline_virtualization: baselineMessages > 50,
      };
      const features = Object.keys(WEIGHTS).filter((feature) => flags[feature]);
      candidates.push({
        ...ids,
        sourceUserMessageId: user.id,
        features,
        score: features.reduce((total, feature) => total + WEIGHTS[feature], 0),
        tieBreak: hash([seed, row.session_id, row.id]),
        metrics: { baselineMessages, outputCharacters, toolCount: tools.length },
        sourceDurationMs: Math.max(0, data.time.completed - data.time.created),
      });
    }
  } finally {
    source.close();
  }

  const covered = new Set();
  const selected = [];
  const remaining = [...candidates];
  while (selected.length < count && remaining.length) {
    const gain = (candidate) =>
      candidate.features.reduce(
        (total, feature) => total + (covered.has(feature) ? 0 : WEIGHTS[feature]),
        0
      );
    remaining.sort(
      (a, b) =>
        gain(b) - gain(a) ||
        b.score - a.score ||
        (a.tieBreak < b.tieBreak ? -1 : a.tieBreak > b.tieBreak ? 1 : 0) ||
        (a.sourceMessageId < b.sourceMessageId ? -1 : 1)
    );
    const candidate = remaining.shift();
    const uncoveredFeatures = candidate.features.filter((feature) => !covered.has(feature));
    selected.push({
      ...candidate,
      selection: {
        uncoveredFeatures,
        gain: gain(candidate),
        reason: uncoveredFeatures.length
          ? `Adds uncovered features: ${uncoveredFeatures.join(', ')}`
          : 'Coverage exhausted; highest total score, then seeded tie break',
      },
    });
    candidate.features.forEach((feature) => covered.add(feature));
  }
  rejected.push(...remaining.map((candidate) => ({ ...candidate, reason: 'count-limit' })));

  // Exclusive creation prevents overwriting prior runs, symlinks, or the source database.
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const manifestFile = await open(manifestPath, 'wx', 0o600);
  try {
    const playbackFile = await open(playbackDatabase, 'wx', 0o600);
    await playbackFile.close();
    for (const candidate of selected) {
      const imported = importHistoricalPlayback({
        sourceDatabase,
        playbackDatabase,
        sessionId: candidate.sourceSessionId,
        messageId: candidate.sourceMessageId,
        label: `Streaming history ${candidate.sourceMessageId}`,
      });
      const capture = readPlaybackCapture(playbackDatabase, imported.id);
      const capturePath = path.join(outputDirectory, `capture-${imported.id}.json`);
      const serialized = `${JSON.stringify(capture, null, 2)}\n`;
      await writeFile(capturePath, serialized, { flag: 'wx', mode: 0o600 });
      candidate.capture = {
        path: capturePath,
        database: playbackDatabase,
        id: imported.id,
        sha256: createHash('sha256').update(serialized).digest('hex'),
      };
      candidate.timing = {
        sourceDurationMs: candidate.sourceDurationMs,
        reconstructedDurationMs: capture.events.at(-1)?.offsetMs ?? 0,
        replayDurationMs: buildReplayTimeline(capture.events).reduce(
          (sum, event) => sum + event.delayMs,
          0
        ),
        eventCount: capture.events.length,
      };
    }
    const available = new Set(candidates.flatMap((candidate) => candidate.features));
    const manifest = {
      schemaVersion: 1,
      sourceDatabase,
      directory,
      controllerSessionId,
      seed,
      requestedCount: count,
      selectedCount: selected.length,
      shortfall: count - selected.length,
      playbackDatabase,
      manifestPath,
      provenance: {
        scenario: 'HISTORY',
        cadence: 'reconstructed',
        description:
          'Persisted history with synthesized deltas and tool transitions, not recorded live timing.',
      },
      scan: {
        limit: SCAN_LIMIT,
        scanned,
        truncated,
        eligible: candidates.length,
        order: 'time_created DESC, id DESC',
      },
      policy: {
        weights: WEIGHTS,
        longOutputCharacters: 4_000,
        baselineMessages: 51,
        baselineLimit: 120,
      },
      selected,
      rejected,
      coverage: {
        covered: Object.keys(WEIGHTS).filter((feature) => covered.has(feature)),
        missing: Object.keys(WEIGHTS)
          .filter((feature) => !covered.has(feature))
          .map((feature) => ({
            feature,
            reason: available.has(feature) ? 'count-limit' : 'unavailable-in-eligible-scan',
          })),
      },
      selectionHash: hash([
        seed,
        selected.map(({ sourceSessionId, sourceMessageId, features }) => ({
          sourceSessionId,
          sourceMessageId,
          features,
        })),
      ]),
      timing: {
        startedAt,
        completedAt: new Date().toISOString(),
        elapsedMs: performance.now() - started,
      },
    };
    await manifestFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    await manifestFile.close();
  }
}
