/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters -- Mock editor boundaries and decode real worker replies; all SQLite writes use disposable fixtures. */
import { copyFile, link, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type * as workerThreads from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressOptions } from 'vscode';
import { asRecord } from '../shared/type-utils';
import {
  archiveSessionUsage,
  preserveOriginalUsageTiming,
  readAllTimeUsageCsv,
  UsageReportService,
} from './usage-report-service';
import { usageDatabasePaths } from './usage-database-paths';
import { OpenCodeV2SessionState } from './opencode-v2-session-state';

const probe = vi.hoisted(() => {
  const replies: unknown[] = [];
  return { replies, content: '' };
});
vi.mock('node:worker_threads', async (importOriginal) => {
  const original = await importOriginal<typeof workerThreads>();
  return {
    ...original,
    Worker: class extends original.Worker {
      constructor(filename: string | URL, options?: workerThreads.WorkerOptions) {
        super(filename, options);
        this.on('message', (value: unknown) => {
          if (asRecord(value)?.windows) probe.replies.push(value);
        });
      }
    },
  };
});
vi.mock('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  commands: { executeCommand: vi.fn() },
  workspace: {
    openTextDocument: async ({ content }: { content: string }) => {
      probe.content = content;
      return { uri: 'untitled:usage' };
    },
  },
  window: {
    withProgress: async (_options: ProgressOptions, task: () => Promise<string>) => task(),
    showTextDocument: vi.fn(),
    showErrorMessage: vi.fn(),
  },
}));
const NOW = Date.UTC(2026, 9, 30, 12);
const directories: string[] = [];
const databases: DatabaseSync[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  probe.replies.length = 0;
});
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function fixture() {
  const parent = resolve('artifacts/ai-test-data');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'original-timing-'));
  directories.push(root);
  const path = join(root, 'opencode.db');
  vi.stubEnv('OPENCODE_DB', path);
  vi.stubEnv('VARRO_TEST_STATE_ROOT', join(root, 'state'));
  const database = new DatabaseSync(path);
  databases.push(database);
  database.exec(`CREATE TABLE session (id TEXT PRIMARY KEY,time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY,session_id TEXT,data TEXT);
    CREATE INDEX message_session_idx ON message(session_id);
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY,time_updated INTEGER,metadata TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT);
    CREATE INDEX session_message_session_type_seq_idx ON session_message(session_id,type,seq);`);
  const add = (id = 'live', count = 2, identity = id) => {
    database.prepare('INSERT INTO session VALUES (?,?)').run(identity, NOW);
    database
      .prepare('INSERT INTO session_v2 VALUES (?,?,?)')
      .run(
        id,
        NOW,
        identity === id
          ? null
          : JSON.stringify({ varroLegacyImport: { sourceSessionID: identity } })
      );
    database
      .prepare('INSERT INTO session_message VALUES (?,?,?,?,?)')
      .run(`${id}-prompt`, id, 'user', 0, '{}');
    for (let index = 0; index < count; index++) {
      const data = {
        role: 'assistant',
        providerID: 'provider',
        modelID: 'model',
        parentID: `${id}-prompt`,
        time: { created: NOW - 10_000, completed: NOW - 8_000 },
        tokens: { input: 10, output: 5 },
        cost: 0.25,
      };
      database
        .prepare('INSERT INTO message VALUES (?,?,?)')
        .run(`${id}-${index}`, identity, JSON.stringify(data));
      database.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run(
        `${id}-${index}`,
        id,
        'assistant',
        index + 1,
        JSON.stringify({
          model: { providerID: 'provider', id: 'model', variant: 'high' },
          time: { created: data.time.created, completed: NOW },
          tokens: data.tokens,
          cost: data.cost,
        })
      );
    }
    return { id, updated: NOW, directory: root };
  };
  const report = async () => {
    await new UsageReportService({ request: vi.fn() }, vi.fn()).openReport(true);
    const reply = asRecord(probe.replies.at(-1));
    const windows = reply?.windows;
    if (!Array.isArray(windows)) throw new Error('Missing aggregate reply');
    const groups = asRecord(windows.at(-1))?.groups;
    if (!Array.isArray(groups)) throw new Error('Missing aggregate groups');
    return { content: probe.content, groups };
  };
  const archive = () => {
    const db = new DatabaseSync(usageDatabasePaths().archivePath);
    databases.push(db);
    return db;
  };
  return { root, path, database, add, report, archive };
}

