/* oxlint-disable anti-slop/no-module-mocking -- UI and server lifecycle are boundaries; SQLite compaction runs in real cancellable child processes against isolated fixtures. */
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compactDatabaseFile,
  DatabaseCompaction,
  inspectDatabaseSpace,
} from './database-compaction';
import type { DatabaseSpace } from './database-compaction';
import type { ProgressOptions } from 'vscode';
import type { SpawnOptions } from 'node:child_process';
import type * as childProcess from 'node:child_process';

const ui = vi.hoisted(() => ({
  confirm: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  report: vi.fn(),
  cancelled: false,
  cancel: () => {},
}));
const disk = vi.hoisted(() => ({ full: false }));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof childProcess>();
  return {
    ...original,
    spawn: (command: string, args: readonly string[], options: SpawnOptions) =>
      original.spawn(
        command,
        disk.full
          ? args.map((arg) =>
              arg.replace('available: Number(disk.bavail * disk.bsize)', 'available: 0')
            )
          : args,
        options
      ),
  };
});
vi.mock('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  window: {
    showWarningMessage: ui.confirm,
    showInformationMessage: ui.info,
    showErrorMessage: ui.error,
    withProgress: async (
      _options: ProgressOptions,
      task: (
        progress: { report: typeof ui.report },
        token: {
          isCancellationRequested: boolean;
          onCancellationRequested: (listener: () => void) => { dispose: () => void };
        }
      ) => Promise<DatabaseSpace>
    ) =>
      task(
        { report: ui.report },
        {
          isCancellationRequested: ui.cancelled,
          onCancellationRequested: (listener) => {
            ui.cancel = listener;
            return { dispose() {} };
          },
        }
      ),
  },
}));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), show: vi.fn() },
}));
const directories: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  ui.confirm.mockResolvedValue('Compact database');
  ui.cancelled = false;
  ui.cancel = () => {};
  ui.report.mockReset();
  disk.full = false;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture() {
  const parent = resolve('artifacts/ai-test-data');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'database-compaction-'));
  directories.push(root);
  const path = join(root, 'opencode.db');
  vi.stubEnv('OPENCODE_DB', path);
  const database = new DatabaseSync(path);
  database.exec(`CREATE TABLE project (id TEXT PRIMARY KEY); CREATE TABLE session_v2 (id TEXT PRIMARY KEY,time_created INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY,session_id TEXT,data BLOB);
    INSERT INTO project VALUES ('project'); INSERT INTO session_v2 VALUES ('keep',1);
    WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<1000)
    INSERT INTO session_message SELECT 'message-'||value,'keep',zeroblob(4096) FROM n;
    DELETE FROM session_message WHERE id <> 'message-1';`);
  database.close();
  const stopped = vi.fn();
  const restored = vi.fn();
  const server = {
    isAttachOnly: false,
    async withStoppedServer<T>(operation: () => Promise<T>): Promise<T> {
      stopped();
      try {
        return await operation();
      } finally {
        restored();
      }
    },
  };
  return { root, path, server, stopped, restored, service: new DatabaseCompaction(server) };
}

