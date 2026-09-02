import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { readLocalSessionSummary } from './local-session-summary';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('readLocalSessionSummary', () => {
  it('reads one bounded session tree from the OpenCode database', async () => {
    const databasePath = createDatabase();
    const database = new DatabaseSync(databasePath);
    const insertSession = database.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)');
    insertSession.run('root', null, 100, 20, 5, 10, 2);
    insertSession.run('child', 'root', 40, 8, 1, 4, 1);
    insertSession.run('unrelated', null, 900, 100, 0, 0, 0);
    const insertMessage = database.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
    insertMessage.run(
      'message-root',
      'root',
      1,
      JSON.stringify({ role: 'assistant', tokens: { total: 7 } })
    );
    insertMessage.run(
      'message-child',
      'child',
      2,
      JSON.stringify({ role: 'assistant', tokens: { total: 3 } })
    );
    insertMessage.run('message-other', 'unrelated', 3, JSON.stringify({ role: 'assistant' }));
    database
      .prepare('INSERT INTO part VALUES (?, ?, ?, ?)')
      .run('part-root', 'message-root', 'root', JSON.stringify({ type: 'text', text: 'result' }));
    database.close();

    await expect(readLocalSessionSummary('root', databasePath)).resolves.toEqual({
      contextCharacters: { system: 0, user: 0, assistant: 6, tool: 0 },
      messages: [
        {
          info: {
            id: 'message-root',
            role: 'assistant',
            sessionID: 'root',
            tokens: { total: 7 },
          },
          parts: [],
        },
      ],
      descendants: [
        {
          id: 'child',
          contextCharacters: { system: 0, user: 0, assistant: 0, tool: 0 },
          tokens: {
            input: 40,
            output: 8,
            reasoning: 1,
            cache: { read: 4, write: 1 },
          },
          messages: [],
        },
      ],
    });
  });

  it('returns null for an unsupported schema', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'varro-session-summary-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'opencode.db');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE session (id TEXT PRIMARY KEY)');
    database.close();

    await expect(readLocalSessionSummary('root', databasePath)).resolves.toBeNull();
  });

  it('projects large part bodies before returning the summary', async () => {
    const databasePath = createDatabase();
    const database = new DatabaseSync(databasePath);
    database
      .prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('root', null, 0, 0, 0, 0, 0);
    database
      .prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
      .run('message-root', 'root', 1, JSON.stringify({ role: 'user' }));
    database
      .prepare('INSERT INTO part VALUES (?, ?, ?, ?)')
      .run(
        'part-root',
        'message-root',
        'root',
        JSON.stringify({ type: 'file', url: `data:text/plain,${'x'.repeat(17 * 1024 * 1024)}` })
      );
    database.close();

    await expect(readLocalSessionSummary('root', databasePath)).resolves.toEqual({
      messages: [
        {
          info: { id: 'message-root', role: 'user', sessionID: 'root' },
          parts: [],
        },
      ],
      descendants: [],
      contextCharacters: { system: 0, user: 0, assistant: 0, tool: 0 },
    });
  });
});

function createDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'varro-session-summary-'));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, 'opencode.db');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      tokens_input INTEGER NOT NULL,
      tokens_output INTEGER NOT NULL,
      tokens_reasoning INTEGER NOT NULL,
      tokens_cache_read INTEGER NOT NULL,
      tokens_cache_write INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      data TEXT NOT NULL
    );
  `);
  database.close();
  return databasePath;
}
