/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Mock only VS Code UI and the opaque server request boundary; cleanup uses real isolated SQLite databases, workers, locks, and files. */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenCodeRequestOptions } from './open-code-transport';
import type { OpenCodeApiVersion } from './opencode-connection';
import { SessionCleanupService } from './session-cleanup-service';
import {
  archiveSessionUsage,
  cleanupLegacySessionRecords,
  readLegacyCleanupSessions,
  readPendingUsageCleanup,
  UsageReportService,
} from './usage-report-service';
import { usageDatabasePaths } from './usage-database-paths';

const ui = vi.hoisted(() => ({
  input: vi.fn<() => Promise<string | undefined>>(async () => '6'),
  pick: vi.fn<() => Promise<{ preserve: boolean } | undefined>>(async () => ({ preserve: false })),
  confirm: vi.fn(async () => 'Delete old sessions'),
  error: vi.fn(),
  info: vi.fn(),
  report: vi.fn(),
  log: vi.fn(),
  showOutput: vi.fn(),
  cancelled: false,
  content: '',
}));
const cancellation = vi.hoisted(() => ({ listeners: new Set<() => void>(), dispose: vi.fn() }));
vi.mock('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  commands: { executeCommand: vi.fn() },
  workspace: {
    openTextDocument: async (options: { content: string }) => {
      ui.content = options.content;
      return { uri: 'untitled:stats' };
    },
  },
  window: {
    createOutputChannel: () => ({ appendLine: ui.log, show: ui.showOutput }),
    showInputBox: ui.input,
    showQuickPick: ui.pick,
    showWarningMessage: ui.confirm,
    showErrorMessage: ui.error,
    showInformationMessage: ui.info,
    showTextDocument: vi.fn(),
    withProgress: async (
      _options: unknown,
      task: (
        progress: { report: typeof ui.report },
        token: {
          isCancellationRequested: boolean;
          onCancellationRequested: (listener: () => void) => { dispose: () => void };
        }
      ) => Promise<unknown>
    ) =>
      task(
        { report: ui.report },
        {
          get isCancellationRequested() {
            return ui.cancelled;
          },
          onCancellationRequested: (listener) => {
            cancellation.listeners.add(listener);
            return {
              dispose: () => {
                cancellation.listeners.delete(listener);
                cancellation.dispose();
              },
            };
          },
        }
      ),
  },
}));

const NOW = Date.UTC(2026, 9, 31, 12);
const OLD = Date.UTC(2025, 0, 1);
const directories: string[] = [];
const databases: DatabaseSync[] = [];
type CleanupFixtureControls = {
  pageSize: number;
  beforeDelete: (id: string) => void;
  beforeGet: (id: string) => void;
  repeatCursor: boolean;
  acknowledgeOnly: boolean;
  unavailableDirectories: Set<string>;
  loadedDirectories: string[] | undefined;
  confirmError: string | undefined;
  malformedActive: boolean;
  statusDirectories: Map<string, string>;
  beforeHistory: (id: string) => void;
};
beforeEach(() => {
  vi.clearAllMocks();
  ui.report.mockReset();
  ui.info.mockReset();
  ui.error.mockReset();
  ui.input.mockResolvedValue('6');
  ui.pick.mockResolvedValue({ preserve: false });
  ui.confirm.mockResolvedValue('Delete old sessions');
  ui.cancelled = false;
  cancellation.listeners.clear();
  ui.content = '';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture(version = 2) {
  const parent = resolve('artifacts/ai-test-data');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'session-cleanup-'));
  directories.push(root);
  vi.stubEnv('OPENCODE_DB', join(root, 'opencode.db'));
  vi.stubEnv('XDG_DATA_HOME', root);
  vi.stubEnv('VARRO_TEST_STATE_ROOT', join(root, 'varro-state'));
  vi.stubEnv('TMPDIR', root);
  vi.stubEnv('TEMP', root);
  vi.stubEnv('TMP', root);
  const database = new DatabaseSync(usageDatabasePaths().databasePath);
  databases.push(database);
  const sessionTable = version === 1 ? 'session' : 'session_v2';
  const messageTable = version === 1 ? 'message' : 'session_message';
  database.exec(`CREATE TABLE ${sessionTable} (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER, metadata TEXT);
    CREATE TABLE ${messageTable} (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
    CREATE INDEX message_session_idx ON ${messageTable}(session_id);`);
  type Session = {
    id: string;
    directory: string;
    parentID?: string;
    time: { created: number; updated: number };
  };
  const sessions = new Map<string, Session>();
  const statuses: Record<string, { type: string; backgroundServices?: number }> = {};
  const deleted: string[] = [];
  const transcripts = new Map<string, unknown[]>();
  const inboxes = new Map<string, unknown[]>();
  const controls: CleanupFixtureControls = {
    pageSize: 1_000,
    beforeDelete: (_id: string) => {},
    beforeGet: (_id: string) => {},
    repeatCursor: false,
    acknowledgeOnly: false,
    unavailableDirectories: new Set<string>(),
    loadedDirectories: undefined,
    confirmError: undefined,
    malformedActive: false,
    statusDirectories: new Map(),
    beforeHistory: (_id: string) => {},
  };
  const add = async (id: string, updated = OLD, project = 'project-a', parentID?: string) => {
    const directory = join(root, project);
    await mkdir(directory, { recursive: true });
    const session: Session = { id, directory, parentID, time: { created: OLD, updated } };
    sessions.set(id, session);
    database
      .prepare(`INSERT INTO ${sessionTable} VALUES (?, ?, ?, NULL)`)
      .run(id, directory, updated);
    database.prepare(`INSERT INTO ${messageTable} VALUES (?, ?, 'assistant', 1, ?)`).run(
      `${id}-reply`,
      id,
      JSON.stringify({
        role: 'assistant',
        parentID: `${id}-prompt`,
        providerID: 'provider',
        modelID: 'model',
        time: { created: updated - 2_000, completed: updated },
        tokens: { input: 10, output: 5 },
      })
    );
    return session;
  };
  const remove = (id: string) => {
    for (const child of [...sessions.values()].filter((session) => session.parentID === id))
      remove(child.id);
    sessions.delete(id);
    database.prepare(`DELETE FROM ${messageTable} WHERE session_id = ?`).run(id);
    database.prepare(`DELETE FROM ${sessionTable} WHERE id = ?`).run(id);
  };
  const request = vi.fn(
    async (
      method: string,
      path: string,
      _body?: unknown,
      options?: OpenCodeRequestOptions
    ): Promise<unknown> => {
      const url = new URL(path, 'http://fixture');
      expect(options?.unscoped).toBe(true);
      const directory =
        url.searchParams.get('directory') ?? url.searchParams.get('location[directory]');
      if (directory && controls.unavailableDirectories.has(directory))
        throw new Error(`404 Location not found: ${directory}`);
      if (url.pathname === '/api/session/active' && controls.malformedActive) return { data: null };
      if (url.pathname === '/api/session/active')
        return {
          data: Object.fromEntries(
            Object.entries(statuses)
              .filter(([, status]) => status.type !== 'idle')
              .map(([id]) => [id, { type: 'running' }])
          ),
        };
      if (url.pathname === '/api/debug/location')
        return (
          controls.loadedDirectories ?? [
            ...new Set([...sessions.values()].map((session) => session.directory)),
          ]
        ).map((loadedDirectory) => ({ directory: loadedDirectory }));
      if (url.pathname === '/experimental/session') {
        expect(url.searchParams.get('directory')).toBeNull();
        expect(url.searchParams.get('archived')).toBe('true');
        const start = Number(url.searchParams.get('cursor') ?? 0);
        const all = [...sessions.values()];
        return {
          data: structuredClone(all.slice(start, start + controls.pageSize)),
          nextCursor: controls.repeatCursor
            ? '1'
            : start + controls.pageSize < all.length
              ? String(start + controls.pageSize)
              : undefined,
        };
      }
      if (url.pathname === '/session/status')
        return structuredClone(
          Object.fromEntries(
            Object.entries(statuses).filter(
              ([id]) =>
                !controls.statusDirectories.has(id) ||
                controls.statusDirectories.get(id) === directory
            )
          )
        );
      const history = /^\/(?:api\/)?session\/([^/]+)\/message$/.exec(url.pathname);
      if (history) {
        const historyID = decodeURIComponent(history[1]!);
        controls.beforeHistory(historyID);
        const messages = transcripts.get(historyID) ?? [];
        if (version === 1) return messages;
        const start = Number(url.searchParams.get('cursor') ?? 0);
        const ordered = messages.toReversed();
        return {
          data: ordered.slice(start, start + 2),
          cursor: {
            previous: start < ordered.length ? `previous-${start}` : null,
            next: start < ordered.length ? String(Math.min(start + 2, ordered.length)) : null,
          },
        };
      }
      const inbox = /^\/api\/session\/([^/]+)\/inbox$/.exec(url.pathname);
      if (inbox) return { data: inboxes.get(decodeURIComponent(inbox[1]!)) ?? [] };
      const match = /^\/session\/([^/]+)(\/children)?$/.exec(url.pathname);
      if (!match) throw new Error(`Unexpected fixture request ${path}`);
      const id = decodeURIComponent(match[1]!);
      if (match[2])
        return structuredClone([...sessions.values()].filter((session) => session.parentID === id));
      if (method === 'GET') {
        controls.beforeGet(id);
        const session = sessions.get(id);
        if (!session) throw new Error(controls.confirmError ?? '404 Session not found');
        return structuredClone(session);
      }
      if (method !== 'DELETE') throw new Error(`Unexpected fixture method ${method}`);
      controls.beforeDelete(id);
      deleted.push(id);
      if (!controls.acknowledgeOnly) remove(id);
      return true;
    }
  );
  const apiVersion: OpenCodeApiVersion = version === 2 ? 2 : 1;
  const offline = vi.fn();
  const restored = vi.fn();
  const server = {
    request,
    isAttachOnly: false,
    apiVersion,
    async withStoppedServer<T>(operation: () => Promise<T>): Promise<T> {
      offline();
      try {
        return await operation();
      } finally {
        restored();
      }
    },
  };
  const start = vi.fn(async () => undefined);
  const service = new SessionCleanupService(server, start);
  const attachReferences = (id: string, values: string[]) =>
    database
      .prepare(
        `UPDATE ${messageTable} SET data = json_set(data, '$.files', json(?)) WHERE session_id = ?`
      )
      .run(JSON.stringify(values.map((url) => ({ url }))), id);
  return {
    root,
    database,
    sessionTable,
    messageTable,
    add,
    remove,
    sessions,
    statuses,
    deleted,
    transcripts,
    inboxes,
    controls,
    request,
    server,
    start,
    service,
    attachReferences,
    offline,
    restored,
  };
}