describe('database compaction', () => {
  it('does not hide a server restoration failure after cancellation', async () => {
    const f = await fixture();
    f.server.withStoppedServer = async (operation) => {
      try {
        await operation();
      } catch {
        /* Simulate restart failure after cancelled maintenance. */
      }
      throw new Error('OpenCode restart failed');
    };
    ui.report.mockImplementation(({ message }: { message: string }) => {
      if (message.includes('2/3 Compacting database')) ui.cancel();
    });
    await f.service.run();
    expect(ui.error).toHaveBeenCalledWith(
      expect.stringContaining('OpenCode restart failed'),
      'Show details'
    );
    expect(ui.info).not.toHaveBeenCalled();
  });

  it('also checks free space inside the stopped-server maintenance process', async () => {
    const f = await fixture();
    const before = await readFile(f.path);
    disk.full = true;
    await expect(compactDatabaseFile(f.path)).rejects.toThrow('Not enough free disk space');
    expect((await readFile(f.path)).equals(before)).toBe(true);
  });

  it('offers maintenance for WAL-only space instead of treating zero free pages as no work', async () => {
    const f = await fixture();
    await compactDatabaseFile(f.path);
    const database = new DatabaseSync(f.path);
    try {
      database.exec(
        'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE session_v2 SET time_created=2;'
      );
      const before = await inspectDatabaseSpace(f.path);
      expect(before.reusable).toBe(0);
      expect(before.wal).toBeGreaterThan(0);
      ui.confirm.mockResolvedValue(undefined);
      await f.service.run();
      expect(ui.confirm).toHaveBeenCalledOnce();
      expect(f.stopped).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it('skips maintenance when there are no free pages or WAL bytes', async () => {
    const f = await fixture();
    await compactDatabaseFile(f.path);
    await f.service.run();
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(f.stopped).not.toHaveBeenCalled();
    expect(ui.info).toHaveBeenCalledWith(expect.stringContaining('No unused SQLite pages'));
  });

  it('refuses insufficient disk space before confirmation or stopping OpenCode', async () => {
    const f = await fixture();
    disk.full = true;
    await f.service.run();
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(f.stopped).not.toHaveBeenCalled();
    expect(ui.error).toHaveBeenCalledWith(
      expect.stringContaining('Not enough free disk space'),
      'Show details'
    );
  });

  it('inspects reusable space without modifying the database', async () => {
    const f = await fixture();
    const before = await readFile(f.path);
    const result = await inspectDatabaseSpace(f.path);
    expect(result.bytes).toBe(before.length);
    expect(result.reusable).toBeGreaterThan(3_000_000);
    expect(result.required).toBeGreaterThan(result.bytes * 2);
    expect(result.available).toBeGreaterThan(0);
    expect((await readFile(f.path)).equals(before)).toBe(true);
  });

  it('reclaims disk space without changing retained session rows or attachments', async () => {
    const f = await fixture();
    const before = await inspectDatabaseSpace(f.path);
    const result = await compactDatabaseFile(f.path);
    expect(result.bytes).toBeLessThan(before.bytes / 2);
    expect(result.reusable).toBe(0);
    const database = new DatabaseSync(f.path, { readOnly: true });
    try {
      expect(database.prepare('SELECT * FROM session_v2').all()).toEqual([
        { id: 'keep', time_created: 1 },
      ]);
      expect(database.prepare('SELECT length(data) AS size FROM session_message').get()?.size).toBe(
        4096
      );
      expect(database.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    } finally {
      database.close();
    }
  });

  it('refuses compaction when another connection is writing and leaves content intact', async () => {
    const f = await fixture();
    const database = new DatabaseSync(f.path);
    database.exec('BEGIN IMMEDIATE');
    try {
      await expect(compactDatabaseFile(f.path)).rejects.toThrow(/locked|use/i);
      expect(database.prepare('SELECT count(*) AS count FROM session_v2').get()?.count).toBe(1);
    } finally {
      database.exec('ROLLBACK');
      database.close();
    }
  });

  it('cancels the actual child before compaction and waits until the file can be reopened', async () => {
    const f = await fixture();
    const before = await readFile(f.path);
    const controller = new AbortController();
    const operation = compactDatabaseFile(f.path, controller.signal, () => controller.abort());
    await expect(operation).rejects.toThrow('cancelled');
    const database = new DatabaseSync(f.path);
    try {
      expect(database.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
      expect(database.prepare('SELECT count(*) AS count FROM session_v2').get()?.count).toBe(1);
    } finally {
      database.close();
    }
    // SQLite may finish atomically before termination; either valid size is safe.
    expect((await stat(f.path)).size).toBeLessThanOrEqual(before.length);
  });

  it('does not open an already-cancelled operation', async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    expect(() => compactDatabaseFile(f.path, controller.signal)).toThrow();
  });

  it('requires confirmation and performs maintenance inside the stopped-server boundary', async () => {
    const f = await fixture();
    await f.service.run();
    expect(ui.confirm).toHaveBeenCalledWith(
      expect.stringContaining('stopped and restarted'),
      { modal: true },
      'Compact database'
    );
    expect(f.stopped).toHaveBeenCalledOnce();
    expect(f.restored).toHaveBeenCalledOnce();
    expect(ui.info).toHaveBeenCalledWith(expect.stringContaining('Database compacted.'));
    expect(ui.error).not.toHaveBeenCalled();
  });

  it('does not stop or compact when confirmation is declined', async () => {
    const f = await fixture();
    const before = await readFile(f.path);
    ui.confirm.mockResolvedValue(undefined);
    await f.service.run();
    expect(f.stopped).not.toHaveBeenCalled();
    expect((await readFile(f.path)).equals(before)).toBe(true);
  });

  it('does not stop or compact an attach-only connection', async () => {
    const f = await fixture();
    f.server.isAttachOnly = true;
    await f.service.run();
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(f.stopped).not.toHaveBeenCalled();
    expect(ui.error).toHaveBeenCalledWith(
      expect.stringContaining('verified local managed server'),
      'Show details'
    );
  });

  it('does not stop OpenCode when progress is already cancelled', async () => {
    const f = await fixture();
    ui.cancelled = true;
    await f.service.run();
    expect(f.stopped).not.toHaveBeenCalled();
    expect(ui.error).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('refuses symlinks and hard links', async () => {
    const f = await fixture();
    const alias = join(f.root, 'alias.db');
    await symlink(f.path, alias);
    await expect(inspectDatabaseSpace(alias)).rejects.toThrow('regular file');
    await rm(alias);
    await link(f.path, alias);
    await expect(compactDatabaseFile(f.path)).rejects.toThrow('regular file');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses linked SQLite sidecars before opening the database',
    async () => {
      const f = await fixture();
      const before = await readFile(f.path);
      await symlink(f.path, `${f.path}-wal`);
      await expect(compactDatabaseFile(f.path)).rejects.toThrow('sidecars must be regular files');
      expect((await readFile(f.path)).equals(before)).toBe(true);
    }
  );
});
