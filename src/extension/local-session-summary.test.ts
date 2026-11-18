import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLocalSessionSummary } from './local-session-summary';
import { sessionSummary } from './session-summary';
import { OpenCodeV2SessionState } from './opencode-v2-session-state';
import { logger } from './logger';

// oxlint-disable-next-line anti-slop/no-module-mocking -- SQLite worker diagnostics must not create a real VS Code output channel in unit tests.
vi.mock('./logger', () => ({ logger: { warn: vi.fn() } }));

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Real SQLite fixture writes and worker startup can exceed five seconds on Windows CI.
describe(
  'readLocalSessionSummary',
  { timeout: process.platform === 'win32' ? 30_000 : 5_000 },
  () => {
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
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Unsupported OpenCode v1 database schema'),
        expect.objectContaining({ databasePath, platform: process.platform })
      );
    });

    it.each(['inline', 'stored', 'mixed'])(
      'reads native v2 %s summaries without mixing legacy histories or modifying the database',
      async (storage) => {
        const databasePath = createV2Database(storage !== 'inline');
        const database = new DatabaseSync(databasePath);
        const storeContent = <T extends { type: string }>(
          messageID: string,
          sessionID: string,
          content: T[]
        ) => {
          const storedCount = storage === 'inline' ? 0 : storage === 'mixed' ? 1 : content.length;
          // Insert backwards to check that reading follows ordinal, not insertion order.
          for (let ordinal = storedCount - 1; ordinal >= 0; ordinal--) {
            const part = content[ordinal]!;
            database
              .prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
              .run(messageID, sessionID, ordinal, part.type, null, 1, 2, JSON.stringify(part));
          }
          return content.slice(storedCount);
        };
        database
          .prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run('root', null, 999, 0, 0, 0, 0);
        database
          .prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
          .run('legacy', 'root', 1, JSON.stringify({ role: 'assistant', tokens: { input: 999 } }));
        const insertSession = database.prepare(
          'INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        insertSession.run('root', null, 100, 20, 5, 10, 2, null, null);
        insertSession.run('child', 'root', 40, 8, 1, 4, 1, null, null);
        insertSession.run('unrelated', null, 900, 100, 0, 0, 0, null, null);
        const insertMessage = database.prepare(
          'INSERT INTO session_message VALUES (?, ?, ?, ?, ?)'
        );
        insertMessage.run(
          'prompt',
          'root',
          'user',
          1,
          JSON.stringify({ time: { created: 1 }, text: 'Inspect file' })
        );
        insertMessage.run(
          'reply',
          'root',
          'assistant',
          2,
          JSON.stringify({
            model: { providerID: 'fixture', id: 'model', variant: 'high' },
            time: { created: 2, completed: 1002 },
            cost: 0.5,
            tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } },
            content: storeContent('reply', 'root', [
              { type: 'text', text: 'Done' },
              { type: 'reasoning', text: 'Think' },
              {
                type: 'tool',
                name: 'edit',
                state: {
                  status: 'completed',
                  input: { filePath: 'src/probe.ts' },
                  metadata: { additions: 3, deletions: 1 },
                  content: [{ type: 'text', text: 'saved' }],
                },
              },
            ]),
          })
        );
        insertMessage.run(
          'child-reply',
          'child',
          'assistant',
          1,
          JSON.stringify({
            model: { providerID: 'fixture', id: 'model' },
            time: { created: 3, completed: 4 },
            cost: 0.2,
            tokens: { input: 40, output: 8, reasoning: 1, cache: { read: 4, write: 1 } },
            content: storeContent('child-reply', 'child', [
              { type: 'text', text: 'Child' },
              {
                type: 'tool',
                name: 'shell',
                state: {
                  status: 'completed',
                  input: { command: 'ls' },
                  content: [{ type: 'text', text: 'listed' }],
                },
              },
            ]),
          })
        );
        insertMessage.run('unrelated-reply', 'unrelated', 'assistant', 1, 'invalid excluded JSON');
        if (storage !== 'inline') {
          database
            .prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run('unrelated-reply', 'unrelated', 0, 'text', null, 1, 2, 'invalid excluded JSON');
        }
        const before = database.prepare('SELECT * FROM session_message ORDER BY id').all();
        const partsBefore =
          storage === 'inline'
            ? []
            : database.prepare('SELECT * FROM session_part ORDER BY message_id,ordinal').all();
        database.close();

        const local = await readLocalSessionSummary('root', databasePath, 2);
        expect(local).toMatchObject({
          contextCharacters: { system: 0, user: 12, assistant: 9, tool: 21 },
          contextInputTokens: 100,
          messages: [
            { info: { id: 'prompt', role: 'user' } },
            {
              info: {
                id: 'reply',
                role: 'assistant',
                parentID: 'prompt',
                modelID: 'model',
                variant: 'high',
              },
            },
          ],
          descendants: [
            {
              id: 'child',
              contextInputTokens: 40,
              contextCharacters: { system: 0, user: 0, assistant: 5, tool: 22 },
              messages: [{ parts: [] }],
            },
          ],
        });
        expect(local?.messages).toHaveLength(2);
        expect(local?.descendants).toHaveLength(1);
        expect(sessionSummary.fromLocal(local!)).toMatchObject({
          files: 1,
          additions: 3,
          deletions: 1,
          tokens: 177,
          durationMs: 1001,
          tokenBreakdown: { session: { cost: 0.5 }, subagents: { cost: 0.2 }, subagentCount: 1 },
        });
        const unchanged = new DatabaseSync(databasePath, { readOnly: true });
        expect(unchanged.prepare('SELECT * FROM session_message ORDER BY id').all()).toEqual(
          before
        );
        if (storage !== 'inline') {
          expect(
            unchanged.prepare('SELECT * FROM session_part ORDER BY message_id,ordinal').all()
          ).toEqual(partsBefore);
        }
        unchanged.close();
        expect(logger.warn).not.toHaveBeenCalled();
        expect((await readLocalSessionSummary('root', databasePath, 1))?.messages).toMatchObject([
          { info: { id: 'legacy' } },
        ]);
      }
    );

    it.each(['root', 'child', 'unrelated', null])(
      'reads separately stored v2 parts for %s only when they belong to the selected tree',
      async (partSessionID) => {
        const databasePath = createV2Database(true);
        const database = new DatabaseSync(databasePath);
        const insertSession = database.prepare(
          'INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        insertSession.run('root', null, 0, 0, 0, 0, 0, null, null);
        insertSession.run('child', 'root', 0, 0, 0, 0, 0, null, null);
        insertSession.run('unrelated', null, 0, 0, 0, 0, 0, null, null);
        if (partSessionID) {
          database
            .prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)')
            .run(
              'reply',
              partSessionID,
              'assistant',
              1,
              JSON.stringify({ time: { created: 1, completed: 2 }, content: [] })
            );
          database
            .prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
              'reply',
              partSessionID,
              0,
              'text',
              null,
              1,
              2,
              JSON.stringify({ type: 'text', text: 'Done' })
            );
        }
        const before = database.prepare('SELECT * FROM session_part').all();
        database.close();

        const local = await readLocalSessionSummary('root', databasePath, 2);
        expect(local).toMatchObject({
          contextCharacters: { assistant: partSessionID === 'root' ? 4 : 0 },
          descendants: [
            { id: 'child', contextCharacters: { assistant: partSessionID === 'child' ? 4 : 0 } },
          ],
        });
        expect(local?.messages).toHaveLength(partSessionID === 'root' ? 1 : 0);
        expect(logger.warn).not.toHaveBeenCalled();
        const unchanged = new DatabaseSync(databasePath, { readOnly: true });
        expect(unchanged.prepare('SELECT * FROM session_part').all()).toEqual(before);
        unchanged.close();
      }
    );

    it('keeps stored tool order before inline content and counts completed, failed, and streaming output', async () => {
      const databasePath = createV2Database(true);
      const database = new DatabaseSync(databasePath);
      database
        .prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('root', null, 0, 0, 0, 0, 0, null, null);
      database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)').run(
        'reply',
        'root',
        'assistant',
        1,
        JSON.stringify({
          content: [
            { type: 'tool', name: 'subagent', state: { status: 'streaming', input: '{"x":1}' } },
          ],
        })
      );
      const insert = database.prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      insert.run(
        'reply',
        'root',
        7,
        'tool',
        null,
        1,
        2,
        JSON.stringify({
          type: 'tool',
          name: 'edit',
          state: { status: 'error', input: { filePath: 'probe.ts' }, error: { message: 'bad' } },
        })
      );
      insert.run(
        'reply',
        'root',
        2,
        'tool',
        null,
        1,
        2,
        JSON.stringify({
          type: 'tool',
          name: 'shell',
          state: {
            status: 'completed',
            input: { command: 'ls' },
            content: [{ type: 'text', text: 'listed' }],
          },
        })
      );
      database.close();

      const local = await readLocalSessionSummary('root', databasePath, 2);
      expect(local).toMatchObject({
        contextCharacters: { system: 0, user: 0, assistant: 0, tool: 48 },
        messages: [{ parts: [{ tool: 'bash' }, { tool: 'edit' }, { tool: 'task' }] }],
      });
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it.each([undefined, 6_000, null])(
      'reads native v2 pause metadata with annotation override %s without changing source rows',
      async (pausedAt) => {
        const databasePath = createV2Database();
        const database = new DatabaseSync(databasePath);
        database
          .prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run('root', null, 0, 0, 0, 0, 0, null, null);
        database.exec('ALTER TABLE session_v2 ADD COLUMN metadata TEXT');
        const metadata = { varro: { pauses: [{ messageId: 'paused', pausedAt: 11_000 }] } };
        database.prepare('UPDATE session_v2 SET metadata = ?').run(JSON.stringify(metadata));
        const insert = database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
        insert.run(
          'prompt',
          'root',
          'user',
          1,
          JSON.stringify({ time: { created: 1_000 }, text: 'Do work' })
        );
        insert.run(
          'paused',
          'root',
          'assistant',
          2,
          JSON.stringify({ time: { created: 2_000 }, content: [] })
        );
        const before = database.prepare('SELECT * FROM session_v2').all();
        database.close();
        const annotations = new OpenCodeV2SessionState(join(dirname(databasePath), 'annotations'));
        const expectedMetadata =
          pausedAt === undefined
            ? metadata
            : pausedAt === null
              ? {}
              : { varro: { pauses: [{ messageId: 'paused', pausedAt }] } };
        if (pausedAt !== undefined)
          await annotations.update('root', { metadata: expectedMetadata });
        else await annotations.update('root', { parentID: 'unrelated-annotation' });

        const local = await readLocalSessionSummary('root', databasePath, 2, annotations);
        expect(local?.metadata).toEqual(expectedMetadata);
        const summary = sessionSummary.fromLocal(local!, local?.metadata);
        expect(summary).toMatchObject(
          pausedAt === null
            ? { durationMs: 0, activeStartedAt: 1_000 }
            : { durationMs: (pausedAt ?? 11_000) - 1_000, activeStartedAt: null }
        );
        const unchanged = new DatabaseSync(databasePath, { readOnly: true });
        expect(unchanged.prepare('SELECT * FROM session_v2').all()).toEqual(before);
        unchanged.close();
      }
    );

    it('logs SQLite parsing failures instead of silently falling back', async () => {
      const databasePath = createDatabase();
      const database = new DatabaseSync(databasePath);
      database
        .prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('root', null, 0, 0, 0, 0, 0);
      database
        .prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
        .run('invalid', 'root', 1, '{invalid');
      database.close();
      await expect(readLocalSessionSummary('root', databasePath)).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('using API:'),
        expect.objectContaining({ databasePath, nodeVersion: process.version })
      );
    });

    it('logs the missing database path', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'varro-session-summary-'));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, 'missing.db');
      await expect(readLocalSessionSummary('root', databasePath)).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Database file not found'),
        expect.objectContaining({ databasePath })
      );
    });

    it.each(['fork_session_id', 'revert'])(
      'defers v2 %s history boundaries to the API',
      async (column) => {
        const databasePath = createV2Database();
        const database = new DatabaseSync(databasePath);
        database
          .prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run('root', null, 0, 0, 0, 0, 0, null, null);
        database
          .prepare(`UPDATE session_v2 SET ${column} = ? WHERE id = ?`)
          .run(column === 'revert' ? '{}' : 'source', 'root');
        database.close();
        await expect(readLocalSessionSummary('root', databasePath, 2)).resolves.toBeNull();
      }
    );

    it.each(['inline', 'stored'])(
      'reads a v2-only %s database and omits large tool output from the worker result',
      async (storage) => {
        const databasePath = createV2Database(storage === 'stored');
        const database = new DatabaseSync(databasePath);
        database.exec('DROP TABLE part; DROP TABLE message; DROP TABLE session;');
        database
          .prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run('root', null, 10, 3, 0, 0, 0, null, null);
        const content = {
          type: 'tool',
          name: 'edit',
          state: {
            status: 'completed',
            input: { filePath: 'probe.ts' },
            content: [{ type: 'text', text: 'x'.repeat(17 * 1024 * 1024) }],
          },
        };
        if (storage === 'stored') {
          database
            .prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run('reply', 'root', 0, 'tool', null, 1, 2, JSON.stringify(content));
        }
        database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)').run(
          'reply',
          'root',
          'assistant',
          1,
          JSON.stringify({
            time: { created: 1, completed: 2 },
            model: { providerID: 'fixture', id: 'model' },
            tokens: { input: 10, output: 3 },
            content: storage === 'stored' ? [] : [content],
          })
        );
        database.close();
        const local = await readLocalSessionSummary('root', databasePath, 2);
        expect(local?.contextCharacters?.tool).toBe(17 * 1024 * 1024 + 16);
        expect(JSON.stringify(local).length).toBeLessThan(1000);
        await expect(readLocalSessionSummary('missing', databasePath, 2)).resolves.toBeNull();
      }
    );

    it.each([
      {
        name: 'invalid JSON',
        data: '{invalid',
        type: 'text',
        ordinal: 0,
        messageID: 'reply',
        owner: 'root',
        messageType: 'assistant',
        reason: 'using API:',
      },
      {
        name: 'non-object JSON',
        data: '[]',
        type: 'text',
        ordinal: 0,
        messageID: 'reply',
        owner: 'root',
        messageType: 'assistant',
        reason: 'invalid JSON',
      },
      {
        name: 'type mismatch',
        data: '{"type":"reasoning","text":"x"}',
        type: 'text',
        ordinal: 0,
        messageID: 'reply',
        owner: 'root',
        messageType: 'assistant',
        reason: 'Malformed or unsupported',
      },
      {
        name: 'unknown type',
        data: '{"type":"future"}',
        type: 'future',
        ordinal: 0,
        messageID: 'reply',
        owner: 'root',
        messageType: 'assistant',
        reason: 'Malformed or unsupported',
      },
      {
        name: 'invalid text',
        data: '{"type":"text","text":1}',
        type: 'text',
        ordinal: 0,
        messageID: 'reply',
        owner: 'root',
        messageType: 'assistant',
        reason: 'stored text part',
      },
      {
        name: 'invalid tool',
        data: '{"type":"tool","name":"edit","state":[]}',
        type: 'tool',
        ordinal: 0,
        messageID: 'reply',
        owner: 'root',
        messageType: 'assistant',
        reason: 'stored tool part',
      },
      {
        name: 'negative ordinal',
        data: '{"type":"text","text":"x"}',
        type: 'text',
        ordinal: -1,
        messageID: 'reply',
        owner: 'root',
        messageType: 'assistant',
        reason: 'ownership or ordinal',
      },
      {
        name: 'fractional ordinal',
        data: '{"type":"text","text":"x"}',
        type: 'text',
        ordinal: 0.5,
        messageID: 'reply',
        owner: 'root',
        messageType: 'assistant',
        reason: 'ownership or ordinal',
      },
      {
        name: 'missing message',
        data: '{"type":"text","text":"x"}',
        type: 'text',
        ordinal: 0,
        messageID: 'missing',
        owner: 'root',
        messageType: 'assistant',
        reason: 'no assistant message',
      },
      {
        name: 'wrong owner',
        data: '{"type":"text","text":"x"}',
        type: 'text',
        ordinal: 0,
        messageID: 'reply',
        owner: 'child',
        messageType: 'assistant',
        reason: 'does not belong',
      },
      {
        name: 'non-assistant message',
        data: '{"type":"text","text":"x"}',
        type: 'text',
        ordinal: 0,
        messageID: 'reply',
        owner: 'root',
        messageType: 'user',
        reason: 'does not belong',
      },
    ])('falls back with diagnostics for a v2 stored part with $name', async (fixture) => {
      const databasePath = createV2Database(true);
      const database = new DatabaseSync(databasePath);
      const insert = database.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      insert.run('root', null, 0, 0, 0, 0, 0, null, null);
      insert.run('child', 'root', 0, 0, 0, 0, 0, null, null);
      database
        .prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)')
        .run('reply', 'root', fixture.messageType, 1, JSON.stringify({ content: [] }));
      database
        .prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          fixture.messageID,
          fixture.owner,
          fixture.ordinal,
          fixture.type,
          null,
          1,
          2,
          fixture.data
        );
      database.close();

      await expect(readLocalSessionSummary('root', databasePath, 2)).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(fixture.reason),
        expect.objectContaining({ databasePath })
      );
    });

    it('applies one part-count limit across stored and inline v2 content', async () => {
      const databasePath = createV2Database(true);
      const database = new DatabaseSync(databasePath);
      database
        .prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('root', null, 0, 0, 0, 0, 0, null, null);
      database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)').run(
        'reply',
        'root',
        'assistant',
        1,
        JSON.stringify({
          content: Array.from({ length: 250_000 }, () => ({ type: 'text', text: '' })),
        })
      );
      database
        .prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('reply', 'root', 0, 'text', null, 1, 2, '{"type":"text","text":""}');
      database.close();

      await expect(readLocalSessionSummary('root', databasePath, 2)).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Local session exceeds the part limit'),
        expect.objectContaining({ databasePath })
      );
    });

    it('falls back for an unsupported v2 stored-part schema', async () => {
      const databasePath = createV2Database();
      const database = new DatabaseSync(databasePath);
      database
        .prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('root', null, 0, 0, 0, 0, 0, null, null);
      database.exec('CREATE TABLE session_part (message_id TEXT)');
      database.close();

      await expect(readLocalSessionSummary('root', databasePath, 2)).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Unsupported OpenCode v2 stored-part schema'),
        expect.objectContaining({ databasePath })
      );
    });

    it('uses OPENCODE_DB for the default local database path', async () => {
      const databasePath = createDatabase();
      const database = new DatabaseSync(databasePath);
      database
        .prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('root', null, 0, 0, 0, 0, 0);
      database.close();
      vi.stubEnv('OPENCODE_DB', databasePath);
      await expect(readLocalSessionSummary('root')).resolves.toMatchObject({
        messages: [],
        descendants: [],
      });
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
  }
);

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

function createV2Database(withParts = false): string {
  const databasePath = createDatabase();
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, parent_id TEXT,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER,
      fork_session_id TEXT, revert TEXT
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT
    );
    CREATE INDEX session_message_session_seq_idx ON session_message(session_id, seq);
  `);
  if (withParts) {
    database.exec(`
      CREATE TABLE session_part (
        message_id TEXT NOT NULL, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        type TEXT NOT NULL, call_id TEXT, time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (message_id, ordinal)
      );
      CREATE INDEX session_part_session_message_idx ON session_part(session_id, message_id, ordinal);
    `);
  }
  database.close();
  return databasePath;
}
