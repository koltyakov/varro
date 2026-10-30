/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- The fixture models opaque server history and decodes SQLite JSON replies; persistence uses real isolated workers. */
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenCodeApiVersion } from './opencode-connection';
import type { OpenCodeRequestOptions } from './open-code-transport';
import {
  SessionTranscriptArchive,
  sessionTranscriptArchivePath,
} from './session-transcript-archive';
import type { TranscriptArchiveSession } from './session-transcript-archive';
import { pastedTextDataUrl } from '../shared/pasted-text';
import { LocalSessionTranscriptReader } from './local-session-transcript';

const directories: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture(version: OpenCodeApiVersion = 2) {
  const parent = resolve('artifacts/ai-test-data');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'transcript-'));
  directories.push(root);
  vi.stubEnv('OPENCODE_DB', join(root, 'custom.sqlite'));
  const session: TranscriptArchiveSession = {
    id: 'session',
    directory: join(root, 'deleted-project'),
    title: 'Original title',
    created: 1,
    updated: 100,
    identity: 'original-v1',
  };
  const messages = new Map<string, unknown[]>();
  const controls = {
    repeatCursor: false,
    malformedCursor: false,
    nullEndCursor: true,
    pageSize: 2,
    responseBytes: 0,
  };
  const request = vi.fn(
    async (
      method: string,
      path: string,
      _body?: unknown,
      options?: OpenCodeRequestOptions
    ): Promise<unknown> => {
      expect(method).toBe('GET');
      expect(options?.unscoped).toBe(true);
      const url = new URL(path, 'http://fixture');
      const match = /^\/(?:api\/)?session\/([^/]+)\/message$/.exec(url.pathname);
      if (!match) throw new Error(`Unexpected fixture request ${path}`);
      const history = messages.get(decodeURIComponent(match[1]!)) ?? [];
      if (version === 1) {
        expect(url.searchParams.get('limit')).toBeNull();
        expect(url.searchParams.get('directory')).toBe(session.directory);
        return history;
      }
      expect(url.searchParams.get('directory')).toBeNull();
      expect(url.searchParams.get('location[directory]')).toBeNull();
      const cursor = url.searchParams.get('cursor');
      expect(url.searchParams.get('order')).toBe(cursor ? null : 'desc');
      const offset = Number(cursor ?? 0);
      const data = history.toReversed().slice(offset, offset + controls.pageSize);
      const response = {
        data,
        cursor: controls.malformedCursor
          ? undefined
          : {
              previous: data.length
                ? `previous-${offset}`
                : controls.nullEndCursor
                  ? null
                  : undefined,
              next: controls.repeatCursor
                ? '1'
                : data.length
                  ? String(offset + data.length)
                  : controls.nullEndCursor
                    ? null
                    : undefined,
            },
      };
      controls.responseBytes += Buffer.byteLength(JSON.stringify(response));
      return response;
    }
  );
  return {
    root,
    session,
    messages,
    controls,
    request,
    archive: new SessionTranscriptArchive({ request, apiVersion: version }),
  };
}

function user(id: string, text = 'Exact user prompt') {
  return { id, type: 'user', text, time: { created: 1 } };
}

function assistant(id: string, text = 'Exact final response', finish = 'stop') {
  return {
    id,
    type: 'assistant',
    content: [{ type: 'text', text }],
    model: { providerID: 'provider', id: 'model', variant: 'high' },
    finish,
    time: { created: 2, completed: 3 },
  };
}

function idle(id: string, outcome = 'succeeded') {
  return { id, type: 'idle', outcome, time: { created: 4 } };
}

function readArchive() {
  const database = new DatabaseSync(sessionTranscriptArchivePath(), { readOnly: true });
  try {
    return {
      sessions: database.prepare('SELECT * FROM transcript_session ORDER BY id').all(),
      turns: database
        .prepare(
          'SELECT session_id, ordinal, data FROM transcript_turn ORDER BY session_id, ordinal'
        )
        .all()
        .map((row) => {
          if (typeof row.data !== 'string') throw new Error('Invalid transcript fixture row');
          const data: unknown = JSON.parse(row.data);
          return { sessionID: row.session_id, ordinal: row.ordinal, data };
        }),
    };
  } finally {
    database.close();
  }
}

