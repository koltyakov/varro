/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- SQLite worker replies are decoded before rendering database details. */
import { Worker } from 'node:worker_threads';
import { asRecord } from '../shared/type-utils';
import type { OpenCodeServer } from './server';
import { usageDatabasePaths } from './usage-database-paths';

export type AboutDatabaseDetails = {
  location: string;
  size: string;
  reusable: string;
  age: string;
  projects: string;
  sessions: string;
  note: string;
};

const QUERY_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 30_000;
const COUNT_NOTE =
  'Stored V1 and V2 records, including copies and child sessions. History age uses the oldest stored session, including retained V1 history. Size includes the SQLite WAL; reusable space stays in the file until compaction. Archives are separate.';

/** About polls every five seconds; database reads run separately and reuse a short-lived cache. */
export class AboutDatabase {
  private cached: { path: string; expires: number; details: AboutDatabaseDetails } | undefined;
  private pending:
    | {
        path: string;
        generation: number;
        promise: Promise<AboutDatabaseDetails>;
        details: AboutDatabaseDetails;
      }
    | undefined;
  private generation = 0;

  constructor(private readonly server: Pick<OpenCodeServer, 'isAttachOnly'>) {}

  snapshot(): AboutDatabaseDetails {
    if (this.server.isAttachOnly)
      return unavailable(
        'On server host',
        'Database details are unavailable for attach-only connections.'
      );
    const path = usageDatabasePaths().databasePath;
    if (this.cached?.path === path) return this.cached.details;
    return this.pending?.path === path && this.pending.generation === this.generation
      ? this.pending.details
      : loading(path);
  }

  invalidate(): void {
    this.generation++;
    this.cached = undefined;
  }

  async read(): Promise<AboutDatabaseDetails> {
    if (this.server.isAttachOnly)
      return unavailable(
        'On server host',
        'Database details are unavailable for attach-only connections.'
      );
    const path = usageDatabasePaths().databasePath;
    if (this.cached?.path === path && this.cached.expires > Date.now()) return this.cached.details;
    let operation = this.pending;
    if (!operation || operation.path !== path || operation.generation !== this.generation) {
      const promise = readDatabase(
        path,
        (details) => {
          if (this.pending?.promise === promise) this.pending.details = details;
        },
        () => {
          if (this.pending?.promise === promise) this.pending = undefined;
        }
      ).catch(() => {
        if (this.pending?.promise === promise) this.pending = undefined;
        return unavailable(path, 'Could not start the database worker.');
      });
      operation = { path, generation: this.generation, promise, details: loading(path) };
      this.pending = operation;
    }
    const details = await operation.promise;
    if (operation.generation === this.generation && (this.pending === operation || !this.pending)) {
      this.cached = { path, expires: Date.now() + CACHE_TTL_MS, details };
    }
    return this.server.isAttachOnly
      ? unavailable(
          'On server host',
          'Database details are unavailable for attach-only connections.'
        )
      : details;
  }
}

function readDatabase(
  path: string,
  onProgress: (details: AboutDatabaseDetails) => void,
  onStopped: () => void
): Promise<AboutDatabaseDetails> {
  return new Promise((resolve) => {
    const worker = new Worker(DATABASE_WORKER, {
      eval: true,
      workerData: { path, now: Date.now() },
    });
    let settled = false;
    let details = unavailable(path, 'Reading database details in the background.');
    const finish = (resultDetails: AboutDatabaseDetails) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // Native SQLite calls can delay worker termination. Never make the UI wait for teardown.
      resolve(resultDetails);
      void worker.terminate().catch(() => 0);
    };
    const timeout = setTimeout(
      () =>
        finish({
          ...details,
          note: 'Some database counts timed out. Available details are shown.',
        }),
      QUERY_TIMEOUT_MS
    );
    worker.on('message', (value: unknown) => {
      if (settled) return;
      const result = asRecord(value);
      const sizeBytes = count(result?.sizeBytes);
      const oldestAt =
        typeof result?.oldestAt === 'number' && Number.isFinite(result.oldestAt)
          ? result.oldestAt
          : null;
      const freeBytes = count(result?.freeBytes);
      const projects = count(result?.projects);
      const sessions = count(result?.sessions);
      const error = typeof result?.error === 'string' ? result.error : undefined;
      details = {
        location: path,
        size: sizeBytes === null ? details.size : formatSize(sizeBytes),
        reusable: freeBytes === null ? details.reusable : formatSize(freeBytes),
        age:
          oldestAt === null ? (sessions === 0 ? 'No history' : details.age) : formatAge(oldestAt),
        projects: projects === null ? details.projects : projects.toLocaleString(),
        sessions: sessions === null ? details.sessions : sessions.toLocaleString(),
        note: error
          ? `Database details unavailable: ${error}`
          : result?.complete === false
            ? 'Reading database counts in the background.'
            : COUNT_NOTE,
      };
      onProgress(details);
      if (error || result?.complete !== false) {
        if (!error && (sizeBytes === null || projects === null || sessions === null))
          details.note = 'Database worker returned invalid counts.';
        finish(details);
        // Final replies are posted only after SQLite closes its connection.
        if (result?.complete === true) onStopped();
      }
    });
    worker.once('error', (error: unknown) =>
      finish({
        ...details,
        note: `Database details unavailable: ${error instanceof Error ? error.message : 'Database worker failed.'}`,
      })
    );
    worker.once('exit', (code) => {
      finish({ ...details, note: `Database worker exited without counts, code ${code}.` });
      onStopped();
    });
  });
}

