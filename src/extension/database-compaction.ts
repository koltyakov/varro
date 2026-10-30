/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Validate child-process maintenance replies before reporting disk-space changes. */
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { asRecord } from '../shared/type-utils';
import { acquireFileLock } from './file-lock';
import { logger } from './logger';
import type { OpenCodeServer } from './server';
import { usageDatabasePaths } from './usage-database-paths';

export type DatabaseSpace = {
  bytes: number;
  wal: number;
  reusable: number;
  required: number;
  available: number;
};

export class DatabaseCompaction {
  private pending: Promise<void> | undefined;
  constructor(
    private readonly server: Pick<OpenCodeServer, 'isAttachOnly' | 'withStoppedServer'>
  ) {}

  async run(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.runNow();
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  private async runNow(): Promise<void> {
    const controller = new AbortController();
    let release: (() => Promise<void>) | undefined;
    try {
      if (this.server.isAttachOnly)
        throw new Error(
          'Database compaction is only available for a verified local managed server.'
        );
      const { databasePath, archivePath } = usageDatabasePaths();
      release = await acquireFileLock(`${archivePath}.cleanup.lock`);
      const before = await inspectDatabaseSpace(databasePath);
      if (before.reusable === 0 && before.wal === 0) {
        await vscode.window.showInformationMessage(
          'No unused SQLite pages to reclaim. Stored history and attachments still occupy this space.'
        );
        return;
      }
      if (before.available < before.required)
        throw new Error(
          `Not enough free disk space. Compaction requires at least ${size(before.required)} free; ${size(before.available)} is available.`
        );
      const choice = await vscode.window.showWarningMessage(
        `Compact ${databasePath}? About ${size(before.reusable)} is reusable; the SQLite WAL occupies ${size(before.wal)}. OpenCode will be stopped and restarted, and the database will be unavailable for several minutes. Close other OpenCode clients and back up your data first. At least ${size(before.required)} free disk space is required. Active work prevents compaction.`,
        { modal: true },
        'Compact database'
      );
      if (choice !== 'Compact database') return;
      const after = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'OpenCode database compaction',
          cancellable: true,
        },
        async (progress, token) => {
          let phase = '1/3 Preparing to stop OpenCode';
          const started = performance.now();
          const report = () =>
            progress.report({
              message: `${controller.signal.aborted ? 'Cancelling; waiting for SQLite and restoring OpenCode' : phase} · ${Math.floor((performance.now() - started) / 1000)}s`,
            });
          const subscription = token.onCancellationRequested(() => {
            controller.abort();
            report();
          });
          if (token.isCancellationRequested) controller.abort();
          const timer = setInterval(report, 1000);
          report();
          try {
            controller.signal.throwIfAborted();
            return await this.server.withStoppedServer(async () => {
              try {
                controller.signal.throwIfAborted();
                phase = '2/3 Compacting database';
                report();
                return await compactDatabaseFile(databasePath, controller.signal, (message) => {
                  phase = `2/3 ${message}`;
                  report();
                });
              } finally {
                phase = '3/3 Restarting OpenCode';
                report();
              }
            });
          } finally {
            clearInterval(timer);
            subscription.dispose();
          }
        }
      );
      logger.info(
        `Database compaction complete: ${size(before.bytes)} to ${size(after.bytes)}. Session content was not changed.`
      );
      await vscode.window.showInformationMessage(
        `Database compacted. ${size(Math.max(0, before.bytes - after.bytes))} reclaimed; size is now ${size(after.bytes)}. OpenCode restarted.`
      );
    } catch (error) {
      if (
        controller.signal.aborted &&
        (error === controller.signal.reason ||
          (error instanceof Error && error.name === 'AbortError'))
      ) {
        logger.warn(
          `Database compaction cancelled: ${error instanceof Error ? error.message : String(error)}`
        );
        await vscode.window.showInformationMessage(
          'Database compaction cancelled. Check OpenCode connection status before retrying.'
        );
      } else {
        logger.error(
          `Database compaction failed: ${error instanceof Error ? error.message : String(error)}`
        );
        const choice = await vscode.window.showErrorMessage(
          `Database compaction stopped. ${error instanceof Error ? error.message : String(error)}`,
          'Show details'
        );
        if (choice === 'Show details') logger.show();
      }
    } finally {
      await release?.();
    }
  }
}

export function inspectDatabaseSpace(path: string): Promise<DatabaseSpace> {
  return runTask(path, false);
}