function localHistory(
  f: { root: string; session: TranscriptArchiveSession },
  history: { id: string; type: string }[]
): DatabaseSync {
  const database = new DatabaseSync(join(f.root, 'custom.sqlite'));
  databases.push(database);
  database.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, time_updated INTEGER, fork_session_id TEXT, revert TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
    CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id,seq);
    CREATE TABLE session_part (message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,data TEXT,PRIMARY KEY(message_id,ordinal));
    CREATE TABLE blob (hash TEXT PRIMARY KEY,data BLOB);`);
  database
    .prepare('INSERT INTO session_v2 VALUES (?, ?, NULL, NULL)')
    .run(f.session.id, f.session.updated);
  const insert = database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
  history.forEach((message, index) =>
    insert.run(message.id, f.session.id, message.type, index, JSON.stringify(message))
  );
  return database;
}

describe('trimmed transcript archive', () => {
  it('never downloads or stores subagent-only transcripts', async () => {
    const f = await fixture();
    f.messages.set('child', [{ id: 'broken-child', type: 'assistant' }]);
    await f.archive.archive([{ ...f.session, id: 'child', parentID: f.session.id }]);
    expect(f.request).not.toHaveBeenCalled();
    await expect(stat(sessionTranscriptArchivePath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('mixes chronological local and parentless fork histories in one committed archive', async () => {
    const f = await fixture();
    const child: TranscriptArchiveSession = { ...f.session, id: 'child' };
    const database = localHistory(f, [
      user('parent-prompt'),
      assistant('parent-answer'),
      idle('parent-done'),
    ]);
    database
      .prepare('INSERT INTO session_v2 VALUES (?, ?, ?, NULL)')
      .run(child.id, child.updated, f.session.id);
    f.messages.set(child.id, [
      user('inherited-prompt'),
      assistant('fork-answer'),
      idle('fork-done'),
    ]);
    await f.archive.archive([f.session, child]);
    expect(readArchive().turns).toMatchObject([
      {
        sessionID: 'child',
        data: { prompts: [{ id: 'inherited-prompt' }], response: { id: 'fork-answer' } },
      },
      {
        sessionID: 'session',
        data: { prompts: [{ id: 'parent-prompt' }], response: { id: 'parent-answer' } },
      },
    ]);
    expect(f.request.mock.calls.every(([, path]) => path.includes('/child/message?'))).toBe(true);
  });

  it('archives empty and inline-only supported databases without requiring a parts table', async () => {
    const f = await fixture();
    const database = localHistory(f, []);
    database.exec('DROP TABLE session_part');
    await f.archive.archive([f.session]);
    expect(readArchive().sessions).toHaveLength(1);
    expect(readArchive().turns).toEqual([]);
    const answer = {
      ...assistant('answer'),
      model: undefined,
      providerID: 'legacy-provider',
      modelID: 'legacy-model',
    };
    database
      .prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)')
      .run(answer.id, f.session.id, answer.type, 0, JSON.stringify(answer));
    await f.archive.archive([f.session]);
    expect(readArchive().turns).toMatchObject([
      { data: { response: { model: { providerID: 'legacy-provider', id: 'legacy-model' } } } },
    ]);
    expect(f.request).not.toHaveBeenCalled();
  });

  it('produces the same archive with no API requests or tool/media transfer on the same large input', async () => {
    const f = await fixture();
    f.controls.pageSize = 200;
    const history = [
      {
        ...user('prompt'),
        files: [{ mime: 'image/png', name: 'image.png', data: 'I'.repeat(1024 * 1024) }],
      },
      ...Array.from({ length: 400 }, (_, index) => ({
        ...assistant(`step-${index}`, `Commentary ${index}`, 'tool-calls'),
        content: [{ type: 'tool', state: { output: 'T'.repeat(32 * 1024) } }],
      })),
      assistant('final'),
      idle('done'),
    ];
    f.messages.set(f.session.id, history);
    await f.archive.archive([f.session]);
    const baseline = readArchive().turns;
    const apiRequests = f.request.mock.calls.length;
    const apiBytes = f.controls.responseBytes;
    localHistory(f, history);
    f.request.mockClear();
    f.controls.responseBytes = 0;
    const projected = await new LocalSessionTranscriptReader().read([f.session]);
    const projectedBytes = Buffer.byteLength(JSON.stringify([...projected]));
    const progress: string[] = [];
    await f.archive.archive([f.session], { onProgress: (message) => progress.push(message) });
    expect(readArchive().turns).toEqual(baseline);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.controls.responseBytes).toBe(0);
    expect(apiRequests).toBe(4);
    expect(apiBytes).toBeGreaterThan(13 * 1024 * 1024);
    expect(projectedBytes).toBeLessThan(150_000);
    expect(progress).toContain('Read local transcript session: 403 messages');
    expect(progress.at(-1)).toContain('committing archive');
    await writeFile(
      resolve('artifacts/transcript-projection-profile.json'),
      JSON.stringify(
        {
          environment: 'isolated SQLite and API fixture; not production runtime',
          messages: history.length,
          baseline: { apiRequests, apiBytes },
          optimized: {
            apiRequests: f.request.mock.calls.length,
            apiBytes: f.controls.responseBytes,
            projectedBytes,
          },
          identicalTurns: true,
        },
        null,
        2
      )
    );
  });

  it('hydrates only pasted-text and annotation blobs, not image blobs', async () => {
    const f = await fixture();
    const pastedHash = 'a'.repeat(64);
    const annotationHash = 'b'.repeat(64);
    const history = [
      {
        ...user('prompt'),
        files: [
          { mime: 'text/plain', name: 'pasted-text-1234abcd.txt', uri: `media:${pastedHash}` },
          { mime: 'text/plain', name: 'annotation-1234abcd.txt', uri: `media:${annotationHash}` },
          // No matching image blob exists. Reading it would fail this archive.
          { mime: 'image/png', name: 'image.png', uri: `media:${'c'.repeat(64)}` },
        ],
      },
      assistant('answer'),
      idle('done'),
    ];
    const database = localHistory(f, history);
    const insert = database.prepare('INSERT INTO blob VALUES (?, ?)');
    insert.run(pastedHash, Buffer.from('Pasted request\n精确'));
    insert.run(annotationHash, Buffer.from('Selected text and comment'));
    await f.archive.archive([f.session]);
    expect(f.request).not.toHaveBeenCalled();
    expect(readArchive().turns).toMatchObject([
      {
        data: {
          prompts: [
            {
              attachments: [
                { text: 'Pasted request\n精确', omitted: false },
                { text: 'Selected text and comment', omitted: false },
                { name: 'image.png', omitted: true },
              ],
            },
          ],
        },
      },
    ]);
  });

  it('lets stored reasoning/tool parts override stale inline text without promoting commentary', async () => {
    const f = await fixture();
    const database = localHistory(f, [
      user('prompt'),
      assistant('answer', 'STALE_INLINE'),
      idle('done'),
    ]);
    database
      .prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, ?)')
      .run(
        'answer',
        f.session.id,
        0,
        'tool',
        JSON.stringify({ type: 'tool', state: { output: 'PRIVATE_TOOL' } })
      );
    await f.archive.archive([f.session]);
    expect(readArchive().turns[0]?.data).not.toHaveProperty('response');
    expect(f.request).not.toHaveBeenCalled();
  });

  it('reads separately stored text in ordinal order, not insertion order', async () => {
    const f = await fixture();
    const database = localHistory(f, [
      user('prompt'),
      assistant('answer', 'STALE_INLINE'),
      idle('done'),
    ]);
    const insert = database.prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, ?)');
    insert.run('answer', f.session.id, 2, 'text', JSON.stringify({ type: 'text', text: 'Second' }));
    insert.run('answer', f.session.id, 0, 'text', JSON.stringify({ type: 'text', text: 'First' }));
    await f.archive.archive([f.session]);
    expect(readArchive().turns).toMatchObject([
      { data: { response: { text: 'First\n\nSecond' } } },
    ]);
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(['fork', 'revert', 'schema', 'part-schema', 'part-type', 'content'])(
    'falls back to API history for unsupported %s',
    async (kind) => {
      const f = await fixture();
      const history = [user('prompt'), assistant('answer'), idle('done')];
      f.messages.set(f.session.id, history);
      const database = localHistory(f, history);
      if (kind === 'fork') database.exec("UPDATE session_v2 SET fork_session_id = 'parent'");
      if (kind === 'revert') database.exec("UPDATE session_v2 SET revert = '{}' ");
      if (kind === 'schema') database.exec('ALTER TABLE session_v2 DROP COLUMN revert');
      if (kind === 'part-schema') database.exec('ALTER TABLE session_part DROP COLUMN data');
      if (kind === 'part-type')
        database
          .prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, ?)')
          .run(
            'answer',
            f.session.id,
            0,
            'text',
            JSON.stringify({ type: 'reasoning', text: 'Private' })
          );
      if (kind === 'content')
        database.exec(
          "UPDATE session_message SET data = json_remove(data, '$.content') WHERE type = 'assistant'"
        );
      await f.archive.archive([f.session]);
      expect(f.request).toHaveBeenCalled();
      expect(readArchive().turns).toMatchObject([
        { data: { response: { text: 'Exact final response' }, outcome: 'succeeded' } },
      ]);
    }
  );

  it.each([
    'stale',
    'missing-session',
    'json',
    'text',
    'part-owner',
    'part-ordinal',
    'part-text',
    'blob',
    'unknown-type',
  ])('fails closed on local %s without falling back or replacing a good archive', async (kind) => {
    const f = await fixture();
    const history = [user('prompt'), assistant('answer'), idle('done')];
    f.messages.set(f.session.id, history);
    await f.archive.archive([f.session]);
    const baseline = readArchive().turns;
    const database = localHistory(f, history);
    if (kind === 'stale') database.exec('UPDATE session_v2 SET time_updated = 101');
    if (kind === 'missing-session') database.exec('DELETE FROM session_v2');
    if (kind === 'json')
      database.exec("UPDATE session_message SET data = 'broken' WHERE type = 'assistant'");
    if (kind === 'text')
      database.exec(
        "UPDATE session_message SET data = json_set(data, '$.text', 42) WHERE type = 'user'"
      );
    if (kind === 'unknown-type')
      database.exec("UPDATE session_message SET type = 'new-unknown-type' WHERE type = 'idle'");
    if (kind === 'part-owner' || kind === 'part-ordinal' || kind === 'part-text')
      database
        .prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, ?)')
        .run(
          'answer',
          kind === 'part-owner' ? 'other' : f.session.id,
          kind === 'part-ordinal' ? -1 : 0,
          'text',
          JSON.stringify({ type: 'text', text: kind === 'part-text' ? 42 : 'Text' })
        );
    if (kind === 'blob')
      database
        .prepare(
          "UPDATE session_message SET data = json_set(data, '$.files', json(?)) WHERE type = 'user'"
        )
        .run(
          JSON.stringify([
            {
              mime: 'text/plain',
              name: 'pasted-text-1234abcd.txt',
              uri: `media:${'a'.repeat(64)}`,
            },
          ])
        );
    f.request.mockClear();
    await expect(f.archive.archive([f.session])).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    expect(readArchive().turns).toEqual(baseline);
  });

  it.each(['local', 'api', 'before-write'])(
    'cancels %s transcript work before persistence',
    async (source) => {
      const f = await fixture();
      const history = [user('prompt'), assistant('answer'), idle('done')];
      f.messages.set(f.session.id, history);
      if (source === 'local') localHistory(f, history);
      const controller = new AbortController();
      await expect(
        f.archive.archive([f.session], {
          signal: controller.signal,
          onProgress: (message) => {
            if (
              (source === 'local' && message.startsWith('Reading local')) ||
              (source === 'api' && message.includes('2 messages')) ||
              (source === 'before-write' && message.startsWith('Writing trimmed'))
            )
              controller.abort();
          },
        })
      ).rejects.toThrow(/cancelled|aborted/i);
      expect(controller.signal.aborted).toBe(true);
      if (source === 'api') expect(f.request).toHaveBeenCalledTimes(1);
      await expect(stat(sessionTranscriptArchivePath())).rejects.toThrow('ENOENT');
    }
  );

  it('aborts a stalled API request at the overall history deadline', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    f.request.mockImplementation(
      async (_method, _path, _body, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('Request aborted')), {
            once: true,
          });
        })
    );
    const operation = f.archive.archive([f.session]);
    const rejected = expect(operation).rejects.toThrow('timed out after 60 seconds');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(f.request.mock.calls[0]?.[3]?.signal?.aborted).toBe(true);
    await expect(stat(sessionTranscriptArchivePath())).rejects.toThrow('ENOENT');
    expect(vi.getTimerCount()).toBe(0);
  });

  it("follows the last nonempty page through OpenCode's null-cursor empty terminal page", async () => {
    const f = await fixture();
    f.messages.set(f.session.id, [user('prompt'), assistant('answer'), idle('done')]);
    await f.archive.archive([f.session]);
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.request.mock.calls.at(-1)?.[1]).toContain('cursor=3');
    expect(readArchive().turns).toMatchObject([
      { data: { prompts: [{ id: 'prompt' }], response: { id: 'answer' }, outcome: 'succeeded' } },
    ]);
  });

  it('archives an empty session when both cursor directions are null', async () => {
    const f = await fixture();
    await f.archive.archive([f.session]);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(readArchive().sessions).toHaveLength(1);
    expect(readArchive().turns).toEqual([]);
  });

  it('also accepts an omitted next cursor on the terminal page', async () => {
    const f = await fixture();
    f.controls.nullEndCursor = false;
    f.messages.set(f.session.id, [user('prompt'), assistant('answer')]);
    await f.archive.archive([f.session]);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(readArchive().turns).toMatchObject([{ data: { response: { id: 'answer' } } }]);
  });

  it.skipIf(process.platform === 'win32')(
    'creates private files and refuses to follow an archive symlink',
    async () => {
      const f = await fixture();
      const original = join(f.root, 'original.txt');
      await writeFile(original, 'Do not change this file');
      await symlink(original, sessionTranscriptArchivePath());
      await expect(f.archive.archive([f.session])).rejects.toThrow('not a symlink');
      expect(await readFile(original, 'utf8')).toBe('Do not change this file');
      await rm(sessionTranscriptArchivePath());
      await f.archive.archive([f.session]);
      if (process.platform !== 'win32')
        expect((await stat(sessionTranscriptArchivePath())).mode & 0o777).toBe(0o600);
    }
  );

  it.each(['api', 'local-inline', 'local-parts'])(
    'preserves exact prompts, final Markdown, steering, metadata and text attachments without tool or image payloads through %s',
    async (source) => {
      const f = await fixture();
      const pasted = 'Long pasted request\n\nKeep all of this text.';
      const final = '## Result\n\n```ts\nconst value = 42;\n```\n';
      const history = [
        {
          ...user('prompt'),
          files: [
            {
              mime: 'text/plain',
              name: 'pasted-text-1234abcd.txt',
              data: Buffer.from(pasted).toString('base64'),
            },
            {
              mime: 'text/plain',
              name: 'annotation-1234abcd.txt',
              data: Buffer.from('Selected text and user comment').toString('base64'),
            },
            {
              mime: 'image/png',
              name: 'image.png',
              data: 'PRIVATE_IMAGE_BYTES',
              source: { path: '/external/original.png' },
            },
          ],
        },
        {
          ...assistant('work', 'Discard intermediate commentary', 'tool-calls'),
          native: { private: 'PRIVATE_NATIVE' },
          snapshot: { start: 'PRIVATE_SNAPSHOT' },
          content: [
            { type: 'text', text: 'Discard intermediate commentary' },
            { type: 'reasoning', text: 'PRIVATE_REASONING' },
            {
              type: 'tool',
              state: {
                input: 'PRIVATE_TOOL_INPUT',
                content: [{ type: 'text', text: 'PRIVATE_TOOL_OUTPUT' }],
              },
            },
          ],
        },
        user('steer', 'Also test it'),
        assistant('final', final),
        idle('done'),
        { id: 'notice', type: 'synthetic', text: 'PRIVATE_BACKGROUND_NOTICE' },
        assistant('background-final', 'Background job completed'),
        idle('background-done'),
        user('followup', 'Next question'),
        assistant('followup-final', 'Next answer'),
        idle('followup-done'),
      ];
      f.messages.set(f.session.id, history);
      if (source !== 'api') {
        const database = localHistory(f, history);
        if (source === 'local-parts') {
          const insert = database.prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, ?)');
          for (const message of history) {
            if (
              message.type !== 'assistant' ||
              !('content' in message) ||
              !Array.isArray(message.content)
            )
              continue;
            message.content.forEach((part, index) =>
              insert.run(message.id, f.session.id, index, part.type, JSON.stringify(part))
            );
          }
          database.exec(
            "UPDATE session_message SET data = json_set(data, '$.content', json('[]')) WHERE type = 'assistant'"
          );
        }
      }
      await f.archive.archive([f.session]);
      expect(sessionTranscriptArchivePath()).toBe(join(f.root, 'custom-transcripts.db'));
      const saved = readArchive();
      expect(saved.sessions).toMatchObject([
        {
          id: 'session',
          identity: 'original-v1',
          title: 'Original title',
          time_created: 1,
          time_updated: 100,
          source_version: 2,
        },
      ]);
      expect(saved.turns).toMatchObject([
        {
          ordinal: 0,
          data: {
            prompts: [
              {
                id: 'prompt',
                text: 'Exact user prompt',
                attachments: [
                  { name: 'pasted-text-1234abcd.txt', text: pasted, omitted: false },
                  {
                    name: 'annotation-1234abcd.txt',
                    text: 'Selected text and user comment',
                    omitted: false,
                  },
                  { name: 'image.png', mime: 'image/png', omitted: true },
                ],
              },
              { id: 'steer', text: 'Also test it' },
            ],
            response: {
              id: 'final',
              text: final,
              model: { providerID: 'provider', id: 'model', variant: 'high' },
            },
            outcome: 'succeeded',
            boundary: 'idle',
          },
        },
        {
          ordinal: 1,
          data: {
            prompts: [],
            response: { text: 'Background job completed' },
            outcome: 'succeeded',
          },
        },
        {
          ordinal: 2,
          data: { prompts: [{ text: 'Next question' }], response: { text: 'Next answer' } },
        },
      ]);
      const bytes = await readFile(sessionTranscriptArchivePath());
      expect(bytes.includes(Buffer.from('PRIVATE_'))).toBe(false);
      expect(bytes.includes(Buffer.from('Discard intermediate commentary'))).toBe(false);
      expect(bytes.includes(Buffer.from('/external/original.png'))).toBe(false);
      if (source === 'api') expect(f.request.mock.calls.length).toBeGreaterThan(1);
      else expect(f.request).not.toHaveBeenCalled();
    }
  );

  it('retains failed/interrupted outcomes and never upgrades tool-only commentary to a final answer', async () => {
    const f = await fixture();
    f.messages.set(f.session.id, [
      user('tool-only-prompt'),
      assistant('commentary', 'Not a final answer', 'tool-calls'),
      { ...assistant('tool-only'), content: [{ type: 'tool' }] },
      idle('tool-only-end'),
      user('interrupted-prompt'),
      assistant('partial', 'Partial response', 'tool-calls'),
      idle('interrupted-end', 'interrupted'),
      user('failed-prompt'),
      idle('failed-end', 'failed'),
      user('unanswered'),
    ]);
    await f.archive.archive([f.session]);
    const turns = readArchive().turns;
    expect(turns).toHaveLength(4);
    expect(turns[0]?.data).not.toHaveProperty('response');
    expect(turns[1]?.data).toMatchObject({
      outcome: 'interrupted',
      response: { text: 'Partial response' },
    });
    expect(turns[2]?.data).toMatchObject({ outcome: 'failed' });
    expect(turns[2]?.data).not.toHaveProperty('response');
    expect(turns[3]?.data).toMatchObject({
      outcome: 'unknown',
      boundary: 'inferred',
      prompts: [{ id: 'unanswered' }],
    });
  });

  it('preserves older inferred answers before newer explicit idle markers', async () => {
    const f = await fixture();
    f.messages.set(f.session.id, [
      user('first'),
      assistant('first-final', 'First answer'),
      user('second'),
      assistant('second-final', 'Second answer'),
      idle('done'),
    ]);
    await f.archive.archive([f.session]);
    expect(readArchive().turns).toMatchObject([
      { data: { response: { text: 'First answer' }, outcome: 'unknown', boundary: 'inferred' } },
      { data: { response: { text: 'Second answer' }, outcome: 'succeeded', boundary: 'idle' } },
    ]);
  });

  it('reads legacy history without a paging limit and excludes generated prompts and compaction summaries', async () => {
    const f = await fixture(1);
    const legacyUser = (id: string, text: string) => ({
      info: { id, role: 'user', time: { created: 1 } },
      parts: [{ type: 'text', text }],
    });
    const legacyAnswer = (id: string, text: string) => ({
      info: { id, role: 'assistant', time: { created: 2, completed: 3 }, finish: 'stop' },
      parts: [
        { type: 'text', text },
        { type: 'reasoning', text: 'PRIVATE_REASONING' },
      ],
    });
    f.messages.set(f.session.id, [
      legacyUser('first', 'First prompt'),
      {
        info: { id: 'generated', role: 'user', time: { created: 1 } },
        parts: [{ type: 'text', text: 'PRIVATE_SYNTHETIC', synthetic: true }],
      },
      legacyAnswer('first-answer', 'First final'),
      {
        info: { id: 'summary', role: 'assistant', summary: true },
        parts: [{ type: 'text', text: 'PRIVATE_COMPACTION' }],
      },
      {
        ...legacyUser('next', 'Second prompt'),
        parts: [
          { type: 'text', text: 'Second prompt' },
          {
            type: 'file',
            mime: 'text/plain',
            filename: 'pasted-text-1234abcd.txt',
            url: pastedTextDataUrl('Exact pasted text'),
          },
        ],
      },
      legacyAnswer('second-answer', 'Second final'),
    ]);
    await f.archive.archive([f.session]);
    expect(readArchive().turns).toMatchObject([
      {
        data: {
          prompts: [{ text: 'First prompt' }],
          response: { text: 'First final' },
          boundary: 'inferred',
          outcome: 'unknown',
        },
      },
      {
        data: {
          prompts: [
            { text: 'Second prompt', attachments: [{ text: 'Exact pasted text', omitted: false }] },
          ],
          response: { text: 'Second final' },
        },
      },
    ]);
    expect((await readFile(sessionTranscriptArchivePath())).includes(Buffer.from('PRIVATE_'))).toBe(
      false
    );
  });

  it.each(['repeatCursor', 'malformedCursor'] as const)(
    'refuses incomplete pagination: %s',
    async (control) => {
      const f = await fixture();
      f.messages.set(f.session.id, [user('prompt'), assistant('answer'), idle('done')]);
      f.controls[control] = true;
      await expect(f.archive.archive([f.session])).rejects.toThrow(/transcript/i);
      await expect(readFile(sessionTranscriptArchivePath())).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  );

  it.each([false, 0, '', [], {}])('rejects invalid non-null next cursors %#', async (next) => {
    const f = await fixture();
    f.request.mockResolvedValue({ data: [], cursor: { previous: null, next } });
    await expect(f.archive.archive([f.session])).rejects.toThrow('Malformed transcript pagination');
    await expect(readFile(sessionTranscriptArchivePath())).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    { id: 'bad', type: 'assistant', time: { created: 1 } },
    { id: 'bad', type: 'user', time: { created: 1 }, text: null },
    { id: 'bad', type: 'idle', outcome: 'mystery' },
    { id: 'bad', type: 'new-unknown-type' },
    {
      ...user('bad'),
      files: [{ mime: 'text/plain', name: 'annotation-1234abcd.txt', uri: 'media:unavailable' }],
    },
    { ...assistant('bad'), time: { created: 3, completed: 2 } },
  ])('fails closed on malformed or unavailable content %#', async (message) => {
    const f = await fixture();
    f.messages.set(f.session.id, [message]);
    await expect(f.archive.archive([f.session])).rejects.toThrow(/transcript/i);
    await expect(readFile(sessionTranscriptArchivePath())).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects duplicate message IDs across pages instead of silently losing content', async () => {
    const f = await fixture();
    f.messages.set(f.session.id, [user('same'), assistant('same'), idle('done')]);
    await expect(f.archive.archive([f.session])).rejects.toThrow(
      'repeated transcript message identity'
    );
  });

  it('retries idempotently, preserves newer snapshots, and rolls back the entire tree on write failure', async () => {
    const f = await fixture();
    f.messages.set(f.session.id, [user('prompt'), assistant('answer'), idle('done')]);
    await f.archive.archive([f.session]);
    await f.archive.archive([f.session]);
    expect(readArchive().sessions).toHaveLength(1);
    expect(readArchive().turns).toHaveLength(1);
    const second = { ...f.session, id: 'other', parentID: f.session.id };
    f.messages.set(second.id, [
      user('other-prompt'),
      assistant('other-answer'),
      idle('other-done'),
    ]);
    await expect(
      f.archive.archive([second, { ...f.session, updated: f.session.updated - 1 }])
    ).rejects.toThrow('newer transcript snapshot');
    expect(readArchive().sessions).toHaveLength(1);
    expect(readArchive().turns).toHaveLength(1);
    f.messages.set(f.session.id, [
      user('prompt'),
      assistant('answer', 'Updated answer'),
      idle('done'),
    ]);
    await f.archive.archive([{ ...f.session, updated: f.session.updated + 1 }]);
    expect(readArchive().turns).toMatchObject([{ data: { response: { text: 'Updated answer' } } }]);
  });

  it('does not write a partial archive when a later parent conversation cannot be read', async () => {
    const f = await fixture();
    f.messages.set(f.session.id, [user('prompt'), assistant('answer')]);
    f.messages.set('child', [{ id: 'bad', type: 'assistant' }]);
    await expect(f.archive.archive([f.session, { ...f.session, id: 'child' }])).rejects.toThrow(
      'content is missing'
    );
    await expect(readFile(sessionTranscriptArchivePath())).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses unknown archive schema versions without replacing existing data', async () => {
    const f = await fixture();
    await f.archive.archive([f.session]);
    const database = new DatabaseSync(sessionTranscriptArchivePath());
    database.exec('PRAGMA user_version = 999');
    database.close();
    await expect(f.archive.archive([f.session])).rejects.toThrow(
      'Unsupported transcript archive schema version'
    );
    expect(readArchive().sessions).toHaveLength(1);
  });
});
