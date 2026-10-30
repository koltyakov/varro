/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Decode worker replies before accepting a local transcript snapshot. */
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { asRecord } from '../shared/type-utils';
import type { TranscriptArchiveSession } from './session-transcript-archive';
import { usageDatabasePaths } from './usage-database-paths';

/** Projects ordinary V2 history without hydrating media or transferring tool bodies. */
export class LocalSessionTranscriptReader {
  async read(
    sessions: TranscriptArchiveSession[],
    onProgress?: (message: string) => void,
    signal?: AbortSignal
  ): Promise<Map<string, unknown[]>> {
    signal?.throwIfAborted();
    const path = usageDatabasePaths().databasePath;
    if (!sessions.length || !existsSync(path)) return new Map();
    return new Promise((resolve, reject) => {
      const worker = new Worker(LOCAL_TRANSCRIPT_WORKER, {
        eval: true,
        workerData: {
          path,
          sessions,
          maxMessages: 100_000,
          maxParts: 500_000,
          maxBytes: 64 * 1024 * 1024,
        },
      });
      let settled = false;
      const cancel = () => finish(new Error('Transcript reading cancelled.'));
      const finish = (error?: Error, histories = new Map<string, unknown[]>()) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
        void worker
          .terminate()
          .catch(() => 0)
          .then(() => (error ? reject(error) : resolve(histories)));
      };
      const timeout = setTimeout(
        () => finish(new Error('Local transcript read timed out after 60 seconds.')),
        60_000
      );
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      worker.on('message', (value: unknown) => {
        if (settled) return;
        const result = asRecord(value);
        if (typeof result?.progress === 'string') {
          onProgress?.(result.progress);
          return;
        }
        if (typeof result?.error === 'string') {
          finish(new Error(`Local transcript read failed: ${result.error}`));
          return;
        }
        if (!Array.isArray(result?.histories)) {
          finish(new Error('Malformed local transcript reply.'));
          return;
        }
        const histories = new Map<string, unknown[]>();
        for (const entry of result.histories) {
          const history = asRecord(entry);
          if (
            typeof history?.id !== 'string' ||
            !sessions.some((session) => session.id === history.id) ||
            histories.has(history.id) ||
            !Array.isArray(history.messages)
          ) {
            finish(new Error('Malformed local transcript history.'));
            return;
          }
          histories.set(history.id, history.messages);
        }
        finish(undefined, histories);
      });
      worker.once('error', (error) =>
        finish(new Error('Local transcript worker failed.', { cause: error }))
      );
      worker.once('exit', (code) =>
        finish(new Error(`Local transcript worker exited without a snapshot, code ${code}.`))
      );
    });
  }
}

