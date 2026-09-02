/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Worker messages are untrusted and normalized before use. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { resolveOpenCodeDataDirectory } from '../shared/opencode-data-directory';
import type { ContextCharacterCounts } from '../shared/context-breakdown';
import { asRecord } from '../shared/type-utils';

const LOCAL_SESSION_SUMMARY_TIMEOUT_MS = 2_000;
const LOCAL_SESSION_SUMMARY_MAX_SESSIONS = 10_000;
const LOCAL_SESSION_SUMMARY_MAX_MESSAGES = 100_000;
const LOCAL_SESSION_SUMMARY_MAX_PARTS = 250_000;
const LOCAL_SESSION_SUMMARY_MAX_ROW_BYTES = 64 * 1024 * 1024;
const LOCAL_SESSION_SUMMARY_MAX_DATA_BYTES = 128 * 1024 * 1024;

export type LocalSessionSummaryData = {
  messages: unknown[];
  contextCharacters?: ContextCharacterCounts;
  contextInputTokens?: number;
  descendants: Array<{
    id: string;
    tokens: unknown;
    messages: unknown[];
    contextCharacters?: ContextCharacterCounts;
    contextInputTokens?: number;
  }>;
};

export async function readLocalSessionSummary(
  sessionID: string,
  databasePath = join(resolveOpenCodeDataDirectory(), 'opencode.db')
): Promise<LocalSessionSummaryData | null> {
  if (!existsSync(databasePath)) return null;

  return new Promise((resolve) => {
    const worker = new Worker(LOCAL_SESSION_SUMMARY_WORKER, {
      eval: true,
      workerData: {
        databasePath,
        sessionID,
        maxSessions: LOCAL_SESSION_SUMMARY_MAX_SESSIONS,
        maxMessages: LOCAL_SESSION_SUMMARY_MAX_MESSAGES,
        maxParts: LOCAL_SESSION_SUMMARY_MAX_PARTS,
        maxRowBytes: LOCAL_SESSION_SUMMARY_MAX_ROW_BYTES,
        maxDataBytes: LOCAL_SESSION_SUMMARY_MAX_DATA_BYTES,
      },
    });
    let settled = false;
    const finish = (result: LocalSessionSummaryData | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker
        .terminate()
        .catch(() => 0)
        .then(() => resolve(result));
    };
    const timeout = setTimeout(() => finish(null), LOCAL_SESSION_SUMMARY_TIMEOUT_MS);

    worker.once('message', (value: unknown) => finish(normalizeLocalSessionSummary(value)));
    worker.once('error', () => finish(null));
    worker.once('exit', (code) => {
      if (code !== 0) finish(null);
    });
  });
}

function normalizeLocalSessionSummary(value: unknown): LocalSessionSummaryData | null {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.messages) || !Array.isArray(record.descendants)) return null;

  const descendants: LocalSessionSummaryData['descendants'] = [];
  for (const candidate of record.descendants) {
    const descendant = asRecord(candidate);
    if (!descendant || typeof descendant.id !== 'string' || !Array.isArray(descendant.messages)) {
      return null;
    }
    const normalized: LocalSessionSummaryData['descendants'][number] = {
      id: descendant.id,
      tokens: descendant.tokens,
      messages: descendant.messages,
    };
    const characters = normalizeContextCharacterCounts(descendant.contextCharacters);
    const inputTokens = normalizeNonnegativeNumber(descendant.contextInputTokens);
    if (characters) normalized.contextCharacters = characters;
    if (inputTokens !== undefined) normalized.contextInputTokens = inputTokens;
    descendants.push(normalized);
  }
  const result: LocalSessionSummaryData = {
    messages: record.messages,
    descendants,
  };
  const characters = normalizeContextCharacterCounts(record.contextCharacters);
  const inputTokens = normalizeNonnegativeNumber(record.contextInputTokens);
  if (characters) result.contextCharacters = characters;
  if (inputTokens !== undefined) result.contextInputTokens = inputTokens;
  return result;
}

function normalizeNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeContextCharacterCounts(value: unknown): ContextCharacterCounts | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const system = normalizeNonnegativeNumber(record.system);
  const user = normalizeNonnegativeNumber(record.user);
  const assistant = normalizeNonnegativeNumber(record.assistant);
  const tool = normalizeNonnegativeNumber(record.tool);
  if (system === undefined || user === undefined || assistant === undefined || tool === undefined) {
    return undefined;
  }
  return { system, user, assistant, tool };
}

