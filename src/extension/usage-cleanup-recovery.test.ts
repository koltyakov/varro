/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Mock VS Code and instrument real workers to count matching work on isolated SQLite fixtures. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readUsageCleanupArtifacts } from './usage-report-service';
import { asRecord } from '../shared/type-utils';
import type { WorkerOptions } from 'node:worker_threads';
import type * as workerThreads from 'node:worker_threads';

vi.mock('vscode', () => ({}));
const scanWork = vi.hoisted(() => ({ includesCalls: 0, matcherCalls: 0 }));
vi.mock('node:worker_threads', async (importOriginal) => {
  const original = await importOriginal<typeof workerThreads>();
  return {
    ...original,
    Worker: class extends original.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        let source = filename;
        if (
          typeof source === 'string' &&
          options?.eval &&
          asRecord(options.workerData)?.cleanupAction === 'artifacts'
        ) {
          source = source
            .replace(
              'const cleanupJournal = () => {',
              'const work = { includesCalls: 0, matcherCalls: 0 }; const cleanupJournal = () => {'
            )
            .replace('row.data.includes(name)', '(work.includesCalls++, row.data.includes(name))')
            .replace('matcher.test(row.data)', '(work.matcherCalls++, matcher.test(row.data))')
            .replace(
              'parentPort.postMessage(cleanupJournal());',
              'const result = cleanupJournal(); if (result.length) result[0].probe = work; parentPort.postMessage(result);'
            );
        }
        super(source, options);
        this.on('message', (value: unknown) => {
          const probe = asRecord(Array.isArray(value) ? asRecord(value[0])?.probe : undefined);
          if (typeof probe?.includesCalls === 'number' && typeof probe.matcherCalls === 'number') {
            scanWork.includesCalls = probe.includesCalls;
            scanWork.matcherCalls = probe.matcherCalls;
          }
        });
      }
    },
  };
});
const directories: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture() {
  const parent = resolve('artifacts/ai-test-data');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'cleanup-references-'));
  directories.push(root);
  vi.stubEnv('OPENCODE_DB', join(root, 'opencode.db'));
  const database = new DatabaseSync(join(root, 'opencode.db'));
  const archive = new DatabaseSync(join(root, 'opencode-stats.db'));
  databases.push(database, archive);
  database.exec(
    'CREATE TABLE message (data TEXT); CREATE TABLE part (data TEXT); CREATE TABLE session_message (data TEXT); CREATE TABLE session_part (data TEXT); CREATE TABLE session_inbox (payload TEXT);'
  );
  archive.exec('CREATE TABLE usage_artifact (session_id TEXT,path TEXT);');
  const add = async (id: string, name: string, exists = true) => {
    const folder = join(root, id);
    await mkdir(folder);
    const path = join(folder, name);
    if (exists) await writeFile(path, 'Keep until references are checked');
    archive.prepare('INSERT INTO usage_artifact VALUES (?, ?)').run(id, path);
    return path;
  };
  return { database, archive, add };
}

