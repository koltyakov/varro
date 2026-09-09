import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, link, symlink, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import http from 'node:http';

import { readPlaybackCapture } from './ai-session-playback.mjs';
import { prepareStreamingRun, readActiveSessions } from './ai-streaming-selection.mjs';

// Real listener/database ownership checks require lsof. Mocked discovery tests run everywhere.
const ownershipTest = process.platform === 'win32' ? test.skip : test;

async function fixture(t) {
  const status = {};
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/session/status?directory=%2Fworkspace');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(status));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'varro-selection-'));
  const sourceDatabase = path.join(root, 'source.db');
  const db = new DatabaseSync(sourceDatabase);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, slug TEXT, project_id TEXT,
      title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE INDEX message_session ON message(session_id);
    CREATE INDEX part_message ON part(message_id);
  `);
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const message = (id, session, time, data) =>
    db
      .prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
      .run(id, session, time, JSON.stringify(data));
  const add = (
    id,
    parts = [],
    { directory = '/workspace', baseline = 0, completed = 500, time = 200 } = {}
  ) => {
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      directory,
      id,
      'project',
      id,
      '1',
      1,
      500
    );
    for (let i = 0; i < baseline; i++) message(`${id}-baseline-${i}`, id, i + 1, { role: 'user' });
    message(`${id}-user`, id, time - 1, { role: 'user', time: { created: time - 1 } });
    message(`${id}-assistant`, id, time, {
      role: 'assistant',
      parentID: `${id}-user`,
      time: { created: time, completed },
      finish: 'stop',
    });
    parts.forEach((part, i) =>
      db
        .prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          `${id}-part-${i}`,
          `${id}-assistant`,
          id,
          time + i + 1,
          time + i + 30,
          JSON.stringify(part)
        )
    );
  };
  let run = 0;
  return {
    root,
    status,
    serverUrl,
    sourceDatabase,
    db,
    add,
    message,
    options: (overrides = {}) => ({
      sourceDatabase,
      serverUrl,
      directory: '/workspace',
      controllerSessionId: 'controller',
      seed: 'test-seed',
      outputDirectory: path.join(root, `run-${run++}`),
      ...overrides,
    }),
  };
}

ownershipTest('selects diverse history deterministically, imports captures, and leaves source unchanged', async (t) => {
  const f = await fixture(t);
  f.add(
    'prose',
    [
      { type: 'reasoning', text: 'Think' },
      { type: 'text', text: '# Result\n' + 'long '.repeat(900) },
    ],
    { baseline: 1 }
  );
  f.add('edit', [
    {
      type: 'tool',
      tool: 'apply_patch',
      callID: 'call',
      state: {
        status: 'completed',
        input: { patchText: 'patch' },
        output: 'updated',
        time: { start: 210, end: 250 },
      },
    },
  ]);
  f.add('baseline', [{ type: 'text', text: 'short' }], { baseline: 130 });
  f.add('plain', [{ type: 'text', text: 'plain' }]);
  const before = await readFile(f.sourceDatabase);
  const first = await prepareStreamingRun(f.options());
  const second = await prepareStreamingRun(f.options());
  assert.deepEqual(
    first.selected.map((item) => item.sourceSessionId),
    ['prose', 'edit', 'baseline']
  );
  assert.equal(first.selectionHash, second.selectionHash);
  assert.deepEqual(
    first.selected.map((item) => item.selection),
    second.selected.map((item) => item.selection)
  );
  assert.equal(first.coverage.missing.length, 0);
  assert.equal(first.provenance.scenario, 'HISTORY');
  assert.equal(first.provenance.cadence, 'reconstructed');
  assert.ok(
    first.rejected.some(
      (item) => item.sourceSessionId === 'plain' && item.reason === 'outside-longest-session-subset'
    )
  );
  assert.deepEqual(JSON.parse(await readFile(first.manifestPath, 'utf8')), first);
  for (const item of first.selected) {
    const capture = readPlaybackCapture(first.playbackDatabase, item.capture.id);
    const bytes = await readFile(item.capture.path);
    assert.deepEqual(JSON.parse(bytes), capture);
    assert.equal(item.capture.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(capture.finalMessages.at(-1).info.id, item.sourceMessageId);
    assert.equal(capture.finalMessages.at(-2).info.id, item.sourceUserMessageId);
    assert.equal(capture.initialMessages.length, item.metrics.baselineMessages);
    assert.equal(capture.scenario, 'HISTORY');
    assert.ok(item.timing.eventCount > 0);
    assert.ok(item.timing.reconstructedDurationMs > 0);
  }
  assert.deepEqual(await readFile(f.sourceDatabase), before);
});

ownershipTest('excludes controller, incomplete sessions, wrong directories, and invalid user links', async (t) => {
  const f = await fixture(t);
  for (const id of [
    'controller',
    'active',
    'null-completion',
    'bad-parent',
    'cross-parent',
    'good',
  ]) {
    f.add(id);
  }
  f.add('child-directory', [], { directory: '/workspace/child' });
  f.add('case-directory', [], { directory: '/Workspace' });
  f.message('unfinished', 'active', 1, { role: 'assistant', time: { created: 1 } });
  f.message('null-time', 'null-completion', 1, { role: 'assistant', time: { completed: null } });
  f.db
    .prepare("UPDATE message SET data = ? WHERE id = 'bad-parent-user'")
    .run(JSON.stringify({ role: 'system' }));
  f.db.prepare("UPDATE message SET data = ? WHERE id = 'cross-parent-assistant'").run(
    JSON.stringify({
      role: 'assistant',
      parentID: 'good-user',
      time: { created: 200, completed: 500 },
    })
  );
  const result = await prepareStreamingRun(f.options());
  assert.deepEqual(
    result.selected.map((item) => item.sourceSessionId),
    ['good']
  );
  assert.equal(result.shortfall, 2);
  for (const [id, reason] of [
    ['controller', 'controller-session'],
    ['active', 'session-has-incomplete-assistant'],
    ['null-completion', 'session-has-incomplete-assistant'],
    ['bad-parent', 'not-linked-to-user'],
    ['cross-parent', 'not-linked-to-user'],
  ]) {
    assert.ok(
      result.rejected.some((item) => item.sourceSessionId === id && item.reason === reason)
    );
  }
  assert.ok(result.rejected.every((item) => !item.sourceSessionId.includes('directory')));
  assert.ok(
    result.coverage.missing.every((item) => item.reason === 'unavailable-in-eligible-scan')
  );
});

ownershipTest('seed breaks equal-score ties and session scan is bounded', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 502; i++) f.add(`session-${i}`, [], { time: 1_000 + i });
  f.message('old-incomplete', 'session-501', 1, { role: 'assistant', time: { created: 1 } });
  const a = await prepareStreamingRun(f.options({ seed: 1, count: 5 }));
  const b = await prepareStreamingRun(f.options({ seed: 1, count: 5 }));
  const c = await prepareStreamingRun(f.options({ seed: 2, count: 5 }));
  assert.equal(a.scan.scanned, 500);
  assert.equal(a.scan.truncated, true);
  assert.ok(
    a.rejected.some(
      (item) =>
        item.sourceSessionId === 'session-501' && item.reason === 'session-has-incomplete-assistant'
    )
  );
  assert.equal(a.selectionHash, b.selectionHash);
  assert.notDeepEqual(
    a.selected.map((item) => item.sourceMessageId),
    c.selected.map((item) => item.sourceMessageId)
  );
  assert.equal(new Set(a.selected.map((item) => item.sourceSessionId)).size, 5);
});

ownershipTest('reports unavailable and count-limited coverage, including empty history', async (t) => {
  const f = await fixture(t);
  const empty = await prepareStreamingRun(f.options());
  assert.equal(empty.selectedCount, 0);
  assert.equal(empty.shortfall, 3);
  assert.equal(empty.coverage.missing.length, 7);
  f.add('prose', [
    { type: 'text', text: '# Heading' },
    { type: 'reasoning', text: 'Think' },
  ]);
  f.add('tool', [
    { type: 'tool', tool: 'bash', state: { status: 'completed', input: {}, output: 'ok' } },
  ]);
  const result = await prepareStreamingRun(f.options({ count: 1 }));
  assert.ok(
    result.coverage.missing.some(
      (item) => item.feature === 'tools' && item.reason === 'outside-longest-session-subset'
    )
  );
});

ownershipTest('requires baseline history above the production virtualization threshold', async (t) => {
  const f = await fixture(t);
  f.add('below', [], { baseline: 40 });
  f.add('boundary', [], { baseline: 50 });
  f.add('above', [], { baseline: 51 });
  const result = await prepareStreamingRun(f.options());
  for (const candidate of result.selected) {
    assert.equal(
      candidate.features.includes('baseline_virtualization'),
      candidate.sourceSessionId === 'above'
    );
  }
  assert.equal(result.policy.baselineMessages, 51);
});

ownershipTest('validates options and refuses to overwrite source aliases or previous output', async (t) => {
  const f = await fixture(t);
  for (const key of ['sourceDatabase', 'directory', 'outputDirectory']) {
    for (const value of [undefined, '', ' ', 1]) {
      await assert.rejects(prepareStreamingRun(f.options({ [key]: value })), new RegExp(key));
    }
  }
  for (const count of [0, -1, 1.5, '3', 501, NaN, Infinity]) {
    await assert.rejects(prepareStreamingRun(f.options({ count })), /count/);
  }
  for (const seed of [undefined, '', ' ', {}, null, NaN, Infinity, 1.5]) {
    await assert.rejects(prepareStreamingRun(f.options({ seed })), /seed/);
  }
  f.add('good');
  const options = f.options();
  await prepareStreamingRun(options);
  await assert.rejects(prepareStreamingRun(options), /EEXIST/);
  const before = await readFile(f.sourceDatabase);
  await link(f.sourceDatabase, path.join(f.root, 'playback.db'));
  await assert.rejects(prepareStreamingRun(f.options({ outputDirectory: f.root })), /EEXIST/);
  assert.deepEqual(await readFile(f.sourceDatabase), before);
});

ownershipTest('automatically excludes busy and retry sessions even with complete stored history', async (t) => {
  const f = await fixture(t);
  f.add('busy', [], { baseline: 100 });
  f.add('retry', [], { baseline: 90 });
  f.add('long', [{ type: 'text', text: 'long history' }], { baseline: 80 });
  f.add('short', [{ type: 'reasoning', text: 'richer response' }]);
  f.status.busy = { type: 'busy' };
  f.status.retry = { type: 'retry' };
  const result = await prepareStreamingRun(f.options({ controllerSessionId: undefined, count: 1 }));
  assert.deepEqual(
    result.selected.map((item) => item.sourceSessionId),
    ['long']
  );
  assert.deepEqual(result.activity.activeSessionIds, ['busy', 'retry']);
  assert.equal(result.controllerSessionId, null);
  assert.equal(result.rejected.filter((item) => item.reason === 'active-session').length, 2);
  const filtered = await prepareStreamingRun(f.options({ sourceSessionId: 'short' }));
  assert.deepEqual(
    filtered.selected.map((item) => item.sourceSessionId),
    ['short']
  );
  assert.equal(filtered.shortfall, 2);
});

ownershipTest('chooses response coverage within the longest distinct session subset', async (t) => {
  const f = await fixture(t);
  f.add('long', [{ type: 'text', text: '# Markdown' }], { baseline: 20 });
  f.message('another', 'long', 600, {
    role: 'assistant',
    parentID: 'long-user',
    time: { created: 600, completed: 700 },
  });
  f.add('second', [], { baseline: 10 });
  f.add('short', [{ type: 'reasoning', text: 'outside subset' }]);
  const result = await prepareStreamingRun(f.options({ count: 2 }));
  assert.deepEqual(result.policy.sessionSubset, ['long', 'second']);
  assert.deepEqual(
    result.selected.map((item) => item.sourceMessageId),
    ['long-assistant', 'second-assistant']
  );
  assert.ok(
    result.rejected.some(
      (item) => item.sourceMessageId === 'another' && item.reason === 'distinct-session-limit'
    )
  );
});

test('status discovery uses only PID listeners and fails closed on missing or invalid evidence', async (t) => {
  const f = await fixture(t);
  const port = new URL(f.serverUrl).port;
  const discovered = await readActiveSessions(
    { sourceDatabase: f.sourceDatabase, directory: '/workspace', pid: '123' },
    async (command, args) => {
      assert.equal(command, 'lsof');
      assert.ok(args.includes('123'));
      if (args.includes('--')) return { stdout: 'p123\nf10\n' };
      return { stdout: `p123\nn127.0.0.1:${port}\n` };
    }
  );
  assert.equal(discovered.serverUrl, f.serverUrl);
  const other = await fixture(t);
  await assert.rejects(
    readActiveSessions(
      { sourceDatabase: f.sourceDatabase, directory: '/workspace', pid: '123' },
      async (_command, args) => ({
        stdout: args.includes('--')
          ? 'p123\nf10\n'
          : `p123\nn127.0.0.1:${port}\nn127.0.0.1:${new URL(other.serverUrl).port}\n`,
      })
    ),
    /supply --server-url/
  );
  await assert.rejects(readActiveSessions({ directory: '/workspace', pid: '' }), /requires/);
  await assert.rejects(
    readActiveSessions(
      { sourceDatabase: f.sourceDatabase, directory: '/workspace', pid: '123' },
      async () => ({ stdout: '' })
    ),
    /supply --server-url/
  );
  f.status.bad = { type: 'unknown' };
  await assert.rejects(
    readActiveSessions(
      { sourceDatabase: f.sourceDatabase, directory: '/workspace', serverUrl: f.serverUrl },
      async (_command, args) => ({
        stdout: args.includes('--') ? 'p123\nf10\n' : `p123\nn127.0.0.1:${port}\n`,
      })
    ),
    /Invalid session status/
  );
  await assert.rejects(
    readActiveSessions({ directory: '/workspace', serverUrl: 'https://example.com' }),
    /loopback/
  );
});

ownershipTest('IPv6 discovery preserves the listener host and verifies the canonical database path', async (t) => {
  const f = await fixture(t);
  const server = http.createServer((_request, response) => response.end('{}'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '::1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const alias = path.join(f.root, 'alias.db');
  await symlink(f.sourceDatabase, alias);
  const canonicalDatabase = await realpath(f.sourceDatabase);
  const result = await readActiveSessions(
    { sourceDatabase: alias, directory: '/workspace', pid: '123' },
    async (_command, args) => {
      if (args.includes('--')) {
        assert.equal(args.at(-1), canonicalDatabase);
        assert.deepEqual(args.slice(0, -1), ['-nP', '-a', '-p', '123', '-Fpf', '--']);
        return { stdout: 'p123\nf10\n' };
      }
      return { stdout: `p123\nn[::1]:${server.address().port}\n` };
    }
  );
  assert.equal(result.serverUrl, `http://[::1]:${server.address().port}`);
  assert.equal(result.sourceDatabase, canonicalDatabase);
  assert.equal(result.serverPid, 123);
  const explicit = await readActiveSessions({
    sourceDatabase: alias,
    directory: '/workspace',
    serverUrl: result.serverUrl,
  });
  assert.equal(explicit.serverPid, process.pid);
});

