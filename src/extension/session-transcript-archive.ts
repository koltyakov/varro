/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Validate native and legacy history before permitting destructive cleanup. */
import { dirname, join, parse } from 'node:path';
import { Worker } from 'node:worker_threads';
import { asRecord, type UnknownRecord } from '../shared/type-utils';
import { readPastedTextDataUrl } from '../shared/pasted-text';
import type { OpenCodeServer } from './server';
import { LocalSessionTranscriptReader } from './local-session-transcript';
import { usageDatabasePaths } from './usage-database-paths';
import type { UsageArchiveSession } from './usage-report-service';

export type TranscriptArchiveSession = UsageArchiveSession & {
  parentID?: string;
  title?: string;
  created?: number;
  identity?: string;
};

type TranscriptAttachment = { name: string; mime: string; text?: string; omitted: boolean };
type TranscriptText = {
  id: string;
  created: number;
  text: string;
  completed?: number;
  finish?: string;
  model?: { providerID: string; id: string; variant?: string };
  attachments?: TranscriptAttachment[];
};
type Outcome = 'succeeded' | 'failed' | 'interrupted' | 'unknown';
type TranscriptTurn = {
  prompts: TranscriptText[];
  response?: TranscriptText;
  outcome: Outcome;
  boundary: 'idle' | 'inferred';
};
type TranscriptRecord =
  | { type: 'user'; entry: TranscriptText }
  | { type: 'assistant'; entry: TranscriptText }
  | { type: 'idle'; outcome: Exclude<Outcome, 'unknown'> }
  | { type: 'synthetic' };
type TranscriptSnapshot = { session: TranscriptArchiveSession; turns: TranscriptTurn[] };
type TranscriptArchiveOptions = {
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
};
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGES = 100_000;
const WRITE_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 60_000;

export function sessionTranscriptArchivePath(): string {
  const { databasePath } = usageDatabasePaths();
  return join(dirname(databasePath), `${parse(databasePath).name}-transcripts.db`);
}

/** Stores reading copies, never importable execution state or live OpenCode rows. */
export class SessionTranscriptArchive {
  constructor(private readonly server: Pick<OpenCodeServer, 'request' | 'apiVersion'>) {}