/** Run only inside withStoppedServer. A separate process permits actual cancellation of native SQLite. */
export function compactDatabaseFile(
  path: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<DatabaseSpace> {
  return runTask(path, true, signal, onProgress);
}

function runTask(
  path: string,
  compact: boolean,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<DatabaseSpace> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', MAINTENANCE_PROCESS], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        TMPDIR: dirname(path),
        TEMP: dirname(path),
        TMP: dirname(path),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let result: DatabaseSpace | undefined;
    let failure: Error | undefined;
    let stderr = '';
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (forceStop) return;
      failure ??= error;
      child.kill('SIGTERM');
      forceStop = setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    const cancel = () => {
      const error = new Error('Database compaction cancelled.');
      error.name = 'AbortError';
      stop(error);
    };
    const timeout = setTimeout(
      () =>
        stop(
          new Error(
            compact
              ? 'Database compaction exceeded the one-hour limit.'
              : 'Database inspection timed out.'
          )
        ),
      compact ? 60 * 60_000 : 10_000
    );
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2048) stderr += chunk.toString().slice(0, 2048 - stderr.length);
    });
    child.on('message', (value: unknown) => {
      const reply = asRecord(value);
      if (typeof reply?.progress === 'string') {
        onProgress?.(reply.progress);
        return;
      }
      if (typeof reply?.error === 'string') {
        failure = new Error(reply.error);
        return;
      }
      const fields = ['bytes', 'wal', 'reusable', 'required', 'available'] as const;
      if (
        reply &&
        fields.every(
          (field) =>
            typeof reply[field] === 'number' &&
            Number.isSafeInteger(reply[field]) &&
            reply[field] >= 0
        )
      ) {
        result = {
          bytes: Number(reply.bytes),
          wal: Number(reply.wal),
          reusable: Number(reply.reusable),
          required: Number(reply.required),
          available: Number(reply.available),
        };
      } else failure = new Error('Invalid database maintenance acknowledgement.');
    });
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      clearTimeout(forceStop);
      signal?.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else if (code !== 0 || !result)
        reject(
          new Error(
            `Database maintenance exited without a result${stderr ? `: ${stderr}` : `, code ${code}`}`
          )
        );
      else resolve(result);
    });
    child.send?.({ path, compact }, (error: Error | null) => {
      if (error) stop(error);
    });
  });
}

function size(bytes: number): string {
  return `${(bytes / 1_000_000_000).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
}

const MAINTENANCE_PROCESS = String.raw`
const { DatabaseSync } = require('node:sqlite');
const { lstatSync, statSync, statfsSync } = require('node:fs');
const { dirname } = require('node:path');
process.once('message', ({ path, compact }) => {
  let database;
  const space = () => {
    const main = lstatSync(path);
    if (!main.isFile() || main.isSymbolicLink() || main.nlink !== 1) throw new Error('Database must be a regular file without symlinks or hard links.');
    let wal = 0;
    try { wal = statSync(path + '-wal').size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const bytes = main.size + wal;
    const pageSize = database.prepare('PRAGMA page_size').get().page_size;
    const pages = database.prepare('PRAGMA page_count').get().page_count;
    const reusable = database.prepare('PRAGMA freelist_count').get().freelist_count * pageSize;
    const disk = statfsSync(dirname(path), { bigint: true });
    return { bytes, wal, reusable, required: Math.max(bytes, pages * pageSize) * 2 + 64 * 1024 * 1024, available: Number(disk.bavail * disk.bsize) };
  };
  let reply;
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error('Database must be a regular file without symlinks or hard links.');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {
        const sidecar = lstatSync(path + suffix);
        if (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1) throw new Error('Database sidecars must be regular files without symlinks or hard links.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    database = new DatabaseSync(path, { readOnly: !compact });
    database.exec('PRAGMA busy_timeout=1000;');
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!tables.has('project') || (!tables.has('session') && !tables.has('session_v2'))) throw new Error('Unsupported OpenCode database schema.');
    const before = space();
    if (compact) {
      if (before.available < before.required) throw new Error('Not enough free disk space for compaction.');
      database.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
      const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (checkpoint.busy) throw new Error('Database is still in use. Close other OpenCode clients before compaction.');
      process.send({ progress: 'Reclaiming unused SQLite pages' });
      database.exec('PRAGMA synchronous=FULL; VACUUM;');
      database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      process.send({ progress: 'Verifying compacted database' });
      if (database.prepare('PRAGMA quick_check(1)').get().quick_check !== 'ok') throw new Error('Compacted database integrity check failed.');
    }
    reply = space();
  } catch (error) { reply = { error: error instanceof Error ? error.message : String(error) }; }
  finally { database?.close(); }
  process.send(reply, () => process.disconnect());
});
`;
