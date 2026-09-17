import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LegacySessionImport } from './legacy-session-import';
import { asRecord, type UnknownRecord } from '../shared/type-utils';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture() {
  const parent = resolve('artifacts/ai-test-data');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'legacy-import-'));
  directories.push(directory);
  const database = join(directory, 'opencode.db');
  const db = new DatabaseSync(database);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);`);
  for (const [id, parentID] of [
    ['root', null],
    ['child', 'root'],
  ] as const) {
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run(id, parentID, '/fixture', id, 1, 2);
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(
      `message-${id}`,
      id,
      1,
      JSON.stringify({
        role: 'assistant',
        agent: 'build',
        modelID: 'model',
        providerID: 'provider',
        time: { created: 1, completed: 2 },
        finish: 'stop',
      })
    );
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run(
      `part-${id}`,
      id,
      `message-${id}`,
      1,
      JSON.stringify({
        type: 'tool',
        tool: 'task',
        callID: `call-${id}`,
        state: {
          status: 'completed',
          input: {},
          output: 'Retained output',
          metadata: { sessionId: 'child' },
          time: { start: 1, end: 2 },
        },
      })
    );
  }
  const before = JSON.stringify(
    ['session', 'message', 'part'].map((table) => db.prepare(`SELECT * FROM ${table}`).all())
  );
  db.close();
  return { database, before };
}

describe('explicit legacy session copy import', () => {
  it('copies a tree with new identities, remaps child links, and preserves source records', async () => {
    const { database, before } = await fixture();
    const payloads: UnknownRecord[] = [];
    const request: ConstructorParameters<typeof LegacySessionImport>[0] = vi.fn(
      async (method, path, body) => {
        if (method === 'GET' && path.startsWith('/api/location'))
          return { project: { id: 'project' } };
        expect(method).toBe('POST');
        expect(path).toBe('/api/experimental/session/import');
        payloads.push(asRecord(body)!);
        return {};
      }
    );
    const importer = new LegacySessionImport(request, database);
    const choices = await importer.list('/fixture');
    expect(choices).toEqual([{ id: 'root', title: 'root', directory: '/fixture' }]);
    expect(await importer.list('/other')).toEqual([]);
    const id = await importer.importCopy(choices[0]!);
    expect(id).not.toBe('root');
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({
      info: { id, metadata: { varroLegacyImport: { sourceSessionID: 'root' } } },
    });
    const childID = asRecord(payloads[1]?.info)?.id;
    expect(payloads[1]).toMatchObject({ info: { parentID: id } });
    expect(payloads[0]).toMatchObject({
      messages: [
        {
          content: [
            {
              name: 'subagent',
              state: {
                status: 'completed',
                metadata: { sessionId: childID },
                content: [{ type: 'text', text: 'Retained output' }],
              },
            },
          ],
          metadata: {
            varroLegacy: {
              info: { id: 'message-root', sessionID: 'root' },
              parts: [{ state: { metadata: { sessionId: 'child' } } }],
            },
          },
        },
      ],
    });
    const source = new DatabaseSync(database, { readOnly: true });
    expect(
      JSON.stringify(
        ['session', 'message', 'part'].map((table) =>
          source.prepare(`SELECT * FROM ${table}`).all()
        )
      )
    ).toBe(before);
    source.close();
  });

  it('removes only newly imported copies when a descendant import fails', async () => {
    const { database } = await fixture();
    const created: string[] = [];
    const deleted: string[] = [];
    const request: ConstructorParameters<typeof LegacySessionImport>[0] = vi.fn(
      async (method, path, body) => {
        if (method === 'GET') return { project: { id: 'project' } };
        if (method === 'DELETE') {
          deleted.push(path);
          return {};
        }
        if (created.length) throw new Error('Import rejected');
        created.push(String(asRecord(asRecord(body)?.info)?.id));
        return {};
      }
    );
    await expect(
      new LegacySessionImport(request, database).importCopy({
        id: 'root',
        title: 'root',
        directory: '/fixture',
      })
    ).rejects.toThrow('Import rejected');
    expect(deleted).toEqual([`/api/session/${created[0]}`]);
    expect(created[0]).not.toBe('root');
  });
});