  async archive(
    sessions: TranscriptArchiveSession[],
    options: TranscriptArchiveOptions = {}
  ): Promise<void> {
    options.signal?.throwIfAborted();
    // Child sessions are tool/subagent work, not parent conversation transcripts.
    // Cleanup still archives their complete usage before the recursive deletion.
    const roots = sessions.filter((session) => !session.parentID);
    if (!roots.length) return;
    const snapshots: TranscriptSnapshot[] = [];
    let bytes = 0;
    const deadline = new AbortController();
    const timeout = setTimeout(
      () => deadline.abort(new Error('Transcript history read timed out after 60 seconds.')),
      READ_TIMEOUT_MS
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal;
    try {
      const histories =
        this.server.apiVersion === 2 || roots.some((session) => session.version === 1)
          ? await new LocalSessionTranscriptReader().read(roots, options.onProgress, signal)
          : new Map<string, unknown[]>();
      for (const session of roots) {
        signal.throwIfAborted();
        const records = await this.readHistory(
          session,
          signal,
          options.onProgress,
          histories.get(session.id)
        );
        const snapshot = { session, turns: trimTranscript(records) };
        bytes += Buffer.byteLength(JSON.stringify(snapshot));
        if (bytes > MAX_TRANSCRIPT_BYTES) {
          throw new Error(
            'Transcript tree exceeds the 64 MB archive limit. No sessions were deleted.'
          );
        }
        snapshots.push(snapshot);
      }
      signal.throwIfAborted();
    } catch (error) {
      if (deadline.signal.aborted) throw deadline.signal.reason;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    options.signal?.throwIfAborted();
    options.onProgress?.(`Writing trimmed transcripts for ${snapshots.length} sessions`);
    await this.persist(snapshots, options);
  }

  private async readHistory(
    session: TranscriptArchiveSession,
    signal: AbortSignal,
    onProgress?: (message: string) => void,
    localHistory?: unknown[]
  ): Promise<TranscriptRecord[]> {
    const records: TranscriptRecord[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    const v2 = session.version !== 1 && this.server.apiVersion === 2;
    const append = (data: unknown[]) => {
      for (const value of data) {
        signal.throwIfAborted();
        const message = asRecord(value);
        const info = v2 ? message : asRecord(message?.info);
        const id = info?.id;
        if (!message || !info || typeof id !== 'string' || !id || ids.has(id)) {
          throw new Error(`Missing or repeated transcript message identity for ${session.id}.`);
        }
        ids.add(id);
        if (ids.size > MAX_MESSAGES)
          throw new Error(`Transcript exceeds ${MAX_MESSAGES} messages for ${session.id}.`);
        const record = v2 ? readNativeMessage(info) : readLegacyMessage(message);
        if (record) records.push(record);
      }
    };
    if (localHistory !== undefined) {
      append(localHistory);
      return records;
    }
    if (session.version === 1)
      throw new Error('Legacy cleanup requires a verified local transcript snapshot.');
    onProgress?.(`Reading API transcript ${session.id}`);
    let pages = 0;
    do {
      signal.throwIfAborted();
      const query = new URLSearchParams();
      if (v2) {
        query.set('limit', '200');
        if (cursor) query.set('cursor', cursor);
        else query.set('order', 'desc');
      } else query.set('directory', session.directory);
      // Native v2 history preserves successful idle boundaries, hydrates separately
      // stored parts and resolves inherited fork history without opening a location.
      // V1 without a limit returns the complete transcript rather than a partial page.
      const path = `/${v2 ? 'api/' : ''}session/${encodeURIComponent(session.id)}/message?${query}`;
      const response = await this.server.request('GET', path, undefined, {
        unscoped: true,
        maxResponseBytes: MAX_HISTORY_BYTES,
        signal,
      });
      signal.throwIfAborted();
      const page = asRecord(response);
      const data: unknown = v2 ? page?.data : response;
      if (!Array.isArray(data)) throw new Error(`Malformed transcript history for ${session.id}.`);
      bytes += Buffer.byteLength(JSON.stringify(data));
      if (bytes > MAX_HISTORY_BYTES)
        throw new Error(`Transcript history exceeds 64 MB for ${session.id}.`);
      append(data);
      pages += 1;
      onProgress?.(
        `Reading API transcript ${session.id}: ${ids.size.toLocaleString()} messages, ${pages} pages, ${(bytes / 1024 / 1024).toFixed(1)} MB`
      );
      const pagination = asRecord(page?.cursor);
      const next = pagination?.next;
      // OpenCode emits a next cursor for every nonempty page, then terminates
      // with { data: [], cursor: { previous: null, next: null } } on the wire.
      if (
        v2 &&
        (!pagination ||
          (next !== undefined && next !== null && (typeof next !== 'string' || !next)))
      ) {
        throw new Error(`Malformed transcript pagination for ${session.id}.`);
      }
      cursor = v2 && typeof next === 'string' ? next : undefined;
      if (cursor && (!data.length || cursors.has(cursor))) {
        throw new Error(`OpenCode repeated a transcript pagination cursor for ${session.id}.`);
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return this.server.apiVersion === 2 ? records.toReversed() : records;
  }

  private async persist(
    snapshots: TranscriptSnapshot[],
    options: TranscriptArchiveOptions
  ): Promise<void> {
    options.signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(TRANSCRIPT_WORKER, {
        eval: true,
        workerData: {
          path: sessionTranscriptArchivePath(),
          snapshots,
          version: this.server.apiVersion,
          archivedAt: Date.now(),
        },
      });
      let settled = false;
      const cancel = () => finish(new Error('Transcript archiving cancelled.'));
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', cancel);
        // Wait for teardown so a timed-out writer cannot overlap a retry.
        void worker
          .terminate()
          .catch(() => 0)
          .then(() => (error ? reject(error) : resolve()));
      };
      const timeout = setTimeout(
        () => finish(new Error('Transcript archive write timed out.')),
        WRITE_TIMEOUT_MS
      );
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      worker.on('message', (value: unknown) => {
        if (settled) return;
        const result = asRecord(value);
        if (typeof result?.progress === 'string') {
          options.onProgress?.(result.progress);
          return;
        }
        if (result?.saved === snapshots.length) finish();
        else
          finish(
            new Error(
              `Transcript archive failed: ${typeof result?.error === 'string' ? result.error : 'Invalid writer acknowledgement.'}`
            )
          );
      });
      worker.once('error', (error) =>
        finish(new Error('Transcript archive worker failed.', { cause: error }))
      );
      worker.once('exit', (code) =>
        finish(new Error(`Transcript archive worker exited without saving, code ${code}.`))
      );
    });
  }
}

function readText(message: UnknownRecord, text: string): TranscriptText {
  const time = asRecord(message.time);
  if (
    typeof message.id !== 'string' ||
    typeof time?.created !== 'number' ||
    !Number.isFinite(time.created) ||
    time.created < 0
  ) {
    throw new Error('Malformed transcript message timestamp or identity.');
  }
  const completed = time.completed;
  if (
    completed !== undefined &&
    (typeof completed !== 'number' || !Number.isFinite(completed) || completed < time.created)
  ) {
    throw new Error('Malformed transcript completion timestamp.');
  }
  const model = asRecord(message.model);
  const providerID = model?.providerID ?? message.providerID;
  const modelID = model?.id ?? message.modelID;
  return {
    id: message.id,
    created: time.created,
    text,
    completed: typeof completed === 'number' ? completed : undefined,
    finish: typeof message.finish === 'string' ? message.finish : undefined,
    model:
      typeof providerID === 'string' && typeof modelID === 'string'
        ? {
            providerID,
            id: modelID,
            variant: typeof model?.variant === 'string' ? model.variant : undefined,
          }
        : undefined,
  };
}

function readNativeMessage(message: UnknownRecord): TranscriptRecord | undefined {
  if (message.type === 'idle') {
    if (
      message.outcome !== 'succeeded' &&
      message.outcome !== 'failed' &&
      message.outcome !== 'interrupted'
    )
      throw new Error('Malformed transcript turn outcome.');
    return { type: 'idle', outcome: message.outcome };
  }
  if (message.type === 'user') {
    if (
      typeof message.text !== 'string' ||
      (message.files !== undefined && !Array.isArray(message.files))
    )
      throw new Error('Malformed transcript prompt.');
    const entry = readText(message, message.text);
    entry.attachments = (Array.isArray(message.files) ? message.files : []).map(readAttachment);
    return { type: 'user', entry };
  }
  if (message.type === 'assistant') {
    if (!Array.isArray(message.content))
      throw new Error('Transcript assistant content is missing.');
    const texts: string[] = [];
    for (const value of message.content) {
      const content = asRecord(value);
      if (!content || !['text', 'reasoning', 'tool'].includes(String(content.type)))
        throw new Error('Malformed transcript assistant content.');
      if (content.type === 'text') {
        if (typeof content.text !== 'string')
          throw new Error('Malformed transcript response text.');
        texts.push(content.text);
      }
    }
    return { type: 'assistant', entry: readText(message, texts.join('\n\n')) };
  }
  if (message.type === 'synthetic') return { type: 'synthetic' };
  if (
    ![
      'system',
      'skill',
      'shell',
      'compaction',
      'agent-switched',
      'model-switched',
      'location-switched',
    ].includes(String(message.type))
  ) {
    throw new Error('Unsupported transcript message type.');
  }
  return undefined;
}

function readLegacyMessage(message: UnknownRecord): TranscriptRecord | undefined {
  const info = asRecord(message?.info);
  if (!info || !Array.isArray(message?.parts))
    throw new Error('Malformed legacy transcript message.');
  if (info.role !== 'user' && info.role !== 'assistant')
    throw new Error('Unsupported legacy transcript role.');
  if (info.summary === true) return { type: 'synthetic' };
  const texts: string[] = [];
  const attachments: TranscriptAttachment[] = [];
  for (const value of message.parts) {
    const part = asRecord(value);
    if (!part || typeof part.type !== 'string')
      throw new Error('Malformed legacy transcript part.');
    if (part.type === 'text' && part.synthetic !== true && part.ignored !== true) {
      if (typeof part.text !== 'string') throw new Error('Malformed legacy transcript text.');
      texts.push(part.text);
    }
    if (info.role === 'user' && part.type === 'file') attachments.push(readAttachment(part));
  }
  const entry = readText(info, texts.join('\n\n'));
  if (info.role === 'assistant') return { type: 'assistant', entry };
  if (!texts.length && !attachments.length) return { type: 'synthetic' };
  entry.attachments = attachments;
  return { type: 'user', entry };
}

function readAttachment(value: unknown): TranscriptAttachment {
  const file = asRecord(value);
  if (!file || typeof file.mime !== 'string') throw new Error('Malformed transcript attachment.');
  const name = file.name ?? file.filename ?? 'Attachment';
  if (typeof name !== 'string') throw new Error('Malformed transcript attachment name.');
  const inlineText =
    file.mime === 'text/plain' && /^(?:pasted-text|annotation)-[a-f0-9]{8}\.txt$/.test(name);
  let text: string | undefined;
  if (inlineText) {
    text =
      typeof file.data === 'string'
        ? (readPastedTextDataUrl(`data:text/plain;base64,${file.data}`) ?? undefined)
        : typeof file.url === 'string'
          ? (readPastedTextDataUrl(file.url) ?? undefined)
          : undefined;
    if (text === undefined) throw new Error(`Cannot preserve transcript text attachment ${name}.`);
  }
  // Never retain media bytes, deferred API URLs or external filesystem paths.
  return { name, mime: file.mime, text, omitted: text === undefined };
}

function trimTranscript(records: TranscriptRecord[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let prompts: TranscriptText[] = [];
  let lastAssistant: TranscriptText | undefined;
  let lastText: TranscriptText | undefined;
  const flush = (outcome: Outcome, boundary: TranscriptTurn['boundary']) => {
    const candidate = outcome === 'failed' || outcome === 'interrupted' ? lastText : lastAssistant;
    const partial = outcome === 'failed' || outcome === 'interrupted';
    const response =
      candidate?.text &&
      (partial || (candidate.completed !== undefined && candidate.finish !== 'tool-calls'))
        ? candidate
        : undefined;
    if (prompts.length || response) turns.push({ prompts, response, outcome, boundary });
    prompts = [];
    lastAssistant = undefined;
    lastText = undefined;
  };
  for (const record of records) {
    if (record.type === 'idle') flush(record.outcome, 'idle');
    else if (record.type === 'user') {
      // Older/imported histories may lack idle markers. A completed non-tool
      // response before a new prompt is inferred, never a proven success.
      if (lastAssistant?.completed !== undefined && lastAssistant.finish !== 'tool-calls')
        flush('unknown', 'inferred');
      prompts.push(record.entry);
    } else if (record.type === 'assistant') {
      lastAssistant = record.entry;
      if (record.entry.text) lastText = record.entry;
    } else if (lastAssistant?.finish === 'stop') flush('unknown', 'inferred');
  }
  flush('unknown', 'inferred');
  return turns;
}

const TRANSCRIPT_WORKER = String.raw`
const { DatabaseSync } = require('node:sqlite');
const { closeSync, lstatSync, openSync } = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
let database;
let result;
try {
  // New archives contain private conversation text. Leave existing file permissions alone.
  try { closeSync(openSync(workerData.path, 'ax', 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const metadata = lstatSync(workerData.path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Transcript archive must be a regular file, not a symlink.');
  database = new DatabaseSync(workerData.path);
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
  const version = database.prepare('PRAGMA user_version').get().user_version;
  if (version !== 0 && version !== 1) throw new Error('Unsupported transcript archive schema version.');
  database.exec('BEGIN IMMEDIATE');
  database.exec('CREATE TABLE IF NOT EXISTS transcript_session (id TEXT PRIMARY KEY, identity TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, directory TEXT NOT NULL, time_created INTEGER, time_updated INTEGER NOT NULL, source_version INTEGER NOT NULL, time_archived INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS transcript_turn (session_id TEXT NOT NULL REFERENCES transcript_session(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, ordinal)); CREATE INDEX IF NOT EXISTS transcript_session_identity_idx ON transcript_session(identity); PRAGMA user_version = 1;');
  const previousSnapshot = database.prepare('SELECT time_updated FROM transcript_session WHERE id = ?');
  const removeSnapshot = database.prepare('DELETE FROM transcript_session WHERE id = ?');
  const insertSession = database.prepare('INSERT INTO transcript_session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertTurn = database.prepare('INSERT INTO transcript_turn VALUES (?, ?, ?)');
  for (const { session, turns } of workerData.snapshots) {
    const previous = previousSnapshot.get(session.id);
    if (session.version === 1 && previous && previous.time_updated >= session.updated) continue;
    if (previous && previous.time_updated > session.updated) throw new Error('Refusing to replace a newer transcript snapshot.');
    removeSnapshot.run(session.id);
    insertSession.run(session.id, session.identity ?? session.id, session.parentID ?? null, session.title ?? '', session.directory, session.created ?? null, session.updated, session.version ?? workerData.version, workerData.archivedAt);
    for (let index = 0; index < turns.length; index++) {
      insertTurn.run(session.id, index, JSON.stringify(turns[index]));
      if ((index + 1) % 1000 === 0) parentPort.postMessage({ progress: 'Writing transcript ' + session.id + ': ' + (index + 1).toLocaleString() + ' turns' });
    }
    parentPort.postMessage({ progress: 'Wrote transcript ' + session.id + ': ' + turns.length.toLocaleString() + ' turns; committing archive' });
  }
  database.exec('COMMIT');
  result = { saved: workerData.snapshots.length };
} catch (error) {
  result = { error: error instanceof Error ? error.message : String(error) };
} finally {
  database?.close();
}
parentPort.postMessage(result);
`;
