import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasStoredWebSearchPreference } from './websearch-preference';

describe('hasStoredWebSearchPreference', () => {
  let root: string;
  let path: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'varro-websearch-preference-'));
    path = join(root, 'opencode.db');
    vi.stubEnv('OPENCODE_DB', path);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it.each([false, 'exa', 'random', null])(
    'preserves a saved selection %j without changing any records',
    async (selection) => {
      const database = new DatabaseSync(path);
      database.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      database
        .prepare('INSERT INTO kv VALUES (?, ?)')
        .run('websearch:provider', JSON.stringify(selection));
      database.close();
      const before = await readFile(path);

      await expect(hasStoredWebSearchPreference()).resolves.toBe(true);
      expect(await readFile(path)).toEqual(before);
    }
  );

  it.each(['empty', 'unrelated', 'legacy'])(
    'allows the fallback for a %s database without migrating it',
    async (scenario) => {
      const database = new DatabaseSync(path);
      if (scenario !== 'legacy') {
        database.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        if (scenario === 'unrelated')
          database.prepare('INSERT INTO kv VALUES (?, ?)').run('another-setting', 'false');
      }
      database.close();
      const before = await readFile(path);

      await expect(hasStoredWebSearchPreference()).resolves.toBe(false);
      expect(await readFile(path)).toEqual(before);
    }
  );

  it('does not create a missing database', async () => {
    await expect(hasStoredWebSearchPreference()).resolves.toBe(false);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not open an in-memory database', async () => {
    vi.stubEnv('OPENCODE_DB', ':memory:');
    await expect(hasStoredWebSearchPreference()).resolves.toBe(false);
  });

  it('resolves relative database overrides against the OpenCode data directory', async () => {
    vi.stubEnv('XDG_DATA_HOME', root);
    vi.stubEnv('OPENCODE_DB', '../opencode.db');
    const database = new DatabaseSync(path);
    database.exec(
      "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO kv VALUES ('websearch:provider', 'false')"
    );
    database.close();
    await expect(hasStoredWebSearchPreference()).resolves.toBe(true);
  });

  it('rejects an unreadable database rather than treating it as no preference', async () => {
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE kv (unexpected TEXT)');
    database.close();
    await expect(hasStoredWebSearchPreference()).rejects.toThrow();
  });
});