const LOCAL_SESSION_SUMMARY_WORKER = String.raw`
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');

const requiredColumns = {
  session: [
    'id',
    'parent_id',
    'tokens_input',
    'tokens_output',
    'tokens_reasoning',
    'tokens_cache_read',
    'tokens_cache_write',
  ],
  message: ['id', 'session_id', 'time_created', 'data'],
  part: ['id', 'message_id', 'session_id', 'data'],
};
const tree = [
  'WITH RECURSIVE tree(id) AS (',
  'SELECT id FROM session WHERE id = ?',
  'UNION SELECT session.id FROM session JOIN tree ON session.parent_id = tree.id',
  ')',
].join(' ');

const hasSchema = (database) =>
  Object.entries(requiredColumns).every(([table, required]) => {
    const columns = new Set(database.prepare('PRAGMA table_info(' + table + ')').all().map((row) => row.name));
    return required.every((column) => columns.has(column));
  });

const parseData = (row) => {
  if (typeof row.data !== 'string' || Buffer.byteLength(row.data) > workerData.maxRowBytes) {
    throw new Error('Local session row exceeds the size limit');
  }
  const data = JSON.parse(row.data);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Local session row contains invalid JSON');
  }
  return data;
};

const contextCharacters = () => ({ system: 0, user: 0, assistant: 0, tool: 0 });
const projectDiff = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return {
    file: value.file,
    additions: value.additions,
    deletions: value.deletions,
    added: value.added,
    removed: value.removed,
    status: value.status,
  };
};
const projectInfo = (value) => {
  const result = {};
  for (const key of ['role', 'parentID', 'mode', 'providerID', 'modelID', 'variant', 'time', 'tokens']) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  if (value.summary && typeof value.summary === 'object') {
    result.summary = {};
    if (value.summary.diffs !== undefined) {
      result.summary.diffs = Array.isArray(value.summary.diffs)
        ? value.summary.diffs.map(projectDiff)
        : value.summary.diffs;
    }
    if (value.summary.diffsOmitted !== undefined) result.summary.diffsOmitted = value.summary.diffsOmitted;
    if (value.summary.diffsTruncated !== undefined) result.summary.diffsTruncated = value.summary.diffsTruncated;
  }
  return result;
};
const FILE_KEYS = ['relativePath', 'file', 'path', 'filePath', 'filepath', 'filename'];
const projectFile = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = {};
  for (const key of [...FILE_KEYS, 'additions', 'deletions', 'linesAdded', 'linesRemoved']) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
};
const projectFileSource = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const key of [...FILE_KEYS, 'additions', 'deletions', 'linesAdded', 'linesRemoved']) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  if (Array.isArray(value.files)) result.files = value.files.map(projectFile);
  return result;
};
const projectPart = (value) => {
  if (value.type === 'patch') return { type: 'patch', files: value.files };
  if (value.type !== 'tool') return null;
  return {
    type: 'tool',
    tool: value.tool,
    state: {
      input: projectFileSource(value.state?.input),
      metadata: projectFileSource(value.state?.metadata),
    },
  };
};
const addPartContext = (target, role, value) => {
  if (role === 'user') {
    if (value.type === 'text') target.user += typeof value.text === 'string' ? value.text.length : 0;
    if (value.type === 'file') target.user += value.source?.text?.value?.length || 0;
    if (value.type === 'agent') target.user += value.source?.value?.length || 0;
    return;
  }
  if (role !== 'assistant') return;
  if (value.type === 'text' || value.type === 'reasoning') {
    target.assistant += typeof value.text === 'string' ? value.text.length : 0;
    return;
  }
  if (value.type !== 'tool' || !value.state || typeof value.state !== 'object') return;
  const input = value.state.input && typeof value.state.input === 'object' && !Array.isArray(value.state.input)
    ? Object.keys(value.state.input).length * 16
    : 0;
  if (value.state.status === 'pending') target.tool += input + (value.state.raw?.length || 0);
  else if (value.state.status === 'completed') target.tool += input + (value.state.output?.length || 0);
  else if (value.state.status === 'error') target.tool += input + (value.state.error?.length || 0);
  else target.tool += input;
};

try {
  const database = new DatabaseSync(workerData.databasePath, { readOnly: true });
  try {
    if (!hasSchema(database)) {
      parentPort.postMessage(null);
    } else {
      const sessions = database.prepare(
        tree +
          ' SELECT session.id, session.parent_id,' +
          ' session.tokens_input, session.tokens_output, session.tokens_reasoning,' +
          ' session.tokens_cache_read, session.tokens_cache_write' +
          ' FROM session JOIN tree ON session.id = tree.id LIMIT ?'
      ).all(workerData.sessionID, workerData.maxSessions + 1);
      if (sessions.length === 0 || sessions.length > workerData.maxSessions) {
        parentPort.postMessage(null);
      } else {
        // CTE joins make SQLite scan the machine-wide message and part tables despite their session indexes.
        const sessionIDs = sessions.map((session) => session.id);
        const placeholders = sessionIDs.map(() => '?').join(',');
        const messageRows = database.prepare(
          'SELECT message.id, message.session_id, message.time_created, message.data' +
            ' FROM message WHERE message.session_id IN (' + placeholders + ')' +
            ' ORDER BY message.time_created, message.id LIMIT ?'
        ).iterate(...sessionIDs, workerData.maxMessages + 1);
        const messageRoles = new Map();
        const messagesByID = new Map();
        const contextBySession = new Map(sessions.map((session) => [session.id, contextCharacters()]));
        const contextInputBySession = new Map();
        const messagesBySession = new Map();
        let dataBytes = 0;
        let messageCount = 0;
        for (const row of messageRows) {
          messageCount += 1;
          if (messageCount > workerData.maxMessages) throw new Error('Local session exceeds the message limit');
          dataBytes += typeof row.data === 'string' ? Buffer.byteLength(row.data) : 0;
          if (dataBytes > workerData.maxDataBytes) throw new Error('Local session exceeds the data limit');
          const data = parseData(row);
          messageRoles.set(row.id, data.role);
          if (data.role === 'assistant' && Number.isFinite(data.tokens?.input) && data.tokens.input > 0) {
            contextInputBySession.set(row.session_id, data.tokens.input);
          }
          const context = contextBySession.get(row.session_id);
          if (context && data.role === 'user' && typeof data.system === 'string' && data.system.trim()) {
            context.system = data.system.trim().length;
          }
          const message = {
            info: { ...projectInfo(data), id: row.id, sessionID: row.session_id },
            parts: [],
          };
          messagesByID.set(row.id, message);
          const list = messagesBySession.get(row.session_id);
          if (list) list.push(message);
          else messagesBySession.set(row.session_id, [message]);
        }
        const partRows = database.prepare(
          'SELECT part.id, part.message_id, part.session_id, part.data' +
            ' FROM part WHERE part.session_id IN (' + placeholders + ')' +
            ' ORDER BY part.message_id, part.id LIMIT ?'
        ).iterate(...sessionIDs, workerData.maxParts + 1);
        let partCount = 0;
        for (const row of partRows) {
          partCount += 1;
          if (partCount > workerData.maxParts) throw new Error('Local session exceeds the part limit');
          dataBytes += typeof row.data === 'string' ? Buffer.byteLength(row.data) : 0;
          if (dataBytes > workerData.maxDataBytes) throw new Error('Local session exceeds the data limit');
          const data = parseData(row);
          addPartContext(contextBySession.get(row.session_id), messageRoles.get(row.message_id), data);
          const projected = projectPart(data);
          const message = messagesByID.get(row.message_id);
          if (!projected || !message || row.session_id !== workerData.sessionID) continue;
          message.parts.push({
            ...projected,
            id: row.id,
            messageID: row.message_id,
            sessionID: row.session_id,
          });
        }
        const descendants = sessions
          .filter((session) => session.id !== workerData.sessionID)
          .map((session) => {
            const tokens = {
              input: session.tokens_input,
              output: session.tokens_output,
              reasoning: session.tokens_reasoning,
              cache: { read: session.tokens_cache_read, write: session.tokens_cache_write },
            };
            const hasTokenSnapshot =
              tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write > 0;
            return {
              id: session.id,
              tokens,
              messages: hasTokenSnapshot ? [] : (messagesBySession.get(session.id) || []),
              contextCharacters: contextBySession.get(session.id),
              contextInputTokens: contextInputBySession.get(session.id),
            };
          });
        parentPort.postMessage({
          messages: messagesBySession.get(workerData.sessionID) || [],
          contextCharacters: contextBySession.get(workerData.sessionID),
          contextInputTokens: contextInputBySession.get(workerData.sessionID),
          descendants,
        });
      }
    }
  } finally {
    database.close();
  }
} catch {
  parentPort.postMessage(null);
}
`;
