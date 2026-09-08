import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs, { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  buildReplayTimeline,
  eventBelongsToSession,
  normalizeCapturedEvents,
  readPlaybackCapture,
  replay,
  reconstructHistoricalEvents,
  savePlaybackCapture,
} from './ai-session-playback.mjs';

test('normal discovery excludes local capture playback', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const cli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));
  for (const local of [false, true]) {
    const report = JSON.parse(
      execFileSync(
        process.execPath,
        [
          cli,
          'test',
          '--list',
          '--reporter=json',
          ...(local ? ['--config', 'playwright.ai-playback.config.ts'] : []),
        ],
        {
          cwd,
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            VARRO_PLAYBACK_ID: '92',
            VARRO_PLAYBACK_FILE: path.join(cwd, 'nonexistent-playback-capture.json'),
          },
        }
      )
    );
    const files = report.suites.map((suite) => suite.file);
    if (local) {
      assert.deepEqual(files, ['session-playback.spec.ts']);
      assert.equal(report.config.workers, 1);
      const servers = [report.config.webServer].flat();
      assert.ok(servers[0], 'playback must expose a single web server, not a merged server array');
      assert.equal(servers.length, 1);
      assert.equal(servers[0].reuseExistingServer, true);
    } else {
      assert.ok(files.includes('scroll-tool-flicker.spec.ts'));
      assert.ok(files.every((file) => !file.includes('session-playback.spec.ts')));
      const flicker = report.suites.find((suite) => suite.file === 'scroll-tool-flicker.spec.ts');
      assert.equal(flicker.specs.length, 5);
      assert.ok(
        flicker.specs.some(
          (spec) => spec.title === 'mocked session playback has no frame-level flicker'
        )
      );
    }
  }
});

test('preserves short event gaps and caps long idle gaps', () => {
  const timeline = buildReplayTimeline([
    { offsetMs: 20, event: { type: 'one' } },
    { offsetMs: 120, event: { type: 'two' } },
    { offsetMs: 5_120, event: { type: 'three' } },
  ]);
  assert.deepEqual(
    timeline.map(({ delayMs, sourceGapMs }) => ({ delayMs, sourceGapMs })),
    [
      { delayMs: 20, sourceGapMs: 20 },
      { delayMs: 100, sourceGapMs: 100 },
      { delayMs: 500, sourceGapMs: 5_000 },
    ]
  );
});

test('never lengthens medium gaps and preserves burst and threshold timing', () => {
  const gaps = [0, 1, 249, 250, 251, 300, 499, 500, 501, 30_000];
  let offsetMs = 0;
  const timeline = buildReplayTimeline(
    gaps.map((gap) => ({
      offsetMs: (offsetMs += gap),
      event: { type: 'test' },
    }))
  );
  assert.deepEqual(
    timeline.map((entry) => entry.delayMs),
    [0, 1, 249, 250, 251, 300, 499, 500, 500, 500]
  );
  for (const value of [NaN, Infinity, -1]) {
    assert.throws(() => buildReplayTimeline([], { shortGapMs: value }), /timing/);
    assert.throws(() => buildReplayTimeline([], { maxGapMs: value }), /timing/);
  }
});

test('filters another session and removes stream sequence metadata', () => {
  const own = {
    offsetMs: 10,
    event: {
      id: 'event-1',
      seq: 9,
      type: 'message.part.updated',
      properties: { part: { sessionID: 'session-a' } },
    },
  };
  const other = {
    offsetMs: 20,
    event: { type: 'session.status', properties: { sessionID: 'session-b' } },
  };
  assert.equal(eventBelongsToSession(own.event, 'session-a'), true);
  assert.equal(
    eventBelongsToSession(
      { type: 'session.updated', properties: { info: { id: 'session-a' } } },
      'session-a'
    ),
    true
  );
  assert.deepEqual(normalizeCapturedEvents([own, other], 'session-a'), [
    {
      offsetMs: 10,
      event: { type: 'message.part.updated', properties: { part: { sessionID: 'session-a' } } },
    },
  ]);
});

