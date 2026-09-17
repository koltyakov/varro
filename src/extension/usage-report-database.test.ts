/* oxlint-disable anti-slop/no-module-mocking -- Only the VS Code UI is mocked; usage queries run in real SQLite workers against isolated fixtures. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProgressOptions } from 'vscode';
import { UsageReportService } from './usage-report-service';

const mocks = vi.hoisted(() => ({ content: '' }));
vi.mock('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  commands: { executeCommand: vi.fn() },
  workspace: {
    openTextDocument: async (options: { content: string }) => {
      mocks.content = options.content;
      return { uri: 'untitled:usage' };
    },
  },
  window: {
    withProgress: async (_options: ProgressOptions, task: () => Promise<string>) => task(),
    showTextDocument: vi.fn(),
    showErrorMessage: vi.fn(),
  },
}));

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture(versions: number[]) {
  const parent = resolve('artifacts/ai-test-data');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'usage-'));
  directories.push(directory);
  const path = join(directory, 'opencode.db');
  vi.stubEnv('OPENCODE_DB', path);
  const database = new DatabaseSync(path);
  if (versions.includes(1)) {
    database.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE INDEX message_session_idx ON message(session_id);`);
  }
  if (versions.includes(2)) {
    database.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, time_updated INTEGER, metadata TEXT);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
      CREATE INDEX session_message_session_type_seq_idx ON session_message(session_id, type, seq);`);
  }
  const now = Date.now();
  function add(version: number, id: string, updated: number, model: string, sourceID?: string) {
    const data = {
      role: version === 1 ? 'assistant' : undefined,
      parentID: version === 1 ? `${id}-prompt` : undefined,
      providerID: version === 1 ? 'provider' : undefined,
      modelID: version === 1 ? model : undefined,
      model: version === 2 ? { providerID: 'provider', id: model } : undefined,
      time: { created: now - 2_000, completed: now },
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
    };
    if (version === 1) {
      database.prepare('INSERT INTO session VALUES (?, ?)').run(id, updated);
      database
        .prepare('INSERT INTO message VALUES (?, ?, ?)')
        .run(`${id}-reply`, id, JSON.stringify(data));
    } else {
      database
        .prepare('INSERT INTO session_v2 VALUES (?, ?, ?)')
        .run(
          id,
          updated,
          sourceID ? JSON.stringify({ varroLegacyImport: { sourceSessionID: sourceID } }) : null
        );
      const insert = database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
      insert.run(`${id}-prompt`, id, 'user', 1, '{}');
      insert.run(`${id}-reply`, id, 'assistant', 2, JSON.stringify(data));
      insert.run(`${id}-reply-2`, id, 'assistant', 3, JSON.stringify(data));
    }
  }
  async function report(allTime = false) {
    const before = database.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all();
    database.close();
    const request = vi.fn();
    const start = vi.fn();
    await new UsageReportService({ request }, start).openReport(allTime);
    expect(request).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    const check = new DatabaseSync(path, { readOnly: true });
    expect(check.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(
      before
    );
    check.close();
    return mocks.content;
  }
  return { add, report, now, database };
}

describe('local usage database versions', () => {
  it.each([1, 2])('reads a V%i-only database', async (version) => {
    const { add, report, now } = await fixture([version]);
    add(version, 'only', now, 'only-model');
    const content = await report();
    expect(content).toContain('from 1 sessions scanned');
    expect(content).toContain(
      version === 1
        ? '| provider | only-model | 1 | 21 | 2s | 10 | 5 | 2 | 3 | 1 |'
        : '| provider | only-model | 1 | 42 | 4s | 20 | 10 | 4 | 6 | 2 |'
    );
  });

  it.each([false, true])(
    'merges versions and selects the newest complete session, allTime=%s',
    async (allTime) => {
      const { add, report, now } = await fixture([1, 2]);
      add(1, 'legacy-only', now, 'legacy');
      add(2, 'native-only', now, 'native');
      add(1, 'v2-newer', now - 1, 'discard-v1');
      add(2, 'v2-newer', now, 'newer-v2');
      add(1, 'v1-newer', now, 'newer-v1');
      add(2, 'v1-newer', now - 1, 'discard-v2');
      add(1, 'tie', now, 'discard-tie');
      add(2, 'tie', now, 'tie-v2');
      add(1, 'import-source', now - 1, 'discard-source');
      add(2, 'import-copy', now, 'imported', 'import-source');
      add(2, 'older-copy', now - 1, 'discard-copy', 'import-source');
      add(1, 'source-newer', now, 'updated-source');
      add(2, 'copy-older', now - 1, 'discard-import', 'source-newer');
      const content = await report(allTime);
      expect(content).toContain('from 7 sessions scanned');
      expect(content).not.toContain('discard');
      for (const model of [
        'legacy',
        'native',
        'newer-v2',
        'newer-v1',
        'tie-v2',
        'imported',
        'updated-source',
      ]) {
        expect(content).toContain(`| provider | ${model} | 1 |`);
      }
      expect(content).toContain('| **Total** |  | 7 | 231 | 22s | 110 | 55 | 22 | 33 | 11 |');
    }
  );

  it('filters old sessions after resolving migrated identities', async () => {
    const { add, report, now } = await fixture([1, 2]);
    const old = now - 40 * 24 * 60 * 60 * 1_000;
    add(1, 'old', old, 'discard-old');
    add(2, 'old', old + 1, 'discard-old-v2');
    add(1, 'active', old, 'discard-legacy');
    add(2, 'active', now, 'active-v2');
    const content = await report();
    expect(content).toContain('from 1 sessions scanned');
    expect(content).not.toContain('discard');
    expect(content).toContain('| provider | active-v2 | 1 | 42 |');
  });

  it('does not decode message bodies from old or superseded sessions', async () => {
    const { add, report, now, database } = await fixture([1, 2]);
    add(1, 'old', 0, 'old-model');
    add(1, 'migrated', now - 1, 'legacy-model');
    add(2, 'migrated', now, 'current-model');
    // Invalid bodies make an accidental full-history JSON scan fail deterministically.
    database.prepare('UPDATE message SET data = ?').run('unreadable excluded message');
    const content = await report();
    expect(content).toContain('from 1 sessions scanned');
    expect(content).toContain('| provider | current-model | 1 | 42 |');
  });
});
