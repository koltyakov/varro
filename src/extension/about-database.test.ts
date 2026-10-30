import { mkdir, mkdtemp, readFile, rm, stat, truncate } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AboutDatabase } from './about-database';

const directories: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture(versions: number[]) {
  const parent = resolve('artifacts/ai-test-data');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'about-database-'));
  directories.push(directory);
  const path = join(directory, 'custom-opencode.db');
  vi.stubEnv('OPENCODE_DB', path);
  const database = new DatabaseSync(path);
  databases.push(database);
  database.exec('CREATE TABLE project (id TEXT PRIMARY KEY);');
  database.prepare('INSERT INTO project VALUES (?)').run('first-project');
  database.prepare('INSERT INTO project VALUES (?)').run('second-project');
  if (versions.includes(1)) {
    database.exec(
      'CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER, time_created INTEGER); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);'
    );
    database.prepare('INSERT INTO session VALUES (?, ?, ?)').run('same-session', 123, Date.now());
    const insert = database.prepare('INSERT INTO message VALUES (?, ?, ?)');
    for (const [id, role] of [
      ['prompt-1', 'user'],
      ['prompt-2', 'user'],
      ['answer-1', 'assistant'],
      ['answer-2', 'assistant'],
    ]) {
      insert.run(id!, 'same-session', JSON.stringify({ role }));
    }
  }
  if (versions.includes(2)) {
    database.exec(
      'CREATE TABLE session_v2 (id TEXT PRIMARY KEY, time_updated INTEGER, time_created INTEGER); CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, data TEXT);'
    );
    database
      .prepare('INSERT INTO session_v2 VALUES (?, ?, ?)')
      .run('same-session', 456, Date.now());
    const insert = database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?)');
    for (const type of ['user', 'assistant', 'synthetic', 'model-selected', 'idle']) {
      insert.run(type, 'same-session', type, '{}');
    }
  }
  return { directory, path, database, reader: new AboutDatabase({ isAttachOnly: false }) };
}