test('round trips a capture through SQLite', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'varro-playback-'));
  const filePath = path.join(directory, 'capture.db');
  try {
    const saved = savePlaybackCapture(filePath, {
      label: 'tool completion',
      scenario: 'AI-07',
      capturedAt: '2026-09-05T00:00:00.000Z',
      model: 'openai/gpt-5.6-luna',
      session: { id: 'session-a', title: 'Captured session' },
      initialMessages: [],
      finalMessages: [{ info: { id: 'message-a' }, parts: [] }],
      events: [
        {
          offsetMs: 12,
          event: {
            type: 'session.status',
            properties: { sessionID: 'session-a', status: { type: 'busy' } },
          },
        },
      ],
    });
    assert.equal(saved.eventCount, 1);
    const capture = readPlaybackCapture(filePath, saved.id);
    assert.equal(capture.label, 'tool completion');
    assert.equal(capture.events[0].offsetMs, 12);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reconstructs historical text streaming and tool lifecycle boundaries', () => {
  const sessionID = 'session-a';
  const user = {
    info: { id: 'user-a', sessionID, role: 'user', time: { created: 100 } },
    parts: [{ id: 'user-part', sessionID, messageID: 'user-a', type: 'text', text: 'Run it' }],
  };
  const assistant = {
    info: {
      id: 'assistant-a',
      sessionID,
      role: 'assistant',
      parentID: 'user-a',
      time: { created: 200, completed: 500 },
      finish: 'stop',
    },
    parts: [],
  };
  const rows = [
    {
      id: 'text-a',
      message_id: 'assistant-a',
      session_id: sessionID,
      time_created: 210,
      time_updated: 260,
      data: JSON.stringify({ type: 'text', text: 'streamed response' }),
    },
    {
      id: 'tool-a',
      message_id: 'assistant-a',
      session_id: sessionID,
      time_created: 220,
      time_updated: 280,
      data: JSON.stringify({
        type: 'tool',
        tool: 'bash',
        callID: 'call-a',
        state: {
          status: 'completed',
          input: { command: 'npm test' },
          output: 'passed',
          title: 'Test',
          metadata: {},
          time: { start: 220, end: 280 },
        },
      }),
    },
  ];
  const events = reconstructHistoricalEvents(sessionID, user, assistant, rows);
  const toolStates = events
    .filter((entry) => entry.event.properties?.part?.id === 'tool-a')
    .map((entry) => entry.event.properties.part.state.status);
  const streamed = events
    .filter((entry) => entry.event.type === 'message.part.delta')
    .map((entry) => entry.event.properties.delta)
    .join('');
  assert.deepEqual(toolStates, ['pending', 'running', 'completed']);
  assert.equal(streamed, 'streamed response');
  assert.equal(events.at(-1).event.properties.status.type, 'idle');
});

test('long CLI and subagent waits compress without accelerating subsequent or concurrent deltas', () => {
  for (const wait of [10_000, 30_000]) {
    const tool = wait === 10_000 ? 'bash' : 'task';
    for (const spacing of [32, 100]) {
      const events = [
        {
          offsetMs: 0,
          event: {
            type: 'message.part.updated',
            properties: { part: { type: 'tool', tool, state: { status: 'running' } } },
          },
        },
        {
          offsetMs: wait,
          event: {
            type: 'message.part.updated',
            properties: { part: { type: 'tool', tool, state: { status: 'completed' } } },
          },
        },
        ...Array.from({ length: 20 }, (_, index) => ({
          offsetMs: wait + (index + 1) * spacing,
          event: { type: 'message.part.delta', properties: { delta: 'next token ' } },
        })),
      ];
      assert.deepEqual(
        buildReplayTimeline(events).map(({ delayMs }) => delayMs),
        [0, 500, ...Array(20).fill(spacing)]
      );
      events.splice(
        1,
        0,
        ...Array.from({ length: wait / spacing - 1 }, (_, index) => ({
          offsetMs: (index + 1) * spacing,
          event: { type: 'message.part.delta', properties: { delta: 'concurrent token ' } },
        }))
      );
      const timeline = buildReplayTimeline(events);
      assert.ok(timeline.every(({ delayMs, sourceGapMs }) => delayMs === sourceGapMs));
      assert.equal(
        timeline.reduce((sum, entry) => sum + entry.delayMs, 0),
        wait + 20 * spacing
      );
    }
  }
});

