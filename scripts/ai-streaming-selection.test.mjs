import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { readPlaybackCapture } from './ai-session-playback.mjs';
import { prepareStreamingRun } from './ai-streaming-selection.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varro-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  t.after(() => db.close());
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
    sourceDatabase,
    db,
    add,
    message,
    options: (overrides = {}) => ({
      sourceDatabase,
      directory: '/workspace',
      controllerSessionId: 'controller',
      seed: 'test-seed',
      outputDirectory: path.join(root, `run-${run++}`),
      ...overrides,
    }),
  };
}

test('selects diverse history deterministically, imports captures, and leaves source unchanged', async (t) => {
  const f = await fixture(t);
  f.add('prose', [
    { type: 'reasoning', text: 'Think' },
    { type: 'text', text: '# Result\n' + 'long '.repeat(900) },
  ]);
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
    first.rejected.some((item) => item.sourceSessionId === 'plain' && item.reason === 'count-limit')
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

test('excludes controller, incomplete sessions, wrong directories, and invalid user links', async (t) => {
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

test('seed breaks equal-score ties and scan is bounded to recent candidates', async (t) => {
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
  assert.ok(
    [...a.selected, ...a.rejected].every(
      (item) => !['session-0', 'session-1'].includes(item.sourceSessionId)
    )
  );
});

test('reports unavailable and count-limited coverage, including empty history', async (t) => {
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
      (item) => item.feature === 'tools' && item.reason === 'count-limit'
    )
  );
});

test('requires baseline history above the production virtualization threshold', async (t) => {
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

test('validates options and refuses to overwrite source aliases or previous output', async (t) => {
  const f = await fixture(t);
  for (const key of ['sourceDatabase', 'directory', 'controllerSessionId', 'outputDirectory']) {
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