function unavailable(location: string, note: string): AboutDatabaseDetails {
  return {
    location,
    size: 'Unknown',
    reusable: 'Unknown',
    age: 'Unknown',
    projects: 'Unknown',
    sessions: 'Unknown',
    note,
  };
}

function loading(location: string): AboutDatabaseDetails {
  return {
    location,
    size: 'Loading...',
    reusable: 'Loading...',
    age: 'Loading...',
    projects: 'Loading...',
    sessions: 'Loading...',
    note: 'Reading database details in the background.',
  };
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function formatSize(bytes: number): string {
  if (bytes > 0 && bytes < 100_000) return '<0.1 MB';
  const gigabytes = bytes >= 1_000_000_000;
  return `${(bytes / (gigabytes ? 1_000_000_000 : 1_000_000)).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${gigabytes ? 'GB' : 'MB'}`;
}

function formatAge(createdAt: number): string {
  const now = new Date();
  const created = new Date(createdAt);
  if (createdAt <= 0 || !Number.isFinite(created.getTime()) || createdAt > now.getTime())
    return 'Unknown';
  let months =
    (now.getUTCFullYear() - created.getUTCFullYear()) * 12 +
    now.getUTCMonth() -
    created.getUTCMonth();
  const anniversary = new Date(created);
  anniversary.setUTCDate(1);
  anniversary.setUTCFullYear(now.getUTCFullYear(), now.getUTCMonth());
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  anniversary.setUTCDate(Math.min(created.getUTCDate(), lastDay));
  if (anniversary.getTime() > now.getTime()) months -= 1;
  if (months >= 1) return `${months.toLocaleString()} ${months === 1 ? 'month' : 'months'}`;
  const days = Math.floor((now.getTime() - createdAt) / 86_400_000);
  return days >= 1 ? `${days.toLocaleString()} ${days === 1 ? 'day' : 'days'}` : '<1 day';
}

const DATABASE_WORKER = String.raw`
const { DatabaseSync } = require('node:sqlite');
const { statSync } = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
let database;
let sizeBytes = null;
let oldestAt = null;
let freeBytes = null;
let projects = null;
let sessions = null;
let result;
try {
  const metadata = statSync(workerData.path);
  sizeBytes = metadata.size;
  try { sizeBytes += statSync(workerData.path + '-wal').size; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  parentPort.postMessage({ sizeBytes, complete: false });
  database = new DatabaseSync(workerData.path, { readOnly: true });
  database.exec('PRAGMA busy_timeout = 1000; BEGIN;');
  freeBytes = database.prepare('PRAGMA freelist_count').get().freelist_count * database.prepare('PRAGMA page_size').get().page_size;
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  if (!tables.has('project') || (!tables.has('session') && !tables.has('session_v2'))) throw new Error('Unsupported OpenCode database schema.');
  projects = database.prepare('SELECT count(*) AS count FROM project').get().count;
  parentPort.postMessage({ sizeBytes, freeBytes, projects, complete: false });
  sessions = 0;
  for (const table of ['session', 'session_v2']) {
    if (!tables.has(table)) continue;
    const hasCreated = database.prepare('PRAGMA table_info(' + table + ')').all().some((row) => row.name === 'time_created');
    const row = hasCreated
      ? database.prepare("SELECT count(*) AS count, min(CASE WHEN typeof(time_created) IN ('integer','real') AND time_created > 0 AND time_created <= ? THEN time_created END) AS oldest FROM " + table).get(workerData.now)
      : database.prepare('SELECT count(*) AS count FROM ' + table).get();
    sessions += row.count;
    if (typeof row.oldest === 'number' && (oldestAt === null || row.oldest < oldestAt)) oldestAt = row.oldest;
  }
  result = { sizeBytes, freeBytes, oldestAt, projects, sessions, complete: true };
} catch (error) {
  result = { sizeBytes, freeBytes, oldestAt, projects, sessions, complete: true, error: error instanceof Error ? error.message.slice(0, 200) : 'Could not read the database.' };
} finally { database?.close(); }
parentPort.postMessage(result);
`;