test('historical cadence spans persisted duration, preserves overlaps and settles canonically', () => {
  const sessionID = 'history';
  const user = { info: { id: 'user', sessionID }, parts: [] };
  const assistant = {
    info: {
      id: 'assistant',
      sessionID,
      time: { created: 1000, completed: 100_000 },
      finish: 'stop',
    },
    parts: [],
  };
  for (const type of ['text', 'reasoning']) {
    for (const duration of [100, 10_000, 30_000, 60_000]) {
      for (const persisted of [true, false]) {
        const text = 'Streaming a realistic response. '.repeat(1000);
        const part = {
          type,
          text,
          time: persisted ? { start: 2000, end: 2000 + duration } : undefined,
        };
        const rows = [
          {
            id: 'stream',
            message_id: 'assistant',
            session_id: sessionID,
            time_created: 2000,
            time_updated: persisted ? 99_000 : 2000 + duration,
            data: JSON.stringify(part),
          },
          {
            id: 'tool',
            message_id: 'assistant',
            session_id: sessionID,
            time_created: 2020,
            time_updated: 32_020,
            data: JSON.stringify({
              type: 'tool',
              tool: 'task',
              state: {
                status: 'completed',
                input: {},
                output: 'child finished',
                time: { start: 2020, end: 32_020 },
              },
            }),
          },
        ];
        const events = reconstructHistoricalEvents(sessionID, user, assistant, rows);
        const deltas = events.filter(({ event }) => event.type === 'message.part.delta');
        assert.equal(deltas.map(({ event }) => event.properties.delta).join(''), text);
        assert.ok(deltas.every(({ event }) => event.properties.delta.length > 0));
        assert.equal(deltas.at(-1).offsetMs, 1000 + duration);
        assert.equal(
          events.find(({ event }) => event.properties?.part?.id === 'stream').offsetMs,
          1000
        );
        let previous = 1000;
        for (const delta of deltas) {
          assert.ok(delta.offsetMs - previous <= 250 + 1e-9);
          previous = delta.offsetMs;
        }
        const timeline = buildReplayTimeline(events);
        const first = timeline.findIndex(({ event }) => event.properties?.part?.id === 'stream');
        const last = timeline.findLastIndex(({ event }) => event.properties?.part?.id === 'stream');
        assert.equal(
          Math.round(
            timeline.slice(first + 1, last + 1).reduce((sum, entry) => sum + entry.delayMs, 0)
          ),
          duration
        );
        const state = new Map();
        let previousOffset = 0;
        for (const { offsetMs, event } of events) {
          assert.ok(offsetMs >= previousOffset);
          previousOffset = offsetMs;
          if (event.type === 'message.part.updated')
            state.set(event.properties.part.id, structuredClone(event.properties.part));
          if (event.type === 'message.part.delta')
            state.get(event.properties.partID).text += event.properties.delta;
        }
        for (const row of rows)
          assert.deepEqual(state.get(row.id), {
            ...JSON.parse(row.data),
            id: row.id,
            messageID: row.message_id,
            sessionID,
          });
        assert.deepEqual(events.at(-2).event.properties.info, assistant.info);
        assert.deepEqual(
          events
            .filter(({ event }) => event.properties?.part?.id === 'tool')
            .map(({ event }) => event.properties.part.state.status),
          ['pending', 'running', 'completed']
        );
      }
    }
  }
});