describe('preserved original usage timing', () => {
  it('retains all 62 timings across three live V2 sessions without the audited 22ms drift', async () => {
    const f = await fixture();
    const sessions = [f.add('parent', 15), f.add('child', 41), f.add('other', 6)];
    const messages = f.database
      .prepare("SELECT id,data FROM session_message WHERE type='assistant' ORDER BY session_id,seq")
      .all();
    messages.forEach((row, index) => {
      const duration = index === 61 ? 1_199_798 - 61 * 19_000 : 19_000;
      const completed = NOW - 30_000 + duration;
      f.database
        .prepare(
          "UPDATE message SET data=json_set(data,'$.time.created',?,'$.time.completed',?) WHERE id=?"
        )
        .run(NOW - 30_000, completed, String(row.id));
      f.database
        .prepare(
          "UPDATE session_message SET data=json_set(data,'$.time.created',?,'$.time.completed',?) WHERE id=?"
        )
        .run(NOW - 30_000, completed + (index < 22 ? 1 : 0), String(row.id));
    });
    const source = await readFile(f.path);
    const before = await f.report();
    const csv = await readAllTimeUsageCsv();
    expect(before.groups).toMatchObject([{ durationMs: 1_199_798 }]);
    expect(await preserveOriginalUsageTiming(sessions)).toEqual({ sessions: 3, messages: 62 });
    expect((await readFile(f.path)).equals(source)).toBe(true);
    const archive = f.archive();
    expect(archive.prepare('SELECT count(*) AS n FROM usage_original_timing').get()?.n).toBe(62);
    for (const table of ['usage_session', 'usage_message', 'usage_cleanup', 'usage_artifact'])
      expect(archive.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
    f.database.exec('DELETE FROM message; DELETE FROM session;');
    expect(await f.report()).toEqual(before);
    expect(await readAllTimeUsageCsv()).toEqual(csv);
    expect(f.database.prepare('SELECT count(*) AS n FROM session_v2').get()?.n).toBe(3);
  });

  it('reads version-zero archives without migrating them, then adds timing storage without replacing usage', async () => {
    const f = await fixture();
    const session = f.add();
    await archiveSessionUsage([session]);
    const archive = f.archive();
    archive.exec('DROP TABLE usage_original_timing; PRAGMA user_version=0;');
    const rows = archive.prepare('SELECT * FROM usage_message ORDER BY id').all();
    const bytes = await readFile(usageDatabasePaths().archivePath);
    await f.report();
    await readAllTimeUsageCsv();
    expect((await readFile(usageDatabasePaths().archivePath)).equals(bytes)).toBe(true);
    await preserveOriginalUsageTiming([session]);
    expect(archive.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(archive.prepare('SELECT * FROM usage_message ORDER BY id').all()).toEqual(rows);
  });

  it('is idempotent and serializes concurrent preservation without duplicating rows', async () => {
    const f = await fixture();
    const session = f.add();
    expect(
      await Promise.all([
        preserveOriginalUsageTiming([session]),
        preserveOriginalUsageTiming([session]),
      ])
    ).toEqual([
      { sessions: 1, messages: 2 },
      { sessions: 1, messages: 2 },
    ]);
    expect(f.archive().prepare('SELECT count(*) AS n FROM usage_original_timing').get()?.n).toBe(2);
  });

  it('rejects changed sessions or an unreadable later session before writing any preservation batch', async () => {
    const f = await fixture();
    const session = f.add();
    await expect(preserveOriginalUsageTiming([{ ...session, updated: NOW - 1 }])).rejects.toThrow(
      'Sessions changed'
    );
    await expect(
      preserveOriginalUsageTiming([session, { ...session, id: 'missing' }])
    ).rejects.toThrow('Sessions changed');
    await expect(stat(usageDatabasePaths().archivePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back new rows when another preserved timestamp conflicts', async () => {
    const f = await fixture();
    const existing = f.add();
    await preserveOriginalUsageTiming([existing]);
    const archive = f.archive();
    const rows = archive.prepare('SELECT * FROM usage_original_timing ORDER BY message_id').all();
    const added = f.add('new');
    f.database
      .prepare("UPDATE message SET data=json_set(data,'$.time.completed',?) WHERE session_id=?")
      .run(NOW - 7_000, existing.id);
    await expect(preserveOriginalUsageTiming([added, existing])).rejects.toThrow(
      'Conflicting original usage timing'
    );
    expect(
      archive.prepare('SELECT * FROM usage_original_timing ORDER BY message_id').all()
    ).toEqual(rows);
    await expect(f.report()).rejects.toThrow('Conflicting original usage timing');
  });

  it('does not start preservation when cancelled', async () => {
    const f = await fixture();
    const session = f.add();
    const controller = new AbortController();
    controller.abort();
    await expect(
      preserveOriginalUsageTiming([session], undefined, controller.signal)
    ).rejects.toThrow();
    await expect(stat(usageDatabasePaths().archivePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits for a cancelled worker and leaves either a complete timing batch or none', async () => {
    const f = await fixture();
    const session = f.add('cancel', 1000);
    const source = await readFile(f.path);
    const controller = new AbortController();
    await expect(
      preserveOriginalUsageTiming([session], () => controller.abort(), controller.signal)
    ).rejects.toThrow('cancelled');
    expect((await readFile(f.path)).equals(source)).toBe(true);
    try {
      const metadata = await stat(usageDatabasePaths().archivePath);
      if (metadata.size === 0) return;
      const archive = new DatabaseSync(usageDatabasePaths().archivePath, { readOnly: true });
      databases.push(archive);
      const table = archive
        .prepare("SELECT name FROM sqlite_master WHERE name='usage_original_timing'")
        .get();
      if (table)
        expect(archive.prepare('SELECT count(*) AS n FROM usage_original_timing').get()?.n).toBe(
          1000
        );
      else expect(archive.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
    } catch (error) {
      // Cancellation may precede archive creation entirely.
      if (asRecord(error)?.code !== 'ENOENT') throw error;
    }
  });

  it.each(['role', 'session', 'provider', 'created', 'completion'])(
    'does not preserve unmatched V1 %s data',
    async (field) => {
      const f = await fixture();
      const session = f.add();
      if (field === 'session') f.database.exec("UPDATE message SET session_id='unrelated'");
      else {
        const path =
          field === 'role'
            ? '$.role'
            : field === 'provider'
              ? '$.providerID'
              : field === 'created'
                ? '$.time.created'
                : '$.time.completed';
        f.database
          .prepare('UPDATE message SET data=json_set(data,?,?)')
          .run(path, field === 'created' || field === 'completion' ? 0 : 'unrelated');
      }
      await expect(preserveOriginalUsageTiming([session])).rejects.toThrow(
        'No matching original usage timing'
      );
      await expect(stat(usageDatabasePaths().archivePath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  );

  it.each(['created', 'provider', 'model', 'identity'])(
    'rejects saved timing for a mismatched live %s',
    async (field) => {
      const f = await fixture();
      const session = f.add();
      await preserveOriginalUsageTiming([session]);
      f.database.exec('DELETE FROM message; DELETE FROM session;');
      if (field === 'identity')
        f.database.exec(
          "UPDATE session_v2 SET metadata='{" +
            '"varroLegacyImport":{"sourceSessionID":"different"}' +
            "}'"
        );
      else {
        const path =
          field === 'created'
            ? '$.time.created'
            : field === 'provider'
              ? '$.model.providerID'
              : '$.model.id';
        f.database
          .prepare("UPDATE session_message SET data=json_set(data,?,?) WHERE type='assistant'")
          .run(path, field === 'created' ? NOW - 9_000 : 'different');
      }
      expect((await f.report()).groups).toMatchObject([
        { durationMs: field === 'created' ? 18_000 : 20_000 },
      ]);
    }
  );

  it('keeps daily CSV attribution at the original completion day across midnight', async () => {
    const f = await fixture();
    const session = f.add();
    const midnight = Date.UTC(2026, 9, 29);
    f.database
      .prepare("UPDATE message SET data=json_set(data,'$.time.created',?,'$.time.completed',?)")
      .run(midnight - 2_000, midnight - 1);
    f.database
      .prepare(
        "UPDATE session_message SET data=json_set(data,'$.time.created',?,'$.time.completed',?) WHERE type='assistant'"
      )
      .run(midnight - 2_000, midnight + 1);
    const before = await readAllTimeUsageCsv();
    await preserveOriginalUsageTiming([session]);
    f.database.exec('DELETE FROM message; DELETE FROM session;');
    expect(await readAllTimeUsageCsv()).toEqual(before);
    expect(before.csv).toContain('2026-10-28,provider,model,high,2,');
  });

  it('refreshes API fallback timing without changing session update times and isolates attach-only connections', async () => {
    const f = await fixture();
    const session = f.add();
    const request = vi.fn(async (_method: string, path: string) =>
      path.startsWith('/experimental/session')
        ? [{ id: session.id, directory: f.root, time: { updated: NOW } }]
        : f.database
            .prepare("SELECT id,data FROM session_message WHERE type='assistant' ORDER BY seq")
            .all()
            .map((row) => ({
              info: {
                ...asRecord(JSON.parse(String(row.data))),
                id: row.id,
                role: 'assistant',
                providerID: 'provider',
                modelID: 'model',
              },
            }))
    );
    const service = new UsageReportService(
      { request, isAttachOnly: false, apiVersion: 2 },
      vi.fn(),
      null
    );
    await service.openReport(true);
    expect(probe.content).toContain('| 20s |');
    await preserveOriginalUsageTiming([session]);
    f.database.exec('DELETE FROM message; DELETE FROM session;');
    await service.openReport(true);
    expect(probe.content).toContain('| 4s |');
    expect(request.mock.calls.filter(([, path]) => path.includes('/message'))).toHaveLength(2);
    f.archive().exec('PRAGMA user_version=99');
    await new UsageReportService(
      { request, isAttachOnly: true, apiVersion: 2 },
      vi.fn(),
      null
    ).openReport(true);
    expect(probe.content).toContain('| 20s |');
  });

  it('preserves mapped source identities and works when the V1 tables are gone', async () => {
    const f = await fixture();
    const session = f.add('copy', 2, 'source');
    await preserveOriginalUsageTiming([session]);
    f.database.exec('DROP TABLE message; DROP TABLE session;');
    expect((await f.report()).groups).toMatchObject([{ durationMs: 4_000 }]);
    expect((await readAllTimeUsageCsv()).csv).toContain(',provider,model,high,2,20,10,');
  });

  it('restores timing with the statistics sidecar under a custom database basename', async () => {
    const f = await fixture();
    const session = f.add();
    await preserveOriginalUsageTiming([session]);
    f.database.exec('DELETE FROM message; DELETE FROM session;');
    const before = await readAllTimeUsageCsv();
    const restored = join(f.root, 'restored.sqlite');
    await copyFile(f.path, restored);
    await copyFile(usageDatabasePaths().archivePath, join(f.root, 'restored-stats.db'));
    vi.stubEnv('OPENCODE_DB', restored);
    expect(await readAllTimeUsageCsv()).toEqual(before);
    expect((await f.report()).groups).toMatchObject([{ durationMs: 4_000 }]);
  });

  it('keeps unadjusted originals and reapplies changed pause boundaries after V1 deletion', async () => {
    const f = await fixture();
    const session = f.add();
    const state = new OpenCodeV2SessionState();
    await state.update(session.id, {
      metadata: { varro: { pauses: [{ messageId: 'live-0', pausedAt: NOW - 9_000 }] } },
    });
    await preserveOriginalUsageTiming([session]);
    f.database.exec('DELETE FROM message; DELETE FROM session;');
    expect((await f.report()).groups).toMatchObject([{ durationMs: 3_000 }]);
    expect(
      f
        .archive()
        .prepare("SELECT time_completed FROM usage_original_timing WHERE message_id='live-0'")
        .get()?.time_completed
    ).toBe(NOW - 8_000);
    await state.update(session.id, {
      metadata: { varro: { pauses: [{ messageId: 'live-0', pausedAt: NOW - 9_500 }] } },
    });
    expect((await f.report()).groups).toMatchObject([{ durationMs: 2_500 }]);
  });

  it('survives archive replacement and never hides new live V2 usage behind its archive', async () => {
    const f = await fixture();
    const session = f.add();
    await preserveOriginalUsageTiming([session]);
    await archiveSessionUsage([session]);
    await archiveSessionUsage([session]);
    f.database.exec('DELETE FROM message; DELETE FROM session;');
    f.database
      .prepare(
        "UPDATE session_message SET data=json_set(data,'$.tokens.output',25) WHERE type='assistant'"
      )
      .run();
    f.database.prepare('UPDATE session_v2 SET time_updated=?').run(NOW + 1);
    expect((await f.report()).groups).toMatchObject([{ durationMs: 4_000, total: 70, output: 50 }]);
    await archiveSessionUsage([{ ...session, updated: NOW + 1 }]);
    expect(f.archive().prepare('SELECT count(*) AS n FROM usage_original_timing').get()?.n).toBe(2);
    f.database.exec('DELETE FROM session_message; DELETE FROM session_v2;');
    expect((await f.report()).groups).toMatchObject([{ durationMs: 4_000, total: 70 }]);
  });

  it.each(['future', 'missing', 'invalid', 'layout'])(
    'fails closed for %s timing storage without reader writes',
    async (failure) => {
      const f = await fixture();
      const session = f.add();
      await preserveOriginalUsageTiming([session]);
      const archive = f.archive();
      if (failure === 'future') archive.exec('PRAGMA user_version=99');
      else if (failure === 'missing') archive.exec('DROP TABLE usage_original_timing');
      else if (failure === 'layout')
        archive.exec('ALTER TABLE usage_original_timing ADD COLUMN unexpected TEXT');
      else archive.exec('UPDATE usage_original_timing SET time_completed=-1');
      const bytes = await readFile(usageDatabasePaths().archivePath);
      await expect(f.report()).rejects.toThrow(/schema|timing/);
      await expect(readAllTimeUsageCsv()).rejects.toThrow(/schema|timing/);
      await expect(preserveOriginalUsageTiming([session])).rejects.toThrow(/schema|timing/);
      expect((await readFile(usageDatabasePaths().archivePath)).equals(bytes)).toBe(true);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'refuses an archive path linked to the live database',
    async () => {
      const f = await fixture();
      const session = f.add();
      const source = await readFile(f.path);
      await symlink(f.path, usageDatabasePaths().archivePath);
      await expect(preserveOriginalUsageTiming([session])).rejects.toThrow(
        'regular file without links'
      );
      await rm(usageDatabasePaths().archivePath);
      await link(f.path, usageDatabasePaths().archivePath);
      await expect(preserveOriginalUsageTiming([session])).rejects.toThrow(
        'regular file without links'
      );
      expect((await readFile(f.path)).equals(source)).toBe(true);
    }
  );
});
