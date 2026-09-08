/* oxlint-disable anti-slop/no-runtime-typeof -- Validate caller options and persisted JSON at I/O boundaries. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
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

export async function readActiveSessions(
  { serverUrl, sourceDatabase, directory, pid = process.env.OPENCODE_PID },
  execute = promisify(execFile)
) {
  let explicit;
  if (serverUrl) {
    explicit = new URL(serverUrl);
    if (
      explicit.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(explicit.hostname) ||
      explicit.username ||
      explicit.password ||
      explicit.pathname !== '/' ||
      explicit.search ||
      explicit.hash
    )
      throw new Error('server-url must be a credential-free numeric loopback HTTP origin');
  } else {
    if (!/^\d+$/.test(pid ?? '') || Number(pid) <= 0)
      throw new Error('Active-session status requires --server-url or OPENCODE_PID');
  }
  const canonicalDatabase = await realpath(sourceDatabase);
  const { stdout } = await execute(
    'lsof',
    explicit
      ? ['-nP', '-a', `-iTCP:${explicit.port || 80}`, '-sTCP:LISTEN', '-Fpn']
      : ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fpn'],
    { timeout: 5_000 }
  );
  const listeners = new Map();
  let owner;
  for (const line of stdout.split('\n')) {
    if (/^p\d+$/.test(line)) owner = line.slice(1);
    const match = /^n(127\.0\.0\.1|\[::1\]|\*):(\d+)$/.exec(line);
    if (!match || !owner) continue;
    const host = match[1] === '*' ? (explicit?.hostname ?? '127.0.0.1') : match[1];
    const url = new URL(`http://${host}:${match[2]}`).origin;
    if (explicit && url !== explicit.origin) continue;
    if (!listeners.has(url)) listeners.set(url, new Set());
    listeners.get(url).add(owner);
  }
  if (explicit && (listeners.size !== 1 || listeners.get(explicit.origin)?.size !== 1))
    throw new Error('Cannot identify one listener owner for --server-url');
  const snapshots = [];
  for (const [value, owners] of listeners) {
    if (owners.size !== 1) throw new Error('Ambiguous status listener ownership');
    const serverPid = [...owners][0];
    // lsof's path selection uses file identity, including symlink and hard-link aliases.
    const held = await execute(
      'lsof',
      ['-nP', '-a', '-p', serverPid, '-Fpf', '--', canonicalDatabase],
      { timeout: 5_000 }
    ).catch((error) => {
      throw new Error(
        `Cannot verify status server PID ${serverPid} holds source database: ${error.message}`
      );
    });
    if (!held.stdout.split('\n').includes(`p${serverPid}`) || !/^f\d+/m.test(held.stdout))
      throw new Error(`Status server PID ${serverPid} does not hold source database`);
    try {
      const url = new URL(value);
      const endpoint = new URL('/session/status', url);
      endpoint.searchParams.set('directory', directory);
      const response = await fetch(endpoint, {
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Session status HTTP ${response.status}`);
      const status = await response.json();
      if (
        !status ||
        Array.isArray(status) ||
        typeof status !== 'object' ||
        Object.values(status).some((entry) => !['idle', 'busy', 'retry'].includes(entry?.type))
      )
        throw new Error('Invalid session status response');
      snapshots.push({
        serverUrl: url.origin,
        serverPid: Number(serverPid),
        sourceDatabase: canonicalDatabase,
        association: 'lsof-listener-owner-and-open-database',
        checkedAt: new Date().toISOString(),
        activeSessionIds: Object.keys(status).filter((id) => status[id].type !== 'idle'),
      });
    } catch (error) {
      if (serverUrl) throw error;
      // Other listeners owned by the process need not be OpenCode HTTP servers.
    }
  }
  if (snapshots.length !== 1)
    throw new Error('Cannot identify one active-session status endpoint; supply --server-url');
  return snapshots[0];
}

/** Returns the schema-versioned manifest also written to outputDirectory/manifest.json. */
export async function prepareStreamingRun({
  sourceDatabase,
  directory,
  controllerSessionId,
  sourceSessionId,
  serverUrl,
  seed,
  count = 3,
  outputDirectory,
}) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  for (const [name, value] of Object.entries({
    sourceDatabase,
    directory,
    outputDirectory,
  })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  }
  for (const [name, value] of Object.entries({ controllerSessionId, sourceSessionId })) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim()))
      throw new Error(`Invalid ${name}`);
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
  const activity = await readActiveSessions({ serverUrl, sourceDatabase, directory });
  sourceDatabase = activity.sourceDatabase;
  const active = new Set(activity.activeSessionIds);
  let scanned;
  let truncated;
  const source = new DatabaseSync(sourceDatabase, { readOnly: true });
  try {
    source.exec('PRAGMA query_only = ON; BEGIN');
    // Rank bounded session metadata first; response coverage is evaluated within that scope.
    const sessions = source
      .prepare(`
      SELECT s.id, COUNT(m.id) AS messageCount FROM session s JOIN message m ON m.session_id = s.id
      WHERE s.directory = ? COLLATE BINARY AND (? IS NULL OR s.id = ?)
      GROUP BY s.id ORDER BY messageCount DESC, s.id ASC LIMIT ?
    `)
      .all(directory, sourceSessionId ?? null, sourceSessionId ?? null, SCAN_LIMIT + 1);
    truncated = sessions.length > SCAN_LIMIT;
    scanned = Math.min(sessions.length, SCAN_LIMIT);
    const responses = source.prepare(`SELECT * FROM message WHERE session_id = ?
      AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created DESC, id DESC LIMIT 51`);
    const rows = sessions.slice(0, SCAN_LIMIT).flatMap((session) => {
      const messages = responses.all(session.id);
      if (messages.length > 50) truncated = true;
      return messages
        .slice(0, 50)
        .map((row) => ({ ...row, historyMessages: session.messageCount }));
    });
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
    const complete = new Map();
    for (const row of rows) {
      const ids = { sourceSessionId: row.session_id, sourceMessageId: row.id };
      const data = JSON.parse(row.data);
      let reason;
      if (row.session_id === controllerSessionId) reason = 'controller-session';
      else if (active.has(row.session_id)) reason = 'active-session';
      else {
        if (!complete.has(row.session_id)) {
          complete.set(row.session_id, !incomplete.get(row.session_id));
        }
        if (!complete.get(row.session_id)) reason = 'session-has-incomplete-assistant';
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
        metrics: {
          historyMessages: row.historyMessages,
          baselineMessages,
          outputCharacters,
          toolCount: tools.length,
        },
        sourceDurationMs: Math.max(0, data.time.completed - data.time.created),
      });
    }
  } finally {
    source.close();
  }

  const covered = new Set();
  const selected = [];
  const sessionSubset = [
    ...new Set(candidates.map((candidate) => candidate.sourceSessionId)),
  ].slice(0, count);
  const remaining = candidates.filter((candidate) =>
    sessionSubset.includes(candidate.sourceSessionId)
  );
  rejected.push(
    ...candidates
      .filter((candidate) => !sessionSubset.includes(candidate.sourceSessionId))
      .map((candidate) => ({ ...candidate, reason: 'outside-longest-session-subset' }))
  );
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
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (remaining[i].sourceSessionId === candidate.sourceSessionId)
        rejected.push({ ...remaining.splice(i, 1)[0], reason: 'distinct-session-limit' });
    }
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
    const subsetFeatures = new Set(
      candidates
        .filter((candidate) => sessionSubset.includes(candidate.sourceSessionId))
        .flatMap((candidate) => candidate.features)
    );
    const manifest = {
      schemaVersion: 1,
      sourceDatabase,
      directory,
      controllerSessionId: controllerSessionId ?? null,
      sourceSessionId: sourceSessionId ?? null,
      activity,
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
        unit: 'sessions',
        scanned,
        truncated,
        eligible: candidates.length,
        order: 'session message count DESC, session id ASC; response time_created DESC, id DESC',
        responsesPerSession: 50,
      },
      policy: {
        sessionSubset,
        historyLength: 'total persisted messages',
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
            reason: subsetFeatures.has(feature)
              ? 'distinct-session-limit'
              : available.has(feature)
                ? 'outside-longest-session-subset'
                : 'unavailable-in-eligible-scan',
          })),
      },
      selectionHash: hash([
        seed,
        selected.map(({ sourceSessionId: selectedSessionId, sourceMessageId, features }) => ({
          sourceSessionId: selectedSessionId,
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