test('historical estimates respect boundaries and sparse or extreme spans never pad empty deltas', () => {
  const user = { info: { id: 'user' }, parts: [] };
  for (const [text, time, updated, boundary, expectedEnd, maxChunks] of [
    ['x'.repeat(1000), undefined, undefined, 10_000, 260, 5],
    ['x'.repeat(1000), undefined, undefined, 250, 150, 5],
    ['x'.repeat(1000), { start: 200, end: 100 }, 100, 150, 50, 5],
    ['x'.repeat(1000), { start: null, end: null }, null, 150, 50, 5],
    ['x'.repeat(1000), { start: 200, end: 20_000 }, 10_000, 10_000, 9900, 40],
    ['ok', { start: 200, end: 30_200 }, 30_200, 40_000, 30_100, 2],
    [
      'x'.repeat(100_000),
      { start: 200, end: 10_000_200 },
      10_000_200,
      20_000_000,
      10_000_100,
      4096,
    ],
    ['', { start: 200, end: 300 }, 300, 1000, 200, 0],
  ]) {
    const assistant = {
      info: { id: 'assistant', time: { created: 100, completed: boundary } },
      parts: [],
    };
    const rows = [
      {
        id: 'text',
        message_id: 'assistant',
        session_id: 's',
        time_created: 200,
        time_updated: updated,
        data: JSON.stringify({ type: 'text', text, time }),
      },
    ];
    // The next boundary also clips estimates when the message itself finishes later.
    if (boundary === 150) {
      rows[0].time_created = 120;
      rows.push({
        id: 'next',
        message_id: 'assistant',
        session_id: 's',
        time_created: boundary,
        data: JSON.stringify({ type: 'step-start' }),
      });
      assistant.info.time.completed = 1000;
    }
    const events = reconstructHistoricalEvents('s', user, assistant, rows);
    const deltas = events.filter(({ event }) => event.type === 'message.part.delta');
    assert.ok(deltas.length <= maxChunks);
    assert.ok(deltas.every(({ event }) => event.properties.delta.length > 0));
    assert.equal(deltas.map(({ event }) => event.properties.delta).join(''), text);
    assert.equal(
      events.findLast(({ event }) => event.properties?.part?.id === 'text').offsetMs,
      expectedEnd
    );
    if (text === 'ok')
      assert.ok(
        buildReplayTimeline(events).some(
          ({ sourceGapMs, delayMs }) => sourceGapMs > 10_000 && delayMs === 500
        )
      );
  }
});

const spawn = childProcess.spawn;
const hangingProcess = `
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  process.send(process.pid);
`;

async function prepareReplay(t, source) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'varro-playback-test-'));
  const database = path.join(directory, 'capture.db');
  const { id } = savePlaybackCapture(database, {
    label: 'subprocess test',
    scenario: 'TEST',
    capturedAt: '2026-09-07T00:00:00.000Z',
    session: { id: 'session-a' },
    initialMessages: [],
    finalMessages: [],
    events: [20, 120, 5_120].map((offsetMs) => ({
      offsetMs,
      event: { type: 'session.status', properties: { sessionID: 'session-a' } },
    })),
  });
  const listeners = ['SIGINT', 'SIGTERM'].map((signal) => process.listeners(signal));
  const children = [];
  let invocation;
  const started = Promise.withResolvers();
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    invocation = { command, args, options };
    const child = spawn(
      source === null ? path.join(directory, 'missing-node') : process.execPath,
      ['--input-type=commonjs', '-e', source ?? ''],
      {
        ...options,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }
    );
    children.push(child);
    child.once('message', (pids) => started.resolve(pids));
    child.once('error', started.reject);
    return child;
  });
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    t.mock.timers.reset();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await rm(directory, { recursive: true, force: true });
  });
  return {
    run: () => replay(database, id, {}),
    started: started.promise,
    invocation: () => invocation,
    async assertClean(replayFile = invocation.options.env.VARRO_PLAYBACK_FILE) {
      await assert.rejects(access(path.dirname(replayFile)), { code: 'ENOENT' });
      assert.deepEqual(process.listeners('SIGINT'), listeners[0]);
      assert.deepEqual(process.listeners('SIGTERM'), listeners[1]);
    },
  };
}

