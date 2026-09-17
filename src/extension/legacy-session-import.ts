/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- SQLite JSON and worker replies are decoded at the import boundary; opaque original records are retained without narrowing away v1-only fields. */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { resolveOpenCodeDataDirectory } from '../shared/opencode-data-directory';
import { asRecord, isString, type UnknownRecord } from '../shared/type-utils';
import { v2Action, v2ModelRef } from './opencode-v2-projection';

type Request = (method: string, path: string, body?: unknown) => Promise<unknown>;
export type LegacySessionChoice = { id: string; title: string; directory: string };

/** Explicit copy import. All source database access is read-only and isolated in a bounded worker. */
export class LegacySessionImport {
  constructor(
    private readonly request: Request,
    private readonly databasePath = process.env.OPENCODE_DB ??
      join(resolveOpenCodeDataDirectory(), 'opencode.db')
  ) {}

  async list(directory: string): Promise<LegacySessionChoice[]> {
    const result = await this.read(directory);
    if (!Array.isArray(result)) throw new Error('Invalid legacy session catalog');
    return result.map((value: unknown) => {
      const row = asRecord(value);
      if (!isString(row?.id) || !isString(row.directory)) throw new Error('Invalid legacy session');
      return {
        id: row.id,
        directory: row.directory,
        title: isString(row.title) ? row.title : 'Untitled',
      };
    });
  }

  async importCopy(choice: LegacySessionChoice): Promise<string> {
    const snapshot = await this.read(choice.directory, choice.id);
    if (!Array.isArray(snapshot) || !snapshot.length)
      throw new Error('The selected v1 session is no longer available');
    const records = snapshot.map((value: unknown) => {
      const record = asRecord(value);
      const session = asRecord(record?.session);
      if (!isString(session?.id) || !Array.isArray(record?.messages))
        throw new Error('Invalid legacy session snapshot');
      return { session, messages: record.messages };
    });
    const ids = new Map<string, string>();
    const id = (source: string, prefix: string) => {
      if (!ids.has(source)) ids.set(source, `${prefix}_${randomBytes(16).toString('hex')}`);
      return ids.get(source)!;
    };
    for (const record of records) {
      id(String(record.session.id), 'ses');
      for (const value of record.messages) {
        const message = asRecord(value);
        const info = asRecord(message?.info);
        if (!isString(info?.id)) throw new Error('Legacy message is missing its ID');
        id(info.id, 'msg');
      }
    }
    const location = asRecord(
      await this.request(
        'GET',
        `/api/location?location[directory]=${encodeURIComponent(choice.directory)}`
      )
    );
    const projectID = asRecord(location?.project)?.id;
    if (!isString(projectID)) throw new Error('Could not resolve the destination v2 project');
    const imported: string[] = [];
    try {
      for (const { session, messages } of records) {
        const sessionID = ids.get(String(session.id))!;
        const remap = (value: unknown): unknown => {
          if (isString(value)) return ids.get(value) ?? value;
          if (Array.isArray(value)) return value.map(remap);
          const record = asRecord(value);
          return record
            ? Object.fromEntries(
                Object.entries(record).map(([key, item]) => [
                  key,
                  key === 'varroLegacy' || key === 'varroLegacyImport' ? item : remap(item),
                ])
              )
            : value;
        };
        const converted = messages.map((value: unknown) => convertMessage(value, ids));
        // Retain the complete original records, including v1-only parts, in message metadata.
        const payload = remap({
          location: { directory: choice.directory },
          info: {
            id: sessionID,
            parentID: isString(session.parent_id) ? ids.get(session.parent_id) : undefined,
            projectID,
            title: `${isString(session.title) ? session.title : 'Untitled'} (v1 copy)`,
            location: { directory: choice.directory },
            agent: session.agent ?? undefined,
            model: v2ModelRef(parseJson(session.model)),
            time: { created: session.time_created, updated: Date.now() },
            cost: session.cost ?? 0,
            tokens: {
              input: session.tokens_input ?? 0,
              output: session.tokens_output ?? 0,
              reasoning: session.tokens_reasoning ?? 0,
              cache: {
                read: session.tokens_cache_read ?? 0,
                write: session.tokens_cache_write ?? 0,
              },
            },
            metadata: {
              varroLegacyImport: {
                sourceSessionID: session.id,
                source: session,
                importedAt: Date.now(),
              },
            },
          },
          messages: converted,
        });
        await this.request('POST', '/api/experimental/session/import', payload);
        imported.push(sessionID);
      }
    } catch (error) {
      const cleanup = await Promise.allSettled(
        imported
          .toReversed()
          .map((sessionID) => this.request('DELETE', `/api/session/${sessionID}`))
      );
      const remaining = imported
        .toReversed()
        .filter((_, index) => cleanup[index]?.status === 'rejected');
      if (remaining.length)
        throw new Error(`Import failed; incomplete copies remain: ${remaining.join(', ')}`, {
          cause: error,
        });
      throw error;
    }
    return ids.get(choice.id)!;
  }

  private read(directory: string, sessionID?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(LEGACY_READER, {
        eval: true,
        workerData: { databasePath: this.databasePath, directory, sessionID },
      });
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error('Reading v1 history timed out'));
      }, 10_000);
      worker.once('message', (value: unknown) => {
        clearTimeout(timer);
        const result = asRecord(value);
        if (isString(result?.error)) reject(new Error(result.error));
        else resolve(result?.data);
      });
      worker.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`Legacy history reader exited with code ${code}`));
      });
    });
  }
}

function parseJson(value: unknown): unknown {
  return isString(value) ? JSON.parse(value) : value;
}