describe('About database details', () => {
  it('uses the oldest retained session timestamp and updates after that history is deleted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 29, 12));
    const f = await fixture([1, 2]);
    f.database.prepare('UPDATE session SET time_created = ?').run(Date.UTC(2026, 0, 29, 12));
    f.database.prepare('UPDATE session_v2 SET time_created = ?').run(Date.UTC(2026, 7, 29, 12));
    expect((await f.reader.read()).age).toBe('9 months');
    f.database.exec('DELETE FROM session');
    f.reader.invalidate();
    expect((await f.reader.read()).age).toBe('2 months');
    f.database.exec('DELETE FROM session_v2');
    f.reader.invalidate();
    expect((await f.reader.read()).age).toBe('No history');
  });

  it('reports freed SQLite pages as reusable without claiming that the file shrank', async () => {
    const f = await fixture([2]);
    f.database.exec(
      'CREATE TABLE padding (data BLOB); INSERT INTO padding VALUES (zeroblob(2000000));'
    );
    const bytes = (await stat(f.path)).size;
    f.database.exec('DELETE FROM padding');
    expect((await stat(f.path)).size).toBe(bytes);
    const details = await f.reader.read();
    expect(details.reusable).not.toBe('Unknown');
    expect(details.reusable).not.toBe('0.0 MB');
    expect(details.note).toContain('reusable space');
  });

  it('does not substitute file creation time when session creation columns are unavailable', async () => {
    const f = await fixture([2]);
    f.database.exec('ALTER TABLE session_v2 DROP COLUMN time_created');
    expect((await f.reader.read()).age).toBe('Unknown');
  });

  it('counts projects and sessions without reading or requiring message tables', async () => {
    const f = await fixture([1, 2]);
    f.database.exec('DROP TABLE message; DROP TABLE session_message;');
    const details = await f.reader.read();
    expect(details.projects).toBe('2');
    expect(details.sessions).toBe('2');
  });
  it.each([1, 2])('reads global V%i counts without modifying database content', async (version) => {
    const f = await fixture([version]);
    const before = await readFile(f.path);
    const details = await f.reader.read();
    expect(details.location).toBe(f.path);
    expect(details.projects).toBe('2');
    expect(details.sessions).toBe('1');
    expect(details.size).toBe('<0.1 MB');
    expect(details.age).toBe('<1 day');
    expect(details.note).toContain('Stored V1 and V2 records');
    expect(await readFile(f.path)).toEqual(before);
  });

  it('includes dormant V1 and migrated V2 copies as separate stored records', async () => {
    const f = await fixture([1, 2]);
    const details = await f.reader.read();
    expect(details.sessions).toBe('2');
    expect(details.note).toContain('including copies');
  });

  it('shows zero counts for an empty supported database', async () => {
    const f = await fixture([1, 2]);
    f.database.exec(
      'DELETE FROM project; DELETE FROM session; DELETE FROM message; DELETE FROM session_v2; DELETE FROM session_message;'
    );
    const details = await f.reader.read();
    expect(details.projects).toBe('0');
    expect(details.sessions).toBe('0');
  });

  it('includes the WAL in size without decoding V2 assistant payloads', async () => {
    const f = await fixture([2]);
    f.database.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    f.database
      .prepare("INSERT INTO session_message VALUES (?, ?, 'assistant', ?)")
      .run('large', 'same-session', 'not JSON: ' + 'x'.repeat(2_000_000));
    const bytes = (await stat(f.path)).size + (await stat(`${f.path}-wal`)).size;
    const details = await f.reader.read();
    expect(details.size).toBe(
      `${(bytes / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`
    );
    expect(details.sessions).toBe('1');
  });

  it('formats large files in GB even when counts are unavailable', async () => {
    const f = await fixture([]);
    await truncate(f.path, 1_500_000_000);
    const details = await f.reader.read();
    expect(details.size).toBe('1.5 GB');
    expect(details.sessions).toBe('Unknown');
    expect(details.note).toContain('Unsupported OpenCode database schema');
  });

  it('handles unsupported schemas and ignores malformed legacy message data', async () => {
    const unsupported = await fixture([]);
    const missing = await unsupported.reader.read();
    expect(missing.projects).toBe('Unknown');
    expect(missing.note).toContain('Unsupported OpenCode database schema');
    const malformed = await fixture([1]);
    malformed.database.prepare('UPDATE message SET data = ?').run('malformed JSON');
    const details = await malformed.reader.read();
    expect(details.projects).toBe('2');
    expect(details.sessions).toBe('1');
    expect(details.note).not.toContain('unavailable');
    expect(details.note).not.toContain('malformed JSON');
  });

  it('does not create a database when the configured path is missing', async () => {
    const f = await fixture([]);
    const path = join(f.directory, 'missing', 'opencode.db');
    vi.stubEnv('OPENCODE_DB', path);
    const details = await f.reader.read();
    expect(details.location).toBe(path);
    expect(details.size).toBe('Unknown');
    expect(details.note).toContain('unavailable');
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('shares in-flight reads and caches scans for thirty seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    const f = await fixture([2]);
    const [first, concurrent] = await Promise.all([f.reader.read(), f.reader.read()]);
    expect(concurrent).toBe(first);
    f.database.exec("INSERT INTO session_v2 VALUES ('second-session', 789, 1000);");
    expect((await f.reader.read()).sessions).toBe('1');
    vi.setSystemTime(31_001);
    expect((await f.reader.read()).sessions).toBe('2');
  });

  it('invalidates the cache when OPENCODE_DB changes', async () => {
    const first = await fixture([1]);
    expect((await first.reader.read()).sessions).toBe('1');
    const second = await fixture([2]);
    second.database
      .prepare('INSERT INTO session_v2 VALUES (?, ?, ?)')
      .run('additional-session', 789, Date.now());
    const details = await first.reader.read();
    expect(details.location).toBe(second.path);
    expect(details.sessions).toBe('2');
  });

  it('never presents cached local details for attach-only connections', async () => {
    const f = await fixture([2]);
    const server = { isAttachOnly: false };
    const reader = new AboutDatabase(server);
    expect((await reader.read()).location).toBe(f.path);
    server.isAttachOnly = true;
    const details = await reader.read();
    expect(details.location).toBe('On server host');
    expect(details.sessions).toBe('Unknown');
    expect(details.note).toContain('attach-only');
    const pendingServer = { isAttachOnly: false };
    const pendingReader = new AboutDatabase(pendingServer);
    const pending = pendingReader.read();
    pendingServer.isAttachOnly = true;
    expect((await pending).location).toBe('On server host');
  });
});
