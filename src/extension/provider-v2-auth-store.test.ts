import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readOpenCodeV2AuthStore } from './provider-v2-auth-store';

describe('readOpenCodeV2AuthStore', () => {
  let root: string;
  let path: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'varro-v2-credentials-'));
    path = join(root, 'opencode.db');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads the active credential ahead of newer inactive credentials without changing the database', async () => {
    const db = new DatabaseSync(path);
    db.exec(
      'CREATE TABLE credential (id TEXT, integration_id TEXT, value TEXT, active INTEGER, time_created INTEGER)'
    );
    const insert = db.prepare('INSERT INTO credential VALUES (?, ?, ?, ?, ?)');
    insert.run('old', 'xai', JSON.stringify({ type: 'oauth', access: 'stale' }), 0, 1);
    insert.run(
      'active',
      'xai',
      JSON.stringify({ type: 'oauth', access: 'current', refresh: 'refresh', expires: 1234 }),
      1,
      2
    );
    insert.run('newer', 'xai', JSON.stringify({ type: 'key', key: 'inactive' }), 0, 3);
    insert.run('a', 'openrouter', JSON.stringify({ type: 'key', key: 'old' }), null, 1);
    insert.run('b', 'openrouter', JSON.stringify({ type: 'key', key: 'new' }), null, 1);
    db.close();
    const before = await readFile(path);

    await expect(readOpenCodeV2AuthStore(path)).resolves.toEqual({
      xai: { type: 'oauth', access: 'current', refresh: 'refresh', expires: 1234 },
      openrouter: { type: 'api', key: 'new' },
    });
    expect(await readFile(path)).toEqual(before);
  });

  it('does not create a missing database', async () => {
    await expect(readOpenCodeV2AuthStore(path)).rejects.toThrow();
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