for (const reason of ['timeout', 'SIGINT', 'SIGTERM']) {
  test(
    `replay kills only its owned hanging process tree on ${reason}`,
    { timeout: 15_000 },
    async (t) => {
      const fixture = await prepareReplay(
        t,
        `
      const { spawn } = require('node:child_process');
      const { once } = require('node:events');
      process.on('SIGINT', () => {});
      process.on('SIGTERM', () => {});
      Promise.all([false, true].map(async (detached) => {
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(hangingProcess)}], {
          detached,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        const [pid] = await once(child, 'message');
        return pid;
      })).then((pids) => process.send([process.pid, ...pids]));
      setInterval(() => {}, 1000);
    `
      );
      const unrelated = spawn(process.execPath, ['-e', hangingProcess], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      t.after(() => unrelated.kill('SIGKILL'));
      await once(unrelated, 'message');
      const result = fixture.run();
      const rejected = assert.rejects(
        result,
        reason === 'timeout'
          ? /Playback timed out after 180620ms/
          : new RegExp(`Playback interrupted by ${reason}`)
      );
      const pids = await fixture.started;
      t.after(() => {
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
      });
      const { command, args, options } = fixture.invocation();
      assert.equal(command, process.execPath);
      assert.equal(args[0], fileURLToPath(import.meta.resolve('@playwright/test/cli')));
      assert.deepEqual(args.slice(1), ['test', '--config', 'playwright.ai-playback.config.ts']);
      assert.equal(options.detached, process.platform !== 'win32');
      const { timeline } = JSON.parse(await readFile(options.env.VARRO_PLAYBACK_FILE, 'utf8'));
      assert.equal(
        timeline.reduce((total, entry) => total + entry.delayMs, 0),
        620
      );
      // Advance only the deadline clock, after every real descendant has reported readiness.
      t.mock.timers.tick(180_619);
      assert.ok(pids.every((pid) => process.kill(pid, 0)));
      if (reason === 'timeout') t.mock.timers.tick(1);
      else {
        process.emit(reason, reason);
        process.emit(reason, reason);
      }
      await rejected;
      for (const pid of pids) {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            assert.equal(error.code, 'ESRCH');
            break;
          }
          await delay(10);
        }
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      }
      assert.equal(process.kill(unrelated.pid, 0), true);
      await fixture.assertClean();
    }
  );
}

for (const code of [0, 7]) {
  test(
    `replay preserves exit code ${code} and removes its fixture and handlers`,
    { timeout: 10_000 },
    async (t) => {
      const fixture = await prepareReplay(t, `process.send(process.pid); process.exit(${code});`);
      const previousExitCode = process.exitCode;
      t.after(() => {
        process.exitCode = previousExitCode;
      });
      await fixture.run();
      assert.equal(process.exitCode, code === 0 ? previousExitCode : code);
      t.mock.timers.tick(200_000);
      await fixture.assertClean();
    }
  );
}

test('replay removes its fixture and handlers on spawn failure', { timeout: 10_000 }, async (t) => {
  const fixture = await prepareReplay(t, null);
  const failedStart = assert.rejects(fixture.started, { code: 'ENOENT' });
  await assert.rejects(fixture.run(), { code: 'ENOENT' });
  await failedStart;
  t.mock.timers.tick(200_000);
  await fixture.assertClean();
});

test('replay removes its temporary directory when writing the fixture fails', async (t) => {
  const fixture = await prepareReplay(t, '');
  let replayFile;
  t.mock.method(fs, 'writeFile', async (file) => {
    replayFile = file;
    throw new Error('fixture write failed');
  });
  syncBuiltinESMExports();
  await assert.rejects(fixture.run(), /fixture write failed/);
  assert.equal(fixture.invocation(), undefined);
  await fixture.assertClean(replayFile);
});