test('automatic and explicit status endpoints fail closed without matching open database ownership', async (t) => {
  const f = await fixture(t);
  for (const serverUrl of [undefined, f.serverUrl]) {
    for (const held of ['', 'p999\nf10\n', 'p123\nfcwd\n']) {
      await assert.rejects(
        readActiveSessions(
          { sourceDatabase: f.sourceDatabase, directory: '/workspace', pid: '123', serverUrl },
          async (_command, args) => ({
            stdout: args.includes('--') ? held : `p123\nn127.0.0.1:${new URL(f.serverUrl).port}\n`,
          })
        ),
        /does not hold source database/
      );
    }
  }
  await assert.rejects(
    readActiveSessions(
      { sourceDatabase: f.sourceDatabase, directory: '/workspace', serverUrl: f.serverUrl },
      async () => ({ stdout: '' })
    ),
    /listener owner/
  );
  await assert.rejects(
    readActiveSessions(
      { sourceDatabase: f.sourceDatabase, directory: '/workspace', pid: '123' },
      async (_command, args) => {
        if (args.includes('--')) throw new Error('permission denied');
        return { stdout: `p123\nn127.0.0.1:${new URL(f.serverUrl).port}\n` };
      }
    ),
    /Cannot verify.*permission denied/
  );
});