describe('batched artifact recovery', () => {
  it.each([
    'tool_[1].txt',
    'tool_(1).txt',
    'tool_{1}.txt',
    'tool_+.txt',
    'tool_$.txt',
    'tool_^.txt',
    '工具[1].txt',
  ])('treats %s as a literal filename even when it is the only candidate', async (name) => {
    const f = await fixture();
    await f.add('old', name);
    f.database.prepare('INSERT INTO message VALUES (?)').run(JSON.stringify({ reference: name }));
    expect((await readUsageCleanupArtifacts(['old'])).get('old')).toEqual([]);
  });

  it('handles 876 filenames without testing each one against every unrelated row', async () => {
    const f = await fixture();
    const ids = Array.from({ length: 876 }, (_, index) => `old-${index}`);
    for (const [index, id] of ids.entries())
      await f.add(id, index === 0 ? 'tool_common' : `tool_${index.toString(16).padStart(32, '0')}`);
    // Once found, a common name must leave the regexp as well as the name set.
    f.database
      .prepare(
        'WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value < 1000) INSERT INTO message SELECT ? FROM n'
      )
      .run(JSON.stringify({ text: 'tool_common and unrelated tool_state '.repeat(1000) }));
    const result = await readUsageCleanupArtifacts(ids);
    expect(result.get(ids[0]!)).toEqual([]);
    expect([...result.values()].flat()).toHaveLength(875);
    expect(scanWork.matcherCalls).toBe(1000);
    expect(scanWork.includesCalls).toBe(876);
  });

  it('preserves literal, prefix, suffix, overlapping and Unicode matches exactly', async () => {
    const f = await fixture();
    const names = [
      'tool_[a]{1}(2)+.$^.txt',
      'tool_a',
      'tool_ab',
      'tool_abc',
      'overlap_aaaa',
      'aaaa',
      'aaa',
      'aa',
      'a',
      'Снимок(1).txt',
      '工具[1].txt',
      'unreferenced+(1).txt',
    ];
    if (process.platform !== 'win32') names.push('tool_*?|\\.txt');
    const bodies = [
      JSON.stringify({
        text: 'tool_[a]{1}(2)+.$^.txt tool_abc overlap_aaaa Снимок(1).txt 工具[1].txt tool_*?|\\.txt',
      }),
      JSON.stringify({ text: 'other data' }),
    ];
    const expected = new Map<string, string[]>();
    for (const [index, name] of names.entries()) {
      const id = `case-${index}`;
      const path = await f.add(id, name);
      expected.set(id, bodies.some((body) => body.includes(name)) ? [] : [path]);
    }
    for (const body of bodies) f.database.prepare('INSERT INTO message VALUES (?)').run(body);
    expect(await readUsageCleanupArtifacts([...expected.keys()])).toEqual(expected);
  });

  it('reads remaining history once across many pending sessions and reports the work count', async () => {
    const f = await fixture();
    const ids = Array.from({ length: 19 }, (_, index) => `old-${index}`);
    const paths: string[] = [];
    for (const id of ids) paths.push(await f.add(id, `tool_${id}`));
    f.database
      .prepare(
        'WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value < 1000) INSERT INTO session_message SELECT ? FROM n'
      )
      .run(JSON.stringify({ text: 'unrelated history'.repeat(1024) }));
    const progress: string[] = [];
    const result = await readUsageCleanupArtifacts(ids, (message) => progress.push(message));
    expect([...result.values()].flat()).toEqual(paths);
    expect(progress.at(-1)).toBe(
      'Artifact reference scan complete: 1,000 rows, 0 referenced names kept'
    );
    expect(
      progress.filter((message) =>
        message.startsWith('Checking artifact references in session_message')
      )
    ).toHaveLength(1);
    expect(f.database.prepare('SELECT count(*) AS count FROM session_message').get()?.count).toBe(
      1000
    );
  });

  it.each(['message', 'part', 'session_message', 'session_part', 'session_inbox'])(
    'keeps files referenced in %s, including prose and encoded paths',
    async (table) => {
      const f = await fixture();
      await f.add('shared', 'tool_shared');
      const unshared = await f.add('unshared', 'tool_unshared');
      const column = table === 'session_inbox' ? 'payload' : 'data';
      f.database
        .prepare(`INSERT INTO ${table} (${column}) VALUES (?)`)
        .run(JSON.stringify({ text: 'Do not remove file:///encoded%20directory/tool_shared' }));
      const result = await readUsageCleanupArtifacts(['shared', 'unshared']);
      expect(result.get('shared')).toEqual([]);
      expect(result.get('unshared')).toEqual([unshared]);
    }
  );

  it('protects shared basenames across owners but clears missing files with that same name', async () => {
    const f = await fixture();
    await f.add('first', 'tool_shared');
    await f.add('second', 'tool_shared');
    const missing = await f.add('missing', 'tool_shared', false);
    f.database.prepare('INSERT INTO session_part VALUES (?)').run('tool_shared');
    const result = await readUsageCleanupArtifacts(['first', 'second', 'missing']);
    expect(result.get('first')).toEqual([]);
    expect(result.get('second')).toEqual([]);
    expect(result.get('missing')).toEqual([missing]);
  });

  it('does not scan history when none of the candidate artifacts exists', async () => {
    const f = await fixture();
    const missing = await f.add('missing', 'tool_missing', false);
    f.database.exec(
      'DROP TABLE session_message; CREATE TABLE session_message (unrecognized TEXT);'
    );
    const progress: string[] = [];
    expect(
      (await readUsageCleanupArtifacts(['missing'], (message) => progress.push(message))).get(
        'missing'
      )
    ).toEqual([missing]);
    expect(progress).toEqual([]);
  });

  it('cancels active reference scanning without changing source rows or the journal', async () => {
    const f = await fixture();
    await f.add('old', 'tool_old');
    f.database.prepare('INSERT INTO message VALUES (?)').run('{}');
    const controller = new AbortController();
    await expect(
      readUsageCleanupArtifacts(['old'], () => controller.abort(), controller.signal)
    ).rejects.toThrow('cancelled');
    expect(f.archive.prepare('SELECT count(*) AS count FROM usage_artifact').get()?.count).toBe(1);
    expect(f.database.prepare('SELECT count(*) AS count FROM message').get()?.count).toBe(1);
  });
});