const LOCAL_TRANSCRIPT_WORKER = String.raw`
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');
class ApiRequired extends Error {}
let database;
let result;
let totalBytes = 0;
const progress = (message) => parentPort.postMessage({ progress: message });
const columns = (table) => new Set(database.prepare('PRAGMA table_info(' + table + ')').all().map((row) => row.name));
const has = (table, names) => { const found = columns(table); return names.every((name) => found.has(name)); };
const knownTypes = new Set(['user', 'assistant', 'idle', 'synthetic', 'system', 'skill', 'shell', 'compaction', 'agent-switched', 'model-switched', 'location-switched']);
const checkPart = (type, text, valid) => {
  if (!valid || !['text', 'reasoning', 'tool'].includes(type)) throw new Error('Malformed or unsupported transcript part.');
  if (type === 'text' && typeof text !== 'string') throw new Error('Malformed transcript text part.');
};
const read = (session) => {
  const header = database.prepare('SELECT time_updated, fork_session_id, revert FROM session_v2 WHERE id = ?').get(session.id);
  if (!header || header.time_updated !== session.updated) throw new Error('Session changed or is missing from the local transcript database: ' + session.id);
  if (header.fork_session_id || (header.revert && header.revert !== 'null')) throw new ApiRequired();
  const parts = new Map();
  let partBytes = 0;
  const partColumns = columns('session_part');
  if (partColumns.size) {
    if (!has('session_part', ['message_id', 'session_id', 'ordinal', 'type', 'data'])) throw new ApiRequired();
    const rows = database.prepare("SELECT p.message_id, p.session_id, p.type, p.ordinal, json_valid(p.data) AND json_type(p.data) = 'object' AS valid, json_extract(p.data, '$.type') AS stored_type, CASE WHEN p.type = 'text' THEN json_extract(p.data, '$.text') END AS text FROM session_message m CROSS JOIN session_part p ON p.message_id = m.id WHERE m.session_id = ? AND m.type = 'assistant' ORDER BY m.id,p.ordinal LIMIT ?").iterate(session.id, workerData.maxParts + 1);
    let count = 0;
    const ordinals = new Map();
    for (const part of rows) {
      if (++count > workerData.maxParts) throw new Error('Transcript exceeds the stored-part limit.');
      if (part.session_id !== session.id) throw new Error('Transcript part has a different session owner.');
      checkPart(part.type, part.text, part.valid);
      if (part.stored_type !== part.type) throw new ApiRequired();
      if (!Number.isSafeInteger(part.ordinal) || part.ordinal < 0) throw new Error('Malformed transcript part ordinal.');
      if (ordinals.has(part.message_id) && part.ordinal <= ordinals.get(part.message_id)) throw new Error('Repeated transcript part ordinal.');
      ordinals.set(part.message_id, part.ordinal);
      if (!parts.has(part.message_id)) parts.set(part.message_id, []);
      if (part.type === 'text') {
        partBytes += Buffer.byteLength(part.text);
        if (partBytes > workerData.maxBytes) throw new Error('Projected transcript exceeds 64 MB.');
        parts.get(part.message_id).push({ type: 'text', text: part.text });
      }
      if (count % 1000 === 0) progress('Reading local transcript ' + session.id + ': ' + count.toLocaleString() + ' stored parts');
    }
  }
  const embeddedParts = database.prepare("SELECT json_extract(c.value, '$.type') AS type, CASE WHEN json_extract(c.value, '$.type') = 'text' THEN json_extract(c.value, '$.text') END AS text, json_type(c.value) = 'object' AS valid FROM session_message m CROSS JOIN json_each(m.data, '$.content') c WHERE m.id = ? AND m.session_id = ? ORDER BY c.key");
  const fileMetadata = database.prepare("SELECT f.key, json_type(f.value) = 'object' AS valid, json_extract(f.value, '$.mime') AS mime, coalesce(json_extract(f.value, '$.name'),json_extract(f.value, '$.filename')) AS name FROM session_message m CROSS JOIN json_each(m.data, '$.files') f WHERE m.id = ? AND m.session_id = ? ORDER BY f.key");
  const fileData = database.prepare('SELECT json_extract(data, ?, ?, ?) AS data FROM session_message WHERE id = ? AND session_id = ?');
  const messages = [];
  let previousSeq = -1;
  const rows = database.prepare("SELECT id,type,seq,json_valid(data) AND json_type(data) = 'object' AS valid, CASE WHEN type IN ('user','assistant') THEN json_extract(data, '$.time', '$.model', '$.finish', '$.text', '$.providerID', '$.modelID') WHEN type = 'idle' THEN json_extract(data, '$.outcome') END AS fields, CASE WHEN type = 'assistant' THEN json_type(data, '$.content') END AS content_type, CASE WHEN type = 'user' THEN json_type(data, '$.files') END AS files_type FROM session_message WHERE session_id = ? ORDER BY seq LIMIT ?").iterate(session.id, workerData.maxMessages + 1);
  for (const row of rows) {
    if (messages.length >= workerData.maxMessages) throw new Error('Transcript exceeds the message limit.');
    if (!row.valid || !knownTypes.has(row.type)) throw new Error('Malformed or unsupported transcript message.');
    if (!Number.isSafeInteger(row.seq) || row.seq <= previousSeq) throw new Error('Malformed or repeated transcript message sequence.');
    previousSeq = row.seq;
    let message = { id: row.id, type: row.type };
    if (row.type === 'idle') message.outcome = row.fields;
    if (row.type === 'user' || row.type === 'assistant') {
      const fields = JSON.parse(row.fields);
      message.time = fields[0];
      if (row.type === 'assistant') {
        if (row.content_type !== 'array') throw new ApiRequired();
        message.model = fields[1];
        message.providerID = fields[4];
        message.modelID = fields[5];
        message.finish = fields[2];
        message.content = parts.get(row.id);
        if (!message.content) {
          message.content = [];
          for (const part of embeddedParts.iterate(row.id, session.id)) {
            checkPart(part.type, part.text, part.valid);
            if (part.type === 'text') message.content.push({ type: 'text', text: part.text });
          }
        }
      } else {
        message.text = fields[3];
        if (row.files_type !== null && row.files_type !== 'array') throw new Error('Malformed transcript files.');
        message.files = [];
        for (const file of fileMetadata.iterate(row.id, session.id)) {
          if (!file.valid || typeof file.mime !== 'string') throw new Error('Malformed transcript file.');
          const attachment = { mime: file.mime, name: file.name ?? undefined };
          if (file.mime === 'text/plain' && typeof file.name === 'string' && /^(?:pasted-text|annotation)-[a-f0-9]{8}\.txt$/.test(file.name)) {
            const prefix = '$.files[' + file.key + ']';
            const values = JSON.parse(fileData.get(prefix + '.data', prefix + '.uri', prefix + '.url', row.id, session.id).data);
            if (typeof values[0] === 'string') attachment.data = values[0];
            else if (typeof values[1] === 'string' && /^media:[a-f0-9]{64}$/.test(values[1])) {
              if (!has('blob', ['hash', 'data'])) throw new ApiRequired();
              const blob = database.prepare('SELECT data FROM blob WHERE hash = ? AND length(data) <= 65536').get(values[1].slice(6));
              if (!blob || !(blob.data instanceof Uint8Array)) throw new Error('Pasted-text or annotation blob is missing or exceeds 64 KB.');
              attachment.data = Buffer.from(blob.data).toString('base64');
            } else if (typeof values[2] === 'string') attachment.url = values[2];
            else throw new Error('Pasted-text or annotation content is unavailable.');
          }
          message.files.push(attachment);
        }
      }
    }
    totalBytes += Buffer.byteLength(JSON.stringify(message));
    if (totalBytes > workerData.maxBytes) throw new Error('Projected transcript exceeds 64 MB.');
    messages.push(message);
    if (messages.length % 1000 === 0) progress('Reading local transcript ' + session.id + ': ' + messages.length.toLocaleString() + ' messages');
  }
  progress('Read local transcript ' + session.id + ': ' + messages.length.toLocaleString() + ' messages');
  return messages;
};
try {
  database = new DatabaseSync(workerData.path, { readOnly: true });
  database.exec('PRAGMA busy_timeout = 1000; BEGIN;');
  const histories = [];
  if (has('session_v2', ['id','time_updated','fork_session_id','revert']) && has('session_message', ['id','session_id','type','seq','data'])) {
    for (const session of workerData.sessions) {
      progress('Reading local transcript ' + session.id);
      const beforeBytes = totalBytes;
      try { histories.push({ id: session.id, messages: read(session) }); }
      catch (error) { if (!(error instanceof ApiRequired)) throw error; totalBytes = beforeBytes; }
    }
  }
  result = { histories };
} catch (error) {
  result = { error: error instanceof Error ? error.message : String(error) };
} finally { database?.close(); }
parentPort.postMessage(result);
`;
