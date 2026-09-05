/* oxlint-disable anti-slop/no-runtime-typeof -- This script validates captured JSON and SQLite rows at their I/O boundaries. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const DEFAULT_DATABASE = 'varro-playback.db';
const DEFAULT_SHORT_GAP_MS = 250;
const DEFAULT_MAX_GAP_MS = 500;
const DEFAULT_HISTORY_DATABASE = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
const HISTORY_BASELINE_MESSAGES = 120;
const MAX_STREAM_CHUNKS = 80;

function openDatabase(filePath) {
  const database = new DatabaseSync(filePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS playback (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      scenario TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      model TEXT,
      session_json TEXT NOT NULL,
      initial_messages_json TEXT NOT NULL,
      final_messages_json TEXT NOT NULL,
      events_json TEXT NOT NULL
    );
  `);
  return database;
}

function collectSessionIds(value, ids, key = '') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectSessionIds(item, ids, key);
    return;
  }
  for (const [childKey, child] of Object.entries(value)) {
    if ((childKey === 'sessionID' || childKey === 'sessionId') && typeof child === 'string') {
      ids.add(child);
    }
    if (childKey === 'info' && key === 'properties' && child && typeof child === 'object') {
      const type = value.type;
      const id = child.id;
      if (typeof type === 'string' && type.startsWith('session.') && typeof id === 'string') {
        ids.add(id);
      }
    }
    collectSessionIds(child, ids, childKey);
  }
}

export function eventBelongsToSession(event, sessionId) {
  if (
    typeof event?.type === 'string' &&
    event.type.startsWith('session.') &&
    event.properties?.info?.id === sessionId
  ) {
    return true;
  }
  const ids = new Set();
  collectSessionIds(event, ids);
  return ids.has(sessionId);
}

export function normalizeCapturedEvents(events, sessionId) {
  return events
    .filter((entry) => eventBelongsToSession(entry.event, sessionId))
    .map((entry) => {
      const event = structuredClone(entry.event);
      delete event.id;
      delete event.seq;
      delete event.sequenceOnly;
      return { offsetMs: Math.max(0, Number(entry.offsetMs) || 0), event };
    });
}

export function buildReplayTimeline(
  events,
  { shortGapMs = DEFAULT_SHORT_GAP_MS, maxGapMs = DEFAULT_MAX_GAP_MS } = {}
) {
  if (shortGapMs < 0 || maxGapMs < shortGapMs) {
    throw new Error('Replay timing requires 0 <= shortGapMs <= maxGapMs');
  }
  let previousOffset = 0;
  return events.map((entry) => {
    const offsetMs = Math.max(previousOffset, Number(entry.offsetMs) || 0);
    const sourceGapMs = offsetMs - previousOffset;
    previousOffset = offsetMs;
    return {
      ...entry,
      delayMs: sourceGapMs <= shortGapMs ? sourceGapMs : maxGapMs,
      sourceGapMs,
    };
  });
}

export function savePlaybackCapture(filePath, capture) {
  const events = normalizeCapturedEvents(capture.events, capture.session.id);
  if (events.length === 0) throw new Error('Capture has no events for the selected session');
  const database = openDatabase(filePath);
  try {
    const result = database
      .prepare(
        `INSERT INTO playback (
          label, scenario, captured_at, source_session_id, model, session_json,
          initial_messages_json, final_messages_json, events_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        capture.label,
        capture.scenario,
        capture.capturedAt,
        capture.session.id,
        capture.model ?? null,
        JSON.stringify(capture.session),
        JSON.stringify(capture.initialMessages),
        JSON.stringify(capture.finalMessages),
        JSON.stringify(events)
      );
    return { id: Number(result.lastInsertRowid), eventCount: events.length, filePath };
  } finally {
    database.close();
  }
}

export function readPlaybackCapture(filePath, id) {
  const database = openDatabase(filePath);
  try {
    const row = database.prepare('SELECT * FROM playback WHERE id = ?').get(id);
    if (!row) throw new Error(`Playback ${String(id)} was not found in ${filePath}`);
    return {
      id: Number(row.id),
      label: row.label,
      scenario: row.scenario,
      capturedAt: row.captured_at,
      sourceSessionId: row.source_session_id,
      model: row.model,
      session: JSON.parse(row.session_json),
      initialMessages: JSON.parse(row.initial_messages_json),
      finalMessages: JSON.parse(row.final_messages_json),
      events: JSON.parse(row.events_json),
    };
  } finally {
    database.close();
  }
}

function parseJson(value, owner) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Could not parse ${owner}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function projectHistoricalMessage(row) {
  return {
    info: { ...parseJson(row.data, `message ${row.id}`), id: row.id, sessionID: row.session_id },
    parts: [],
  };
}

function projectHistoricalPart(row) {
  return {
    ...parseJson(row.data, `part ${row.id}`),
    id: row.id,
    messageID: row.message_id,
    sessionID: row.session_id,
  };
}

function streamChunks(text) {
  const chunkSize = Math.max(240, Math.ceil(text.length / MAX_STREAM_CHUNKS));
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    chunks.push(text.slice(offset, offset + chunkSize));
  }
  return chunks;
}

export function reconstructHistoricalEvents(sessionId, userMessage, assistantMessage, partRows) {
  const events = [];
  let order = 0;
  const add = (offsetMs, event) => events.push({ offsetMs: Math.max(0, offsetMs), order: order++, event });
  add(0, { type: 'message.updated', properties: { info: userMessage.info } });
  for (const part of userMessage.parts) {
    add(4, { type: 'message.part.updated', properties: { part } });
  }
  add(8, { type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
  const activeInfo = structuredClone(assistantMessage.info);
  if (activeInfo.time) delete activeInfo.time.completed;
  delete activeInfo.finish;
  delete activeInfo.error;
  add(12, { type: 'message.updated', properties: { info: activeInfo } });

  const assistantCreated = Number(assistantMessage.info.time?.created) || 0;
  let lastOffset = 12;
  for (const row of partRows) {
    const part = projectHistoricalPart(row);
    const sourceOffset = Math.max(16, Number(row.time_created) - assistantCreated);
    const baseOffset = Number.isFinite(sourceOffset) ? sourceOffset : lastOffset + 16;
    if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') {
      const finalText = part.text;
      const chunks = streamChunks(finalText);
      add(baseOffset, {
        type: 'message.part.updated',
        properties: { part: { ...part, text: '' } },
      });
      chunks.forEach((delta, index) => {
        add(baseOffset + (index + 1) * 32, {
          type: 'message.part.delta',
          properties: {
            sessionID: sessionId,
            messageID: assistantMessage.info.id,
            partID: part.id,
            field: 'text',
            delta,
          },
        });
      });
      const completedAt = baseOffset + (chunks.length + 1) * 32;
      add(completedAt, { type: 'message.part.updated', properties: { part } });
      lastOffset = Math.max(lastOffset, completedAt);
      continue;
    }
    if (part.type === 'tool' && part.state && typeof part.state === 'object') {
      const input = part.state.input ?? {};
      add(baseOffset, {
        type: 'message.part.updated',
        properties: {
          part: { ...part, state: { status: 'pending', input, raw: '' } },
        },
      });
      const start = Number(part.state.time?.start) || Number(row.time_created);
      add(baseOffset + 16, {
        type: 'message.part.updated',
        properties: {
          part: {
            ...part,
            state: {
              status: 'running',
              input,
              title: part.state.title,
              metadata: part.state.metadata,
              time: { start },
            },
          },
        },
      });
      const persistedDuration = Math.max(32, Number(row.time_updated) - Number(row.time_created));
      const rawStateDuration = Number(part.state.time?.end) - start;
      const stateDuration = Number.isFinite(rawStateDuration) ? Math.max(0, rawStateDuration) : 0;
      const completedAt = baseOffset + Math.max(persistedDuration, stateDuration);
      add(completedAt, { type: 'message.part.updated', properties: { part } });
      lastOffset = Math.max(lastOffset, completedAt);
      continue;
    }
    add(baseOffset, { type: 'message.part.updated', properties: { part } });
    lastOffset = Math.max(lastOffset, baseOffset);
  }
  add(lastOffset + 32, {
    type: 'message.updated',
    properties: { info: assistantMessage.info },
  });
  add(lastOffset + 48, {
    type: 'session.status',
    properties: { sessionID: sessionId, status: { type: 'idle' } },
  });
  return events
    .toSorted((left, right) => left.offsetMs - right.offsetMs || left.order - right.order)
    .map(({ offsetMs, event }) => ({ offsetMs, event }));
}

export function importHistoricalPlayback({ sourceDatabase, playbackDatabase, sessionId, messageId, label }) {
  const source = new DatabaseSync(sourceDatabase, { readOnly: true });
  try {
    const sessionRow = source.prepare('SELECT * FROM session WHERE id = ?').get(sessionId);
    if (!sessionRow) throw new Error(`Historical session ${sessionId} was not found`);
    const assistantRow = source
      .prepare('SELECT * FROM message WHERE id = ? AND session_id = ?')
      .get(messageId, sessionId);
    if (!assistantRow) throw new Error(`Historical message ${messageId} was not found in ${sessionId}`);
    const assistantData = parseJson(assistantRow.data, `message ${messageId}`);
    if (assistantData.role !== 'assistant' || typeof assistantData.parentID !== 'string') {
      throw new Error(`Historical message ${messageId} is not a linked assistant response`);
    }
    const userRow = source
      .prepare('SELECT * FROM message WHERE id = ? AND session_id = ?')
      .get(assistantData.parentID, sessionId);
    if (!userRow) throw new Error(`Parent message ${assistantData.parentID} was not found`);
    const baselineRows = source
      .prepare(
        `SELECT * FROM message WHERE session_id = ? AND time_created < ?
         ORDER BY time_created DESC, id DESC LIMIT ?`
      )
      .all(sessionId, userRow.time_created, HISTORY_BASELINE_MESSAGES)
      .toReversed();
    const selectedRows = [...baselineRows, userRow, assistantRow];
    const messages = selectedRows.map(projectHistoricalMessage);
    const messagesById = new Map(messages.map((message) => [message.info.id, message]));
    const placeholders = selectedRows.map(() => '?').join(',');
    const partRows = source
      .prepare(
        `SELECT * FROM part WHERE message_id IN (${placeholders}) ORDER BY time_created, id`
      )
      .all(...selectedRows.map((row) => row.id));
    for (const row of partRows) messagesById.get(row.message_id)?.parts.push(projectHistoricalPart(row));
    const userMessage = messagesById.get(userRow.id);
    const assistantMessage = messagesById.get(assistantRow.id);
    const assistantPartRows = partRows.filter((row) => row.message_id === assistantRow.id);
    const session = {
      id: sessionRow.id,
      slug: sessionRow.slug,
      projectID: sessionRow.project_id,
      directory: sessionRow.directory,
      title: sessionRow.title,
      version: sessionRow.version,
      time: { created: sessionRow.time_created, updated: sessionRow.time_updated },
    };
    const initialMessages = messages.slice(0, -2);
    const model =
      typeof assistantData.providerID === 'string' && typeof assistantData.modelID === 'string'
        ? `${assistantData.providerID}/${assistantData.modelID}`
        : null;
    return savePlaybackCapture(playbackDatabase, {
      label,
      scenario: 'HISTORY',
      capturedAt: new Date().toISOString(),
      model,
      session,
      initialMessages,
      finalMessages: messages,
      events: reconstructHistoricalEvents(
        sessionId,
        userMessage,
        assistantMessage,
        assistantPartRows
      ),
    });
  } finally {
    source.close();
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (!name?.startsWith('--')) throw new Error(`Unexpected argument: ${String(name)}`);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    options[name.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

function listCaptures(filePath) {
  const database = openDatabase(filePath);
  try {
    return database
      .prepare(
        `SELECT id, label, scenario, captured_at AS capturedAt,
          source_session_id AS sourceSessionId, model,
          json_array_length(events_json) AS eventCount
        FROM playback ORDER BY id DESC`
      )
      .all();
  } finally {
    database.close();
  }
}

async function replay(filePath, id, options) {
  const capture = readPlaybackCapture(filePath, id);
  const replayDirectory = await mkdtemp(path.join(os.tmpdir(), 'varro-playback-run-'));
  const replayFile = path.join(replayDirectory, 'capture.json');
  const timeline = buildReplayTimeline(capture.events, {
    shortGapMs: Number(options['short-gap-ms'] ?? DEFAULT_SHORT_GAP_MS),
    maxGapMs: Number(options['max-gap-ms'] ?? DEFAULT_MAX_GAP_MS),
  });
  await writeFile(replayFile, `${JSON.stringify({ capture, timeline })}\n`);
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = npmCli
    ? [npmCli, 'run', 'test:e2e', '--', '--config', 'playwright.ai-playback.config.ts']
    : ['run', 'test:e2e', '--', '--config', 'playwright.ai-playback.config.ts'];
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      VARRO_PLAYBACK_ID: String(id),
      VARRO_PLAYBACK_FILE: replayFile,
    },
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      if (signal) reject(new Error(`Playback test exited from signal ${signal}`));
      else resolve(exitCode ?? 1);
    });
  }).finally(() => rm(replayDirectory, { recursive: true, force: true }));
  if (code !== 0) process.exitCode = code;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(options.db ?? DEFAULT_DATABASE);
  if (command === 'list') {
    process.stdout.write(`${JSON.stringify(listCaptures(filePath), null, 2)}\n`);
    return;
  }
  if (command === 'replay') {
    const id = Number(options.id);
    if (!Number.isInteger(id) || id < 1) throw new Error('--id must be a positive integer');
    await replay(filePath, id, options);
    return;
  }
  if (command === 'import-history') {
    const sessionId = options.session?.trim();
    const messageId = options.message?.trim();
    const label = options.label?.trim();
    if (!sessionId || !messageId || !label) {
      throw new Error('import-history requires --session, --message, and --label');
    }
    const result = importHistoricalPlayback({
      sourceDatabase: path.resolve(options.source ?? DEFAULT_HISTORY_DATABASE),
      playbackDatabase: filePath,
      sessionId,
      messageId,
      label,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error(
    'Usage: ai-session-playback.mjs list|replay --id <capture-id>|import-history --session <id> --message <id> --label <label> [--db <path>]'
  );
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