function expectStopped(reason: string): void {
  expect(ui.error).toHaveBeenCalledWith(
    expect.stringContaining('Cleanup stopped while'),
    'Show details'
  );
  expect(ui.log).toHaveBeenCalledWith(expect.stringContaining(reason));
}

async function addLegacy(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  updated = OLD,
  parentID?: string
) {
  const directory = join(f.root, 'legacy-project');
  await mkdir(directory, { recursive: true });
  f.database
    .exec(`CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY,directory TEXT,title TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER,revert TEXT);
    CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY,session_id TEXT REFERENCES session(id) ON DELETE CASCADE,time_created INTEGER,data TEXT);
    CREATE INDEX IF NOT EXISTS legacy_message_session_idx ON message(session_id);
    CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY,message_id TEXT REFERENCES message(id) ON DELETE CASCADE,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE INDEX IF NOT EXISTS legacy_part_session_idx ON part(session_id);`);
  f.database
    .prepare('INSERT INTO session VALUES (?,?,?,?,?,?,NULL)')
    .run(id, directory, `Legacy ${id}`, parentID ?? null, OLD, updated);
  const insert = f.database.prepare('INSERT INTO message VALUES (?,?,?,?)');
  insert.run(
    `${id}-prompt`,
    id,
    OLD - 3000,
    JSON.stringify({ role: 'user', time: { created: OLD - 3000 } })
  );
  insert.run(
    `${id}-reply`,
    id,
    OLD - 2000,
    JSON.stringify({
      role: 'assistant',
      parentID: `${id}-prompt`,
      providerID: 'provider',
      modelID: 'model',
      finish: 'stop',
      time: { created: OLD - 2000, completed: OLD - 1000 },
      tokens: { input: 10, output: 5 },
    })
  );
  const part = f.database.prepare('INSERT INTO part VALUES (?,?,?,?,?)');
  part.run(
    `${id}-text-prompt`,
    `${id}-prompt`,
    id,
    OLD - 3000,
    JSON.stringify({ type: 'text', text: 'Original legacy prompt' })
  );
  part.run(
    `${id}-text-reply`,
    `${id}-reply`,
    id,
    OLD - 2000,
    JSON.stringify({ type: 'text', text: 'Final legacy response' })
  );
}