function convertMessage(value: unknown, ids: Map<string, string>): UnknownRecord {
  const entry = asRecord(value);
  const info = asRecord(entry?.info);
  if (!info || !isString(info.id) || !Array.isArray(entry?.parts))
    throw new Error('Invalid legacy message');
  const parts = entry.parts.map((part: unknown) => asRecord(part) ?? {});
  const time = asRecord(info.time) ?? {};
  const base = { id: ids.get(info.id), metadata: { varroLegacy: entry } };
  if (info.role === 'user') {
    const files = parts
      .filter((part) => part.type === 'file')
      .flatMap((part) => {
        const match = isString(part.url) ? /^data:([^;,]+);base64,([\s\S]*)$/.exec(part.url) : null;
        return match
          ? [{ mime: match[1], data: match[2], name: part.filename, source: { type: 'inline' } }]
          : [];
      });
    const text = parts.flatMap((part) =>
      part.type === 'text'
        ? [part.text]
        : part.type === 'file' && isString(part.url) && !part.url.startsWith('data:')
          ? [`[File attachment: ${String(part.filename ?? part.url)}]`]
          : []
    );
    return { ...base, type: 'user', time: { created: time.created }, text: text.join('\n'), files };
  }
  if (info.role !== 'assistant')
    throw new Error(`Unsupported legacy message role: ${String(info.role)}`);
  return {
    ...base,
    type: 'assistant',
    time: { ...time, completed: time.completed ?? time.created },
    agent: info.agent ?? info.mode ?? 'build',
    model: { providerID: info.providerID, id: info.modelID },
    finish: time.completed ? info.finish : 'error',
    cost: info.cost,
    tokens: info.tokens,
    error: info.error
      ? {
          type: 'unknown',
          message: asRecord(asRecord(info.error)?.data)?.message ?? 'Imported assistant error',
        }
      : undefined,
    content: parts.flatMap((part): UnknownRecord[] => {
      if (part.type === 'text' || part.type === 'reasoning') {
        const timing = asRecord(part.time);
        return [
          {
            type: part.type,
            text: part.text ?? '',
            time:
              part.type === 'reasoning'
                ? {
                    created: timing?.start ?? time.created,
                    completed: timing?.end ?? time.completed ?? time.created,
                  }
                : undefined,
          },
        ];
      }
      if (part.type !== 'tool') return [];
      const state = asRecord(part.state) ?? {};
      const timing = asRecord(state.time) ?? {};
      const completed = state.status === 'completed';
      return [
        {
          type: 'tool',
          id: part.callID ?? part.id,
          name: v2Action(String(part.tool)),
          time: {
            created: timing.start ?? time.created,
            ran: timing.start,
            completed: timing.end ?? time.completed ?? time.created,
          },
          state: completed
            ? {
                status: 'completed',
                input: state.input ?? {},
                metadata: state.metadata,
                content: [
                  {
                    type: 'text',
                    text: isString(state.output)
                      ? state.output
                      : JSON.stringify(state.output ?? ''),
                  },
                ],
              }
            : {
                status: 'error',
                input: state.input ?? {},
                metadata: state.metadata,
                error: {
                  type: 'unknown',
                  message: isString(state.error)
                    ? state.error
                    : 'Tool was unfinished in the imported v1 snapshot',
                },
              },
        },
      ];
    }),
  };
}

const LEGACY_READER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db;
try {
  db = new DatabaseSync(workerData.databasePath, { readOnly: true });
  db.exec('BEGIN');
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session'").get()) {
    parentPort.postMessage({ data: [] });
  } else if (!workerData.sessionID) {
    parentPort.postMessage({ data: db.prepare('SELECT id,title,directory FROM session WHERE directory=? AND parent_id IS NULL ORDER BY time_updated DESC LIMIT 1000').all(workerData.directory) });
  } else {
    const rows = db.prepare('WITH RECURSIVE tree(id,depth) AS (SELECT id,0 FROM session WHERE id=? AND directory=? UNION ALL SELECT s.id,t.depth+1 FROM session s JOIN tree t ON s.parent_id=t.id WHERE t.depth<32 AND s.directory=?) SELECT s.* FROM tree t JOIN session s ON s.id=t.id ORDER BY t.depth LIMIT 101').all(workerData.sessionID, workerData.directory, workerData.directory);
    if (rows.length > 100) throw new Error('The selected session tree is too large to import');
    let bytes = 0;
    const data = rows.map(session => {
      const messages = db.prepare('SELECT * FROM message WHERE session_id=? ORDER BY time_created,id LIMIT 10001').all(session.id);
      const parts = db.prepare('SELECT * FROM part WHERE session_id=? ORDER BY time_created,id LIMIT 100001').all(session.id);
      if (messages.length > 10000 || parts.length > 100000) throw new Error('The selected history is too large to import');
      const byMessage = new Map();
      for (const part of parts) {
        bytes += Buffer.byteLength(part.data);
        if (bytes > 32 * 1024 * 1024) throw new Error('The selected history exceeds the 32 MiB import limit');
        if (!byMessage.has(part.message_id)) byMessage.set(part.message_id, []);
        byMessage.get(part.message_id).push({ ...JSON.parse(part.data), id: part.id, messageID: part.message_id, sessionID: session.id });
      }
      return { session, messages: messages.map(message => {
        bytes += Buffer.byteLength(message.data);
        if (bytes > 32 * 1024 * 1024) throw new Error('The selected history exceeds the 32 MiB import limit');
        return { info: { ...JSON.parse(message.data), id: message.id, sessionID: session.id }, parts: byMessage.get(message.id) ?? [] };
      }) };
    });
    parentPort.postMessage({ data });
  }
  db.exec('ROLLBACK');
} catch (error) { parentPort.postMessage({ error: error.message }); }
finally { db?.close(); }
`;