ownershipTest('real status ownership verifies open databases and their aliases', async (t) => {
  const f = await fixture(t);
  const actual = await readActiveSessions({
    sourceDatabase: f.sourceDatabase,
    directory: '/workspace',
    serverUrl: f.serverUrl,
  });
  assert.equal(actual.serverPid, process.pid);
  assert.equal(actual.association, 'lsof-listener-owner-and-open-database');
  const unopened = path.join(f.root, 'unopened.db');
  await copyFile(f.sourceDatabase, unopened);
  await assert.rejects(
    readActiveSessions({
      sourceDatabase: unopened,
      directory: '/workspace',
      serverUrl: f.serverUrl,
    }),
    /Cannot verify.*holds source database/
  );
  const alias = path.join(f.root, 'alias.db');
  await symlink(f.sourceDatabase, alias);
  const aliased = await readActiveSessions({
    sourceDatabase: alias,
    directory: '/workspace',
    serverUrl: f.serverUrl,
  });
  assert.equal(aliased.sourceDatabase, await realpath(f.sourceDatabase));
  const hardAlias = path.join(f.root, 'hard-alias.db');
  await link(f.sourceDatabase, hardAlias);
  const hardLinked = await readActiveSessions({
    sourceDatabase: hardAlias,
    directory: '/workspace',
    serverUrl: f.serverUrl,
  });
  assert.equal(hardLinked.serverPid, process.pid);
});

ownershipTest('records response truncation and checks incompleteness beyond the response scan', async (t) => {
  const f = await fixture(t);
  f.add('long');
  for (let i = 0; i < 51; i++)
    f.message(`extra-${i}`, 'long', 1_000 + i, {
      role: 'assistant',
      parentID: 'long-user',
      time: { created: 1_000 + i, completed: 2_000 },
    });
  const result = await prepareStreamingRun(f.options());
  assert.equal(result.scan.truncated, true);
  assert.equal(result.scan.eligible, 50);
  f.message('old-incomplete', 'long', 1, { role: 'assistant', time: { created: 1 } });
  const excluded = await prepareStreamingRun(f.options());
  assert.equal(excluded.selectedCount, 0);
  assert.equal(excluded.rejected.length, 50);
});