describe('global session cleanup', () => {
  it('includes dormant V1 and V2 records in the same confirmed command and archives both before deletion', async () => {
    const f = await fixture();
    await f.add('native');
    await addLegacy(f, 'legacy');
    await f.service.run();
    expect(ui.error, JSON.stringify(ui.log.mock.calls)).not.toHaveBeenCalled();
    expect(ui.confirm).toHaveBeenCalledWith(
      expect.stringContaining('including 1 legacy V1 records'),
      { modal: true },
      'Delete old sessions'
    );
    expect(f.deleted).toEqual(['native']);
    expect(f.database.prepare('SELECT count(*) AS n FROM session').get()?.n).toBe(0);
    expect(f.database.prepare('SELECT count(*) AS n FROM message').get()?.n).toBe(0);
    expect(f.database.prepare('SELECT count(*) AS n FROM part').get()?.n).toBe(0);
    expect(f.offline).toHaveBeenCalledOnce();
    expect(f.restored).toHaveBeenCalledOnce();
    expect(ui.info).toHaveBeenCalledWith(
      'Cleanup complete. 2 sessions deleted; 0 kept. Usage statistics saved.',
      'Show details'
    );
    const archive = new DatabaseSync(usageDatabasePaths().archivePath, { readOnly: true });
    try {
      expect(archive.prepare('SELECT count(*) AS n FROM usage_session').get()?.n).toBe(2);
    } finally {
      archive.close();
    }
  });

  it('preserves original V2 timing before deleting its dormant V1 source, without changing the live V2 session', async () => {
    const f = await fixture();
    await f.add('shared', NOW);
    await addLegacy(f, 'shared');
    f.database
      .prepare(
        "UPDATE session_message SET data=json_set(data,'$.time.created',?,'$.time.completed',?)"
      )
      .run(OLD - 2000, OLD + 5000);
    const before = f.database.prepare('SELECT * FROM session_v2').all();
    const messages = f.database.prepare('SELECT * FROM session_message').all();
    const attachments = join(f.root, 'project-a', '.opencode', 'attachments', 'shared');
    await mkdir(attachments, { recursive: true });
    await writeFile(join(attachments, 'keep.txt'), 'Retained V2 copy');
    await f.service.run();
    expect(ui.error, JSON.stringify(ui.log.mock.calls)).not.toHaveBeenCalled();
    expect(f.deleted).toEqual([]);
    expect(f.database.prepare('SELECT count(*) AS n FROM session').get()?.n).toBe(0);
    expect(f.database.prepare('SELECT * FROM session_v2').all()).toEqual(before);
    expect(f.database.prepare('SELECT * FROM session_message').all()).toEqual(messages);
    expect(await readFile(join(attachments, 'keep.txt'), 'utf8')).toBe('Retained V2 copy');
    const archive = new DatabaseSync(usageDatabasePaths().archivePath, { readOnly: true });
    try {
      expect(
        archive
          .prepare(
            "SELECT time_completed FROM usage_original_timing WHERE message_id='shared-reply'"
          )
          .get()?.time_completed
      ).toBe(OLD - 1000);
    } finally {
      archive.close();
    }
    await new UsageReportService({ request: vi.fn() }, vi.fn()).openReport(true);
    expect(ui.content).toContain('| provider | model | 1 | 15 | 1s |');
  });

  it('preserves local parent-only V1 transcripts and never asks V2 for dormant V1 history', async () => {
    const f = await fixture();
    await addLegacy(f, 'root');
    await addLegacy(f, 'child', OLD + 1, 'root');
    f.database.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run(
      'legacy-note',
      'root-prompt',
      'root',
      OLD - 2999,
      JSON.stringify({
        type: 'file',
        mime: 'text/plain',
        name: 'annotation-deadbeef.txt',
        data: Buffer.from('Original legacy annotation').toString('base64'),
      })
    );
    ui.pick.mockResolvedValue({ preserve: true });
    await f.service.run();
    expect(ui.error, JSON.stringify(ui.log.mock.calls)).not.toHaveBeenCalled();
    const archive = new DatabaseSync(join(f.root, 'opencode-transcripts.db'), { readOnly: true });
    try {
      expect(archive.prepare('SELECT id,source_version FROM transcript_session').all()).toEqual([
        { id: 'root', source_version: 1 },
      ]);
      const turns = archive.prepare('SELECT data FROM transcript_turn').all();
      expect(JSON.stringify(turns)).toContain('Original legacy prompt');
      expect(JSON.stringify(turns)).toContain('Final legacy response');
      expect(JSON.stringify(turns)).toContain('Original legacy annotation');
    } finally {
      archive.close();
    }
    expect(f.request.mock.calls.some(([, path]) => path.includes('/root/message'))).toBe(false);
  });

  it('keeps V1 parents with newer descendants while removing independent old V1 leaves', async () => {
    const f = await fixture();
    await addLegacy(f, 'parent');
    await addLegacy(f, 'recent', NOW, 'parent');
    await addLegacy(f, 'old-child', OLD + 1, 'parent');
    await f.service.run();
    expect(ui.error, JSON.stringify(ui.log.mock.calls)).not.toHaveBeenCalled();
    expect(f.database.prepare('SELECT id FROM session ORDER BY id').all()).toEqual([
      { id: 'parent' },
      { id: 'recent' },
    ]);
  });

  it('does not delete V1 history when the confirmation is declined', async () => {
    const f = await fixture();
    await addLegacy(f, 'legacy');
    ui.confirm.mockResolvedValue('Cancel');
    await f.service.run();
    expect(f.offline).not.toHaveBeenCalled();
    expect(f.database.prepare('SELECT count(*) AS n FROM session').get()?.n).toBe(1);
  });

  it('revalidates V1 timestamps and child membership after stopping the server', async () => {
    const f = await fixture();
    await addLegacy(f, 'legacy');
    f.offline.mockImplementation(() =>
      f.database.prepare('UPDATE session SET time_updated=?').run(NOW)
    );
    await f.service.run();
    expectStopped('Legacy sessions or their child membership changed');
    expect(f.restored).toHaveBeenCalledOnce();
    expect(f.database.prepare('SELECT count(*) AS n FROM session').get()?.n).toBe(1);
  });

  it('rolls back legacy deletion and restores the server when transcript preservation fails', async () => {
    const f = await fixture();
    await addLegacy(f, 'legacy');
    f.database.exec("UPDATE part SET data='invalid'");
    ui.pick.mockResolvedValue({ preserve: true });
    await f.service.run();
    expect(ui.error).toHaveBeenCalled();
    expect(f.restored).toHaveBeenCalledOnce();
    expect(f.database.prepare('SELECT count(*) AS n FROM session').get()?.n).toBe(1);
    expect(f.database.prepare('SELECT count(*) AS n FROM message').get()?.n).toBe(2);
  });

  it('rejects an unmatched local V2 inventory before confirming any legacy deletion', async () => {
    const f = await fixture();
    await f.add('native');
    await addLegacy(f, 'legacy');
    f.sessions.clear();
    await f.service.run();
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(f.offline).not.toHaveBeenCalled();
    expect(f.deleted).toEqual([]);
    expect(f.database.prepare('SELECT count(*) AS n FROM session').get()?.n).toBe(1);
  });

  it('keeps the database write lock through preparation and rolls back when preparation fails', async () => {
    const f = await fixture();
    await addLegacy(f, 'legacy');
    const sessions = await readLegacyCleanupSessions([]);
    f.database.exec('PRAGMA busy_timeout=1;');
    await expect(
      cleanupLegacySessionRecords(sessions, NOW - 1, {
        signal: new AbortController().signal,
        onProgress: () => {},
        committing: () => {},
        prepared: async () => {
          expect(() => f.database.exec("UPDATE session SET title='changed'")).toThrow('locked');
          throw new Error('Injected preparation failure');
        },
      })
    ).rejects.toThrow('Injected preparation failure');
    expect(f.database.prepare('SELECT title FROM session').get()?.title).toBe('Legacy legacy');
    expect(f.database.prepare('SELECT count(*) AS n FROM message').get()?.n).toBe(2);
  });

  it('cancels before legacy deletion and restores the server without removing V1 records', async () => {
    const f = await fixture();
    await addLegacy(f, 'legacy');
    f.offline.mockImplementation(() => {
      ui.cancelled = true;
    });
    await f.service.run();
    expect(f.restored).toHaveBeenCalledOnce();
    expect(ui.error).not.toHaveBeenCalled();
    expect(f.database.prepare('SELECT count(*) AS n FROM session').get()?.n).toBe(1);
  });

  it('does not interrupt a dispatched legacy transaction when cancellation arrives', async () => {
    const f = await fixture();
    await addLegacy(f, 'legacy');
    const controller = new AbortController();
    const sessions = await readLegacyCleanupSessions([]);
    await expect(
      cleanupLegacySessionRecords(sessions, NOW - 1, {
        signal: controller.signal,
        onProgress: () => {},
        prepared: async () => {},
        committing: () => controller.abort(),
      })
    ).resolves.toBe(1);
    expect(f.database.prepare('SELECT count(*) AS n FROM session').get()?.n).toBe(0);
  });

  it('refuses legacy deletion triggers rather than risking live V2 records', async () => {
    const f = await fixture();
    await f.add('retained', NOW);
    await addLegacy(f, 'legacy');
    f.database.exec(
      'CREATE TRIGGER unexpected_legacy_delete AFTER DELETE ON session BEGIN DELETE FROM session_message; END;'
    );
    await f.service.run();
    expectStopped('Unsupported legacy deletion triggers');
    expect(f.database.prepare('SELECT count(*) AS n FROM session').get()?.n).toBe(1);
    expect(f.database.prepare('SELECT count(*) AS n FROM session_message').get()?.n).toBe(1);
  });

  it('keeps an already saved newer V2 parent transcript while removing its legacy duplicate', async () => {
    const f = await fixture();
    await f.add('same', OLD + 100);
    await addLegacy(f, 'same');
    f.database.exec("UPDATE session SET revert='{}'");
    f.transcripts.set('same', [
      { id: 'prompt', type: 'user', text: 'V2 prompt', time: { created: OLD - 10 } },
      {
        id: 'answer',
        type: 'assistant',
        content: [{ type: 'text', text: 'V2 final response' }],
        finish: 'stop',
        time: { created: OLD - 5, completed: OLD + 100 },
      },
    ]);
    ui.pick.mockResolvedValue({ preserve: true });
    await f.service.run();
    expect(ui.error, JSON.stringify(ui.log.mock.calls)).not.toHaveBeenCalled();
    const archive = new DatabaseSync(join(f.root, 'opencode-transcripts.db'), { readOnly: true });
    try {
      expect(
        archive.prepare('SELECT source_version FROM transcript_session').get()?.source_version
      ).toBe(2);
      expect(JSON.stringify(archive.prepare('SELECT data FROM transcript_turn').all())).toContain(
        'V2 final response'
      );
    } finally {
      archive.close();
    }
    expect(f.database.prepare('SELECT count(*) AS n FROM session').get()?.n).toBe(0);
  });

  it.skipIf(process.platform === 'win32')(
    'retains both V1 and V2 attachment-root provenance across a failed cleanup and retry',
    async () => {
      const f = await fixture();
      await f.add('same', OLD + 100);
      await addLegacy(f, 'same');
      const native = join(f.root, 'project-a', '.opencode', 'attachments', 'same');
      const legacy = join(f.root, 'legacy-project', '.opencode', 'attachments', 'same');
      const external = join(f.root, 'external');
      await mkdir(native, { recursive: true });
      await writeFile(join(native, 'owned.txt'), 'Native copy');
      await mkdir(dirname(legacy), { recursive: true });
      await mkdir(external);
      await writeFile(join(external, 'original.txt'), 'Keep original');
      await symlink(external, legacy);
      await f.service.run();
      expectStopped('symlink');
      expect(f.database.prepare('SELECT count(*) AS n FROM session').get()?.n).toBe(0);
      expect(f.sessions.size).toBe(0);
      await rm(legacy);
      await mkdir(legacy);
      await writeFile(join(legacy, 'owned.txt'), 'Legacy copy');
      ui.error.mockClear();
      await f.service.run();
      expect(ui.error, JSON.stringify(ui.log.mock.calls)).not.toHaveBeenCalled();
      await expect(readFile(join(native, 'owned.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(legacy, 'owned.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(external, 'original.txt'), 'utf8')).toBe('Keep original');
      expect(await readPendingUsageCleanup()).toEqual([]);
    }
  );
  it('shows a short completion with an explicit details action instead of archive paths', async () => {
    const f = await fixture();
    await f.add('old');
    ui.info.mockReturnValueOnce(Promise.resolve('Show details'));
    await f.service.run();
    expect(ui.info).toHaveBeenCalledWith(
      'Cleanup complete. 1 session deleted; 0 kept. Usage statistics saved.',
      'Show details'
    );
    expect(ui.showOutput).toHaveBeenCalledExactlyOnceWith(false);
    expect(ui.log).toHaveBeenCalledWith(expect.stringContaining(usageDatabasePaths().archivePath));
  });

  it('opens details for a stopped cleanup without starting another cleanup', async () => {
    const f = await fixture();
    await f.add('old');
    f.controls.beforeGet = () => {
      throw new Error('Injected lookup failure');
    };
    ui.error.mockReturnValueOnce(Promise.resolve('Show details'));
    await f.service.run();
    expectStopped('Injected lookup failure');
    expect(ui.showOutput).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.deleted).toEqual([]);
  });

  it('keeps technical worker errors in details rather than the stopped notification', async () => {
    const f = await fixture();
    await f.add('old');
    f.controls.beforeGet = () => {
      throw new Error(
        'Local worker timed out. Last phase: Checked artifact references in 34,734 rows; 876 names unresolved.'
      );
    };
    await f.service.run();
    const message = String(ui.error.mock.calls.at(-1)?.[0]);
    expect(message).toBe(
      'Cleanup stopped while processing sessions. No sessions were deleted. Unfinished work can be resumed.'
    );
    expect(message).not.toContain('Last phase:');
    expectStopped('876 names unresolved');
    expect(f.deleted).toEqual([]);
  });

  it('does not delay new deletions behind recovery and batches all confirmed-deleted artifact checks', async () => {
    const f = await fixture();
    const prior = await f.add('prior');
    const priorFiles = join(prior.directory, '.opencode', 'attachments', prior.id);
    await mkdir(priorFiles, { recursive: true });
    await writeFile(join(priorFiles, 'image.png'), 'prior copy');
    await archiveSessionUsage([{ id: prior.id, directory: prior.directory, updated: OLD }]);
    f.remove(prior.id);
    const first = await f.add('first');
    const second = await f.add('second', OLD + 1);
    for (const session of [first, second]) {
      const path = join(session.directory, '.opencode', 'attachments', session.id);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'image.png'), 'new copy');
    }
    f.controls.beforeDelete = () => {
      expect(ui.log.mock.calls.some(([line]) => String(line).includes('Cleanup 2/3:'))).toBe(false);
    };
    await f.service.run();
    expect(f.deleted).toEqual(['first', 'second']);
    const scans = ui.log.mock.calls.filter(([line]) => String(line).includes('Cleanup 2/3:'));
    expect(scans).toHaveLength(1);
    expect(ui.log).toHaveBeenCalledWith(expect.stringContaining('2 deleted'));
    expect(ui.report.mock.calls[0]?.[0].message).toContain('1/3 Sessions: 0/2 checked');
    await expect(readFile(join(priorFiles, 'image.png'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readPendingUsageCleanup()).toEqual([]);
    expect(ui.error).not.toHaveBeenCalled();
  });

  it('commits locally projected transcripts before deleting without downloading API history', async () => {
    const f = await fixture();
    await f.add('old');
    ui.pick.mockResolvedValue({ preserve: true });
    f.database.exec(`ALTER TABLE session_v2 ADD COLUMN fork_session_id TEXT;
      ALTER TABLE session_v2 ADD COLUMN revert TEXT;
      UPDATE session_message SET data = json_set(data, '$.content', json('[{"type":"text","text":"Saved final answer"}]'), '$.finish', 'stop');`);
    f.controls.beforeDelete = () => {
      const archive = new DatabaseSync(join(f.root, 'opencode-transcripts.db'), { readOnly: true });
      try {
        expect(archive.prepare('SELECT data FROM transcript_turn').get()?.data).toContain(
          'Saved final answer'
        );
      } finally {
        archive.close();
      }
    };
    await f.service.run();
    expect(f.deleted).toEqual(['old']);
    expect(f.request.mock.calls.some(([, path]) => path.includes('/message?'))).toBe(false);
    expect(ui.report).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('1/3 Sessions:'),
      })
    );
    expect(ui.error).not.toHaveBeenCalled();
  });

  it.each(['api', 'local'])(
    'cancels transcript-preserving cleanup during %s validation without deleting attachments',
    async (source) => {
      const f = await fixture();
      const session = await f.add('old');
      ui.pick.mockResolvedValue({ preserve: true });
      const attachment = join(
        session.directory,
        '.opencode',
        'attachments',
        session.id,
        'image.png'
      );
      await mkdir(dirname(attachment), { recursive: true });
      await writeFile(attachment, 'Keep this attachment');
      f.transcripts.set('old', [
        { id: 'prompt', type: 'user', text: 'Prompt', time: { created: OLD - 3000 } },
        {
          id: 'answer',
          type: 'assistant',
          content: [{ type: 'text', text: 'Answer' }],
          time: { created: OLD - 2000, completed: OLD },
          finish: 'stop',
        },
        { id: 'done', type: 'idle', outcome: 'succeeded' },
      ]);
      if (source === 'local') {
        f.database.exec(
          `ALTER TABLE session_v2 ADD COLUMN fork_session_id TEXT; ALTER TABLE session_v2 ADD COLUMN revert TEXT;
          UPDATE session_message SET data = json_set(data, '$.content', json('[{"type":"text","text":"Saved answer"}]'), '$.finish', 'stop');`
        );
      }
      const cancel = () => {
        ui.cancelled = true;
        for (const listener of cancellation.listeners) listener();
      };
      if (source === 'api') f.controls.beforeHistory = cancel;
      else {
        let reads = 0;
        f.controls.beforeGet = () => {
          if (++reads === 2) cancel();
        };
      }
      await f.service.run();
      expect(f.deleted).toEqual([]);
      expect(f.sessions.has('old')).toBe(true);
      expect(await readFile(attachment, 'utf8')).toBe('Keep this attachment');
      expect(ui.info).toHaveBeenCalledWith(
        expect.stringContaining('cancelled. 0 sessions deleted'),
        'Show details'
      );
      expect(ui.error).not.toHaveBeenCalled();
      expect(cancellation.dispose).toHaveBeenCalledOnce();
      expect(cancellation.listeners.size).toBe(0);
    }
  );

  it('cancels the transcript wizard before starting the server', async () => {
    const f = await fixture();
    ui.pick.mockResolvedValue(undefined);
    await f.service.run();
    expect(f.start).not.toHaveBeenCalled();
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(f.deleted).toEqual([]);
  });

  it('saves trimmed transcripts in a separate durable database before deleting the tree', async () => {
    const f = await fixture();
    await f.add('parent');
    await f.add('child', OLD + 1, 'project-b', 'parent');
    ui.pick.mockResolvedValue({ preserve: true });
    for (const id of ['parent', 'child'])
      f.transcripts.set(id, [
        { id: `${id}-prompt`, type: 'user', text: 'Keep this prompt', time: { created: OLD - 3 } },
        {
          id: `${id}-work`,
          type: 'assistant',
          content: [
            { type: 'text', text: 'Discard commentary' },
            { type: 'reasoning', text: 'Discard reasoning' },
          ],
          time: { created: OLD - 2, completed: OLD - 1 },
          finish: 'tool-calls',
        },
        {
          id: `${id}-reply`,
          type: 'assistant',
          content: [{ type: 'text', text: 'Keep final answer' }],
          time: { created: OLD - 1, completed: OLD },
          finish: 'stop',
        },
        { id: `${id}-idle`, type: 'idle', outcome: 'succeeded', time: { created: OLD } },
      ]);
    const archivePath = join(f.root, 'opencode-transcripts.db');
    f.controls.beforeDelete = () => {
      const archive = new DatabaseSync(archivePath, { readOnly: true });
      try {
        expect(
          archive.prepare('SELECT count(*) AS count FROM transcript_session').get()?.count
        ).toBe(1);
        const data = JSON.stringify(archive.prepare('SELECT data FROM transcript_turn').all());
        expect(data).toContain('Keep this prompt');
        expect(data).toContain('Keep final answer');
        expect(data).not.toContain('Discard');
      } finally {
        archive.close();
      }
    };
    await f.service.run();
    expect(ui.error).not.toHaveBeenCalled();
    expect(f.deleted).toEqual(['parent']);
    expect(ui.confirm).toHaveBeenCalledWith(
      expect.stringContaining(archivePath),
      { modal: true },
      'Delete old sessions'
    );
    expect(ui.log).toHaveBeenCalledWith(expect.stringContaining(archivePath));
    expect(ui.info).toHaveBeenCalledWith(
      expect.stringContaining('Usage and transcripts saved.'),
      'Show details'
    );
    await new UsageReportService(f.server, f.start).openReport(true);
    expect(ui.content).toContain('| **Total** |  | 2 | 30 | 4s |');
  });

  it('leaves sessions and owned attachments intact if transcript persistence fails', async () => {
    const f = await fixture();
    const old = await f.add('old');
    ui.pick.mockResolvedValue({ preserve: true });
    await mkdir(join(f.root, 'opencode-transcripts.db'));
    const copies = join(old.directory, '.opencode', 'attachments', old.id);
    await mkdir(copies, { recursive: true });
    await writeFile(join(copies, 'keep.txt'), 'keep');
    await f.service.run();
    expect(f.deleted).toEqual([]);
    expectStopped('Transcript archive failed');
    expect(await readFile(join(copies, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('does not read or create a transcript archive when preservation is declined', async () => {
    const f = await fixture();
    await f.add('old');
    await f.service.run();
    expect(f.deleted).toEqual(['old']);
    expect(f.request.mock.calls.some(([, path]) => path.includes('/message'))).toBe(false);
    await expect(readFile(join(f.root, 'opencode-transcripts.db'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps V2 sessions with undelivered input when preserving transcripts', async () => {
    const f = await fixture();
    await f.add('old');
    ui.pick.mockResolvedValue({ preserve: true });
    f.inboxes.set('old', [
      { id: 'pending', type: 'user', payload: { text: 'Do not discard my queued prompt' } },
    ]);
    await f.service.run();
    expect(ui.error).not.toHaveBeenCalled();
    expect(f.deleted).toEqual([]);
    expect(f.request.mock.calls.some(([, path]) => path.includes('/message'))).toBe(false);
  });

  it('rechecks session metadata after the transcript is durable', async () => {
    const f = await fixture();
    await f.add('old');
    ui.pick.mockResolvedValue({ preserve: true });
    let reads = 0;
    f.controls.beforeGet = () => {
      reads += 1;
      if (reads === 2) {
        f.sessions.get('old')!.time.updated = NOW;
        f.inboxes.set('old', [{ id: 'new-pending' }]);
      }
    };
    await f.service.run();
    expect(ui.error).not.toHaveBeenCalled();
    expect(f.deleted).toEqual([]);
    const archive = new DatabaseSync(join(f.root, 'opencode-transcripts.db'), { readOnly: true });
    try {
      expect(archive.prepare('SELECT id FROM transcript_session').get()?.id).toBe('old');
    } finally {
      archive.close();
    }
  });

  it('keeps new inbox work admitted while a transcript is being archived', async () => {
    const f = await fixture();
    await f.add('old');
    ui.pick.mockResolvedValue({ preserve: true });
    f.controls.beforeHistory = (id) => {
      f.inboxes.set(id, [{ id: 'new-work', type: 'user' }]);
    };
    await f.service.run();
    expect(ui.error).not.toHaveBeenCalled();
    expect(f.deleted).toEqual([]);
    expect(f.sessions.has('old')).toBe(true);
  });

  it('creates neither archive if transcript preservation is selected but confirmation is cancelled', async () => {
    const f = await fixture();
    await f.add('old');
    ui.pick.mockResolvedValue({ preserve: true });
    ui.confirm.mockResolvedValue('Cancel');
    await f.service.run();
    expect(f.deleted).toEqual([]);
    for (const path of [
      usageDatabasePaths().archivePath,
      join(f.root, 'opencode-transcripts.db'),
    ]) {
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('preserves transcripts from missing directories without initializing historical V2 locations', async () => {
    const f = await fixture();
    const old = await f.add('old');
    ui.pick.mockResolvedValue({ preserve: true });
    f.controls.loadedDirectories = [];
    f.controls.unavailableDirectories.add(old.directory);
    f.transcripts.set(old.id, [
      { id: 'prompt', type: 'user', text: 'Original prompt', time: { created: OLD - 2 } },
      {
        id: 'answer',
        type: 'assistant',
        content: [{ type: 'text', text: 'Final response' }],
        finish: 'stop',
        time: { created: OLD - 1, completed: OLD },
      },
    ]);
    await f.service.run();
    expect(ui.error).not.toHaveBeenCalled();
    expect(f.deleted).toEqual(['old']);
    expect(
      (await readFile(join(f.root, 'opencode-transcripts.db'))).includes(
        Buffer.from('Final response')
      )
    ).toBe(true);
  });

  it('preserves legacy transcript text through the V1 server API', async () => {
    const f = await fixture(1);
    await f.add('old');
    ui.pick.mockResolvedValue({ preserve: true });
    f.transcripts.set('old', [
      {
        info: { id: 'prompt', role: 'user', time: { created: OLD - 2 } },
        parts: [{ type: 'text', text: 'Original prompt' }],
      },
      {
        info: {
          id: 'answer',
          role: 'assistant',
          finish: 'stop',
          time: { created: OLD - 1, completed: OLD },
        },
        parts: [{ type: 'text', text: 'Final response' }],
      },
    ]);
    await f.service.run();
    expect(ui.error).not.toHaveBeenCalled();
    expect(f.deleted).toEqual(['old']);
    expect(
      (await readFile(join(f.root, 'opencode-transcripts.db'))).includes(
        Buffer.from('Original prompt')
      )
    ).toBe(true);
  });

  it('omits malformed subagent transcripts while preserving usage for the entire deletion tree', async () => {
    const f = await fixture();
    await f.add('parent');
    await f.add('child', OLD + 1, 'project-b', 'parent');
    ui.pick.mockResolvedValue({ preserve: true });
    f.transcripts.set('child', [{ id: 'malformed', type: 'assistant' }]);
    await f.service.run();
    expect(f.deleted).toEqual(['parent']);
    expect(f.sessions.size).toBe(0);
    expect(ui.error).not.toHaveBeenCalled();
    expect(f.request.mock.calls.some(([, path]) => path.includes('/child/message?'))).toBe(false);
    const archive = new DatabaseSync(usageDatabasePaths().archivePath, { readOnly: true });
    try {
      expect(archive.prepare('SELECT count(*) AS count FROM usage_session').get()?.count).toBe(2);
    } finally {
      archive.close();
    }
  });

  it('retries preserved transcripts after a delete failure without duplicate turns or statistics', async () => {
    const f = await fixture();
    await f.add('old');
    ui.pick.mockResolvedValue({ preserve: true });
    f.transcripts.set('old', [
      { id: 'prompt', type: 'user', text: 'Prompt', time: { created: OLD - 2 } },
      {
        id: 'answer',
        type: 'assistant',
        content: [{ type: 'text', text: 'Answer' }],
        finish: 'stop',
        time: { created: OLD - 1, completed: OLD },
      },
    ]);
    f.controls.beforeDelete = () => {
      throw new Error('Injected delete failure');
    };
    await f.service.run();
    expect(f.deleted).toEqual([]);
    f.controls.beforeDelete = () => {};
    await f.service.run();
    expect(f.deleted).toEqual(['old']);
    const archive = new DatabaseSync(join(f.root, 'opencode-transcripts.db'), { readOnly: true });
    try {
      expect(archive.prepare('SELECT count(*) AS count FROM transcript_turn').get()?.count).toBe(1);
    } finally {
      archive.close();
    }
    await new UsageReportService(f.server, f.start).openReport(true);
    expect(ui.content).toContain('| **Total** |  | 1 | 15 | 2s |');
  });

  it('deletes historical V2 sessions without resolving deleted project locations', async () => {
    const f = await fixture();
    const old = await f.add('missing-project');
    const healthy = await f.add('healthy-project', OLD + 1, 'project-b');
    await rm(old.directory, { recursive: true });
    f.controls.unavailableDirectories.add(old.directory);
    f.controls.loadedDirectories = [healthy.directory];
    await f.service.run();
    expect(ui.error).not.toHaveBeenCalled();
    expect(f.deleted).toEqual([old.id, healthy.id]);
    for (const [, path] of f.request.mock.calls) {
      const url = new URL(path, 'http://fixture');
      expect(url.searchParams.get('directory')).not.toBe(old.directory);
      expect(url.searchParams.get('location[directory]')).not.toBe(old.directory);
    }
    await new UsageReportService(f.server, f.start).openReport(true);
    expect(ui.content).toContain('from 2 sessions scanned');
    expect(ui.content).toContain('| **Total** |  | 2 | 30 | 4s |');
  });

  it('keeps a globally active V2 session even when its directory is unavailable', async () => {
    const f = await fixture();
    const old = await f.add('active-missing-project');
    f.controls.unavailableDirectories.add(old.directory);
    f.controls.loadedDirectories = [];
    f.statuses[old.id] = { type: 'busy' };
    await f.service.run();
    expect(ui.error).not.toHaveBeenCalled();
    expect(f.deleted).toEqual([]);
  });

  it('keeps sessions with background services in another loaded location', async () => {
    const f = await fixture();
    const old = await f.add('background-session');
    f.controls.loadedDirectories = [join(f.root, 'other-loaded-location')];
    f.controls.statusDirectories.set(old.id, f.controls.loadedDirectories[0]!);
    f.statuses[old.id] = { type: 'idle', backgroundServices: 1 };
    await f.service.run();
    expect(ui.error).not.toHaveBeenCalled();
    expect(f.deleted).toEqual([]);
    expect(f.request).toHaveBeenCalledWith(
      'GET',
      expect.stringContaining(encodeURIComponent('other-loaded-location')),
      undefined,
      expect.objectContaining({ unscoped: true })
    );
  });

  it('never treats a missing-location 404 as confirmation that a session was deleted', async () => {
    const f = await fixture();
    const old = await f.add('old');
    const copies = join(old.directory, '.opencode', 'attachments', old.id);
    await mkdir(copies, { recursive: true });
    await writeFile(join(copies, 'keep.png'), 'keep until deletion is confirmed');
    f.controls.confirmError = `404 Location not found: ${old.directory}`;
    await f.service.run();
    expectStopped('Location not found');
    expect(await readFile(join(copies, 'keep.png'), 'utf8')).toBe(
      'keep until deletion is confirmed'
    );
    expect(await readPendingUsageCleanup()).toHaveLength(1);
  });

  it.each(['activity', 'locations'])(
    'fails closed when the V2 %s snapshot is malformed',
    async (snapshot) => {
      const f = await fixture();
      await f.add('old');
      if (snapshot === 'activity') f.controls.malformedActive = true;
      else f.controls.loadedDirectories = ['relative-location'];
      await f.service.run();
      expect(f.deleted).toEqual([]);
      expectStopped('malformed');
    }
  );
  // This end-to-end fixture starts multiple SQLite workers and verifies real file deletion.
  it.each([1, 2])(
    'deletes V%i sessions globally in oldest-first order and preserves usage and original files',
    { timeout: 30_000 },
    async (version) => {
      const f = await fixture(version);
      const newer = await f.add('newer', OLD + 1, 'project-b');
      const oldest = await f.add('oldest', OLD, 'project-a');
      await f.add('recently-touched', NOW, 'project-c');
      f.controls.pageSize = 1;
      const copies = join(oldest.directory, '.opencode', 'attachments', oldest.id);
      await mkdir(copies, { recursive: true });
      await writeFile(join(copies, 'image.png'), 'temporary image');
      const external = join(f.root, 'original.png');
      const code = join(oldest.directory, 'source.ts');
      await writeFile(external, 'original');
      await writeFile(code, 'code');
      const tool = join(usageDatabasePaths().dataDirectory, 'tool-output', 'tool_123456789abc.png');
      await mkdir(dirname(tool), { recursive: true });
      await writeFile(tool, 'generated');
      const drop = join(f.root, 'varro-drops', 'drop-owned', `1-${'a'.repeat(32)}-pasted.png`);
      await mkdir(dirname(drop), { recursive: true });
      await writeFile(
        join(dirname(drop), '.varro-owner.json'),
        JSON.stringify({ version: 1, pid: process.pid, createdAt: OLD })
      );
      await writeFile(drop, 'pasted');
      f.attachReferences(oldest.id, [external, code, tool, drop]);
      f.controls.beforeDelete = (id) => {
        const archive = new DatabaseSync(usageDatabasePaths().archivePath, { readOnly: true });
        try {
          expect(archive.prepare('SELECT id FROM usage_session WHERE id = ?').get(id)?.id).toBe(id);
        } finally {
          archive.close();
        }
      };
      await f.service.run();
      expect(ui.error).not.toHaveBeenCalled();
      expect(f.deleted).toEqual([oldest.id, newer.id]);
      expect([...f.sessions.keys()]).toEqual(['recently-touched']);
      for (const path of [copies, tool, drop])
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(external, 'utf8')).toBe('original');
      expect(await readFile(code, 'utf8')).toBe('code');
      await new UsageReportService(f.server, f.start).openReport(true);
      expect(ui.content).toContain('from 3 sessions scanned');
      expect(ui.content).toContain('| **Total** |  | 3 | 45 | 6s |');
      expect(await readPendingUsageCleanup()).toEqual([]);
    }
  );

  it('archives an entire old child tree before the recursive server delete', async () => {
    const f = await fixture();
    await f.add('parent');
    await f.add('child', OLD + 1, 'other-project', 'parent');
    f.controls.beforeDelete = () => {
      const archive = new DatabaseSync(usageDatabasePaths().archivePath, { readOnly: true });
      try {
        expect(archive.prepare('SELECT count(*) AS count FROM usage_session').get()?.count).toBe(2);
      } finally {
        archive.close();
      }
    };
    await f.service.run();
    expect(ui.error).not.toHaveBeenCalled();
    expect(f.deleted).toEqual(['parent']);
    await new UsageReportService(f.server, f.start).openReport(true);
    expect(ui.content).toContain('from 2 sessions scanned');
    expect(ui.content).toContain('| **Total** |  | 2 | 30 | 4s |');
  });

  it('keeps parents with recent children and skips active or changed sessions', async () => {
    const f = await fixture();
    await f.add('parent');
    await f.add('recent-child', NOW, 'project-a', 'parent');
    await f.add('active', OLD + 1);
    await f.add('changed', OLD + 2);
    await f.add('safe', OLD + 3);
    f.statuses.active = { type: 'busy' };
    f.controls.beforeGet = (id) => {
      if (id === 'changed') f.sessions.get(id)!.time.updated = NOW;
    };
    await f.service.run();
    expect(ui.error).not.toHaveBeenCalled();
    expect(f.deleted).toEqual(['safe']);
    expect(f.sessions.has('parent')).toBe(true);
    expect(f.sessions.has('recent-child')).toBe(true);
  });

  it('stops on a failure, saves completed deletions, and can resume without double counting', async () => {
    const f = await fixture();
    await f.add('first');
    await f.add('second', OLD + 1);
    await f.add('third', OLD + 2);
    f.controls.beforeDelete = (id) => {
      if (id === 'second') throw new Error('Injected delete failure');
    };
    await f.service.run();
    expect(f.deleted).toEqual(['first']);
    expectStopped('Injected delete failure');
    f.controls.beforeDelete = () => {};
    await f.service.run();
    expect(f.deleted).toEqual(['first', 'second', 'third']);
    await new UsageReportService(f.server, f.start).openReport(true);
    expect(ui.content).toContain('| **Total** |  | 3 | 45 | 6s |');
  });

  it('cancels between durable deletion units without deleting later sessions', async () => {
    const f = await fixture();
    await f.add('first');
    await f.add('second', OLD + 1);
    f.controls.beforeDelete = () => {
      ui.cancelled = true;
    };
    await f.service.run();
    expect(f.deleted).toEqual(['first']);
    expect(ui.info).toHaveBeenCalledWith(expect.stringContaining('cancelled'), 'Show details');
    // File cleanup is batched after confirmed deletions, and can safely resume.
    expect(await readPendingUsageCleanup()).toMatchObject([{ id: 'first' }]);
  });

  it('recovers artifact cleanup after a crash and retains shared files until their last session is gone', async () => {
    const f = await fixture();
    const old = await f.add('old');
    const retained = await f.add('retained', NOW);
    const copies = join(old.directory, '.opencode', 'attachments', old.id);
    await mkdir(copies, { recursive: true });
    await writeFile(join(copies, 'image.png'), 'shared image');
    f.attachReferences(retained.id, [join(copies, 'image.png')]);
    await archiveSessionUsage([{ id: old.id, directory: old.directory, updated: OLD }]);
    f.remove(old.id);
    await f.service.run();
    expect(await readFile(join(copies, 'image.png'), 'utf8')).toBe('shared image');
    expect(await readPendingUsageCleanup()).toHaveLength(1);
    f.remove(retained.id);
    await f.service.run();
    await expect(readFile(join(copies, 'image.png'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readPendingUsageCleanup()).toEqual([]);
    expect(f.deleted).toEqual([]);
  });

  it('refuses artifact symlinks and leaves external data untouched', async () => {
    const f = await fixture();
    const session = await f.add('old');
    const original = join(f.root, 'external');
    await mkdir(original);
    await writeFile(join(original, 'keep.txt'), 'keep');
    await mkdir(join(session.directory, '.opencode'));
    await symlink(
      original,
      join(session.directory, '.opencode', 'attachments'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await f.service.run();
    expect(f.deleted).toEqual(['old']);
    expectStopped('artifact symlink');
    expect(await readFile(join(original, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await readPendingUsageCleanup()).toHaveLength(1);
  });

  it('refuses to delete when archiving fails or the server only acknowledges deletion', async () => {
    const f = await fixture();
    await f.add('old');
    f.database.prepare(`UPDATE ${f.messageTable} SET data = ?`).run('invalid json');
    await f.service.run();
    expect(f.deleted).toEqual([]);
    expectStopped('malformed history');
    f.database.prepare(`UPDATE ${f.messageTable} SET data = ?`).run('{}');
    f.controls.acknowledgeOnly = true;
    await f.service.run();
    expectStopped('did not confirm deletion');
    expect(f.sessions.has('old')).toBe(true);
  });

  it('uses calendar months, clamps end-of-month, and keeps the exact cutoff', async () => {
    const f = await fixture();
    const cutoff = Date.UTC(2026, 3, 30, 12);
    await f.add('before', cutoff - 1);
    await f.add('boundary', cutoff);
    await f.add('after', cutoff + 1);
    await f.service.run();
    expect(f.deleted).toEqual(['before']);
  });

  it.each(['0', '-1', '1.5', '1201', 'abc'])(
    'rejects invalid retention %s without starting the server',
    async (input) => {
      const f = await fixture();
      ui.input.mockResolvedValue(input);
      await f.service.run();
      expect(f.start).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
      expect(ui.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid retention'),
        'Show details'
      );
    }
  );

  it('does nothing when input or confirmation is cancelled and refuses attach-only servers', async () => {
    const f = await fixture();
    ui.input.mockResolvedValue(undefined);
    await f.service.run();
    expect(f.start).not.toHaveBeenCalled();
    ui.input.mockResolvedValue('6');
    ui.confirm.mockResolvedValue('Cancel');
    await f.add('old');
    await f.service.run();
    expect(f.deleted).toEqual([]);
    f.server.isAttachOnly = true;
    await f.service.run();
    expect(ui.error).toHaveBeenCalledWith(expect.stringContaining('attach-only'), 'Show details');
  });

  it('aborts repeated global pagination instead of deleting from an incomplete inventory', async () => {
    const f = await fixture();
    await f.add('old');
    f.controls.repeatCursor = true;
    await f.service.run();
    expect(f.deleted).toEqual([]);
    expect(ui.error).toHaveBeenCalledWith(expect.stringContaining('repeated'), 'Show details');
  });
});
