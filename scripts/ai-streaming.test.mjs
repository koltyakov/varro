import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer as SocketServer } from 'ws';

import {
  bounded,
  cleanupOwnedHost,
  connectFrameTarget,
  controlRequest,
  createBootstrapProxy,
  createControl,
  installObserver,
  isSidebarContext,
  loopbackPortOpen,
  ownedProcessExists,
  parseArgs,
  runCapture,
  stopLauncher,
  waitForSessionRoute,
} from './ai-streaming.mjs';
import { createStreamingServer } from './ai-streaming-server.mjs';
import { reserveLoopbackPort, writeVscodeLaunchMetadata } from './vscode-launch-process.mjs';

test('CLI parses explicit sources and timing, rejecting ambiguous or unsafe arguments', () => {
  assert.deepEqual(
    parseArgs([
      'prepare',
      '--source',
      'db',
      '--directory',
      '/scope',
      '--controller-session',
      'controller',
      '--seed',
      'seed',
      '--count',
      '3',
    ]),
    {
      command: 'prepare',
      options: {
        source: 'db',
        directory: '/scope',
        'controller-session': 'controller',
        seed: 'seed',
        count: 3,
      },
    }
  );
  assert.equal(
    parseArgs(['run', '--capture', 'capture.json', '--output', 'new', '--short-gap-ms', '0'])
      .options['short-gap-ms'],
    0
  );
  for (const args of [
    [],
    ['serve'],
    ['run', '--capture', 'x'],
    ['start', '--control'],
    ['start', '--control', 'x', '--source', 'db'],
    ['status', '--control', 'a', '--control', 'b'],
    ['run', '--capture', 'x', '--output', 'x', '--max-gap-ms', 'NaN'],
    ['run', '--capture', 'x', '--output', 'x', '--start-timeout-ms', '0'],
    ['run', '--capture', 'x', '--output', 'x', '--short-gap-ms', '501'],
    ['run', '--capture', 'x', '--output', 'x', '--max-gap-ms', '2147483648'],
  ]) {
    assert.throws(() => parseArgs(args));
  }
});

test('bounded waits resolve, reject on deadline, and honor cancellation', async () => {
  assert.equal(await bounded(Promise.resolve(42), 100, 'ready'), 42);
  await assert.rejects(bounded(new Promise(() => {}), 5, 'watcher'), /watcher timed out/);
  const controller = new AbortController();
  const pending = bounded(new Promise(() => {}), 1_000, 'replay', controller.signal);
  controller.abort(new Error('stop requested'));
  await assert.rejects(pending, /stop requested/);
  await assert.rejects(
    bounded(Promise.resolve(), 100, 'setup', controller.signal),
    /stop requested/
  );
  await assert.rejects(
    bounded(Promise.reject(new Error('late rejection')), 100, 'setup', controller.signal),
    /stop requested/
  );
});

test('route verification rejects a wrong selected session despite the correct frame and composer', async () => {
  const evidence = {
    context: { surface: 'sidebar', viewId: 'sidebar' },
    route: { type: 'session', sessionId: 'wrong' },
    composerCount: 1,
  };
  const frame = { evaluate: async () => evidence };
  await assert.rejects(
    waitForSessionRoute(frame, 'wanted', AbortSignal.timeout(5)),
    /aborted|timeout/i
  );
  evidence.route.sessionId = 'wanted';
  assert.equal(await waitForSessionRoute(frame, 'wanted', new AbortController().signal), evidence);
});

test('direct frame CDP selects exact context and disposal rejects pending evaluation', async (t) => {
  const server = new SocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let peer;
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString());
      if (request.method === 'Runtime.enable') {
        socket.send(
          JSON.stringify({
            method: 'Runtime.executionContextCreated',
            params: { context: { id: 11, auxData: { isDefault: true } } },
          })
        );
        socket.send(
          JSON.stringify({
            method: 'Runtime.executionContextCreated',
            params: { context: { id: 12, auxData: { isDefault: true } } },
          })
        );
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      } else if (request.params.expression.includes('__initialWebviewState')) {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              result: {
                value:
                  request.params.contextId === 11
                    ? { surface: 'sidebar', viewId: 'sidebar' }
                    : { surface: 'editor', viewId: 'editor-1' },
              },
            },
          })
        );
      } else {
        assert.equal(request.params.contextId, 11);
      }
    });
  });
  const frame = await connectFrameTarget(
    {
      id: 'owned-frame',
      url: 'owned-webview',
      webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}`,
    },
    new AbortController().signal
  );
  const pending = frame.evaluate(() => 42);
  assert.equal(frame.pendingCount(), 1);
  const closed = once(peer, 'close');
  frame.close();
  await assert.rejects(pending, /disposed/);
  await bounded(closed, 1_000, 'Frame socket close');
  assert.equal(frame.pendingCount(), 0);
});

test('cancelled frame handshake destroys its socket rather than leaking an acquisition', async (t) => {
  const server = http.createServer();
  const upgraded = new Promise((resolve) =>
    server.once('upgrade', (_request, socket) => resolve(socket))
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const controller = new AbortController();
  const pending = connectFrameTarget(
    { webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}` },
    controller.signal
  );
  const peer = await upgraded;
  peer.on('end', () => peer.destroy());
  t.after(() => peer.destroy());
  const closed = once(peer, 'close');
  peer.resume();
  controller.abort(new Error('cancel handshake'));
  await assert.rejects(pending, /cancel handshake|closed|disposed/);
  await bounded(closed, 1_000, 'Handshake socket close');
});

test(
  'owned host cleanup verifies forced exit, debug port closure, repeated cleanup, and identity refusal',
  { skip: process.platform === 'win32' },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'streaming-host-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const port = await reserveLoopbackPort();
    const details = {
      executable: process.execPath,
      profileRoot: directory,
      userDataDir: path.join(directory, 'u'),
      extensionsDir: path.join(directory, 'e'),
      workspace: path.join(directory, 'workspace'),
      remoteDebuggingPort: port,
    };
    const child = spawn(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM",()=>{});require("node:http").createServer().listen(Number(process.argv[1]),"127.0.0.1",()=>console.log("ready"))',
        '--',
        String(port),
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${details.userDataDir}`,
        `--extensions-dir=${details.extensionsDir}`,
        details.workspace,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    const exit = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exit;
    });
    await once(child.stdout, 'data');
    const launch = await writeVscodeLaunchMetadata(path.join(directory, 'launch.json'), {
      ...details,
      pid: child.pid,
    });
    assert.equal(await ownedProcessExists(launch), true);
    assert.equal(await loopbackPortOpen(port), true);
    await assert.rejects(
      cleanupOwnedHost({ ...launch, birthIdentity: 'different' }),
      /identity changed/
    );
    assert.equal(await ownedProcessExists(launch), true);
    const result = await cleanupOwnedHost(launch, { graceMs: 10, exitMs: 2_000 });
    assert.deepEqual(result, {
      alreadyExited: false,
      escalated: true,
      hostExited: true,
      debugEndpointStopped: true,
    });
    await exit;
    assert.equal((await cleanupOwnedHost(launch)).alreadyExited, true);
    assert.equal(await loopbackPortOpen(port), false);
    const occupied = http.createServer();
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    t.after(() => new Promise((resolve) => occupied.close(resolve)));
    await assert.rejects(
      cleanupOwnedHost({ ...launch, remoteDebuggingPort: occupied.address().port }, { exitMs: 5 }),
      /debugEndpointStopped=false/
    );
  }
);

test('launcher shutdown waits for SIGKILL exit when SIGTERM is ignored', async (t) => {
  const child = spawn(
    process.execPath,
    ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);console.log("ready")'],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const exit = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
  });
  await once(child.stdout, 'data');
  assert.equal((await stopLauncher(child, exit)).signal, 'SIGKILL');
  assert.equal(child.signalCode, 'SIGKILL');
});

test(
  'pre-launch timing failure persists failed review metadata and refuses output reuse',
  { skip: process.platform === 'win32' },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'streaming-cli-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const capture = path.join(directory, 'capture.json');
    await writeFile(capture, JSON.stringify({ events: [{ offsetMs: 100, event: {} }] }));
    const output = path.join(directory, 'run');
    await assert.rejects(
      runCapture({ capture, output, 'replay-timeout-ms': 1 }),
      /Replay needs at least/
    );
    const metadata = JSON.parse(await readFile(path.join(output, 'run.json'), 'utf8'));
    t.after(() => rm(metadata.retainedWorkspace, { recursive: true, force: true }));
    assert.equal(metadata.phase, 'failed');
    assert.equal(metadata.status, 'NEEDS_AI_REVIEW');
    assert.deepEqual(metadata.cleanupErrors, []);
    assert.equal(metadata.launchMetadataPath, undefined);
    await assert.rejects(readFile(path.join(output, 'launcher.log')), { code: 'ENOENT' });
    await assert.rejects(runCapture({ capture, output }), { code: 'EEXIST' });
  }
);

test('control requires authentication, enforces armed start, and handles status/stop', async (t) => {
  let phase = 'setup';
  let starts = 0;
  const control = await createControl({
    status: () => ({ phase, status: 'NEEDS_AI_REVIEW' }),
    start: () => {
      if (phase !== 'armed') throw new Error('not armed');
      starts++;
      phase = 'running';
    },
    stop: () => {
      phase = 'stopped';
    },
  });
  t.after(() => control.close());
  for (const operation of ['status', 'start', 'stop']) {
    const response = await fetch(`${control.url}/${operation}`, {
      method: operation === 'status' ? 'GET' : 'POST',
    });
    assert.equal(response.status, 401);
  }
  await assert.rejects(controlRequest(control, 'start'), /not armed/);
  phase = 'armed';
  assert.equal((await controlRequest(control, 'start')).phase, 'running');
  await assert.rejects(controlRequest(control, 'start'), /not armed/);
  assert.equal(starts, 1);
  assert.equal((await controlRequest(control, 'status')).status, 'NEEDS_AI_REVIEW');
  assert.equal((await controlRequest(control, 'stop')).stopping, true);
  await sleep(10);
  assert.equal(phase, 'stopped');
  for (const url of [
    'https://127.0.0.1:1234',
    'http://localhost:1234',
    'http://example.com:1234',
    'http://127.0.0.1:1234/foreign',
    'http://127.0.0.1:1234/?x=1',
  ]) {
    await assert.rejects(controlRequest({ ...control, url }, 'start'), /Invalid loopback/);
  }
});

test('bootstrap proxy supplies only synthetic providers, streams replay, and refuses mutations', async (t) => {
  const info = { id: 'message', sessionID: 'source', role: 'assistant', time: { created: 1 } };
  const part = { id: 'part', messageID: info.id, sessionID: 'source', type: 'text', text: '' };
  const replay = await createStreamingServer({
    directory: '/disposable',
    capture: {
      session: {
        id: 'source',
        directory: '/production',
        title: 'Replay',
        time: { created: 1, updated: 1 },
      },
      initialMessages: [{ info, parts: [part] }],
      finalMessages: [{ info, parts: [{ ...part, text: 'hello' }] }],
    },
    timeline: [
      {
        delayMs: 10,
        event: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'source',
            messageID: info.id,
            partID: part.id,
            field: 'text',
            delta: 'hello',
          },
        },
      },
    ],
  });
  const proxy = await createBootstrapProxy(replay);
  t.after(async () => {
    await proxy.close();
    await replay.close();
  });
  assert.deepEqual((await (await fetch(`${proxy.url}/provider`)).json()).connected, ['replay']);
  assert.equal((await (await fetch(`${proxy.url}/config/providers`)).json()).providers.length, 1);
  const sessions = await (await fetch(`${proxy.url}/session`)).json();
  assert.notEqual(sessions[0].id, 'source');
  assert.equal(sessions[0].directory, '/disposable');
  assert.equal((await fetch(`${proxy.url}/session/source`)).status, 404);
  for (const route of ['/config', '/global/dispose', `/session/${sessions[0].id}/prompt_async`]) {
    assert.equal((await fetch(`${proxy.url}${route}`, { method: 'POST' })).status, 405);
  }
  assert.throws(() => replay.start(), /subscriber/);
  const request = http.get(`${proxy.url}/global/event`);
  t.after(() => request.destroy());
  const [response] = await once(request, 'response');
  response.resume();
  const result = await replay.start();
  assert.equal(result.canonicalMatch, true);
  assert.equal(result.scheduler.appliedEvents, 1);
});

test('sidebar selection uses both identity fields, never arbitrary frames', () => {
  assert.equal(isSidebarContext({ surface: 'sidebar', viewId: 'sidebar' }), true);
  for (const context of [
    null,
    {},
    { surface: 'editor', viewId: 'sidebar' },
    { surface: 'sidebar', viewId: 'editor-1' },
  ])
    assert.equal(isSidebarContext(context), false);
});

test('read-only observer arms, bounds samples, records gaps/duplicates/longtasks, and disposes', () => {
  let tick;
  let callback;
  let cancelled = false;
  let disconnected = false;
  let clock = 0;
  class Observer {
    static supportedEntryTypes = ['longtask'];
    constructor(fn) {
      callback = fn;
    }
    observe() {}
    takeRecords() {
      return [];
    }
    disconnect() {
      disconnected = true;
    }
  }
  const context = vm.createContext({
    document: {
      hidden: false,
      querySelectorAll: () => [{ getAttribute: () => 'a' }, { getAttribute: () => 'a' }],
    },
    performance: { now: () => clock },
    PerformanceObserver: Observer,
    requestAnimationFrame: (fn) => {
      tick = fn;
      return 1;
    },
    cancelAnimationFrame: () => {
      cancelled = true;
    },
  });
  const installed = vm.runInContext(`(${installObserver.toString()})()`, context);
  assert.equal(installed.longtasksSupported, true);
  assert.throws(
    () => vm.runInContext(`(${installObserver.toString()})()`, context),
    /already installed/
  );
  tick(0);
  context.varroAiStreamingObserver.start();
  assert.throws(() => context.varroAiStreamingObserver.start(), /already running/);
  tick(10);
  tick(110);
  callback({ getEntries: () => [{ startTime: 12, duration: 80 }] });
  context.document.hidden = true;
  for (let i = 0; i < 2_100; i++) tick(120 + i * 16);
  clock = 40_000;
  const result = context.varroAiStreamingObserver.stop();
  assert.equal(result.frames, 2_102);
  assert.equal(result.maxGapMs, 100);
  assert.equal(result.gapsOver50Ms, 1);
  assert.equal(result.longtasks[0].duration, 80);
  assert.equal(result.duplicateSamples.length, 2_000);
  assert.ok(result.droppedSamples > 0);
  assert.equal(result.hiddenFrames, 2_100);
  assert.equal(result.status, 'NEEDS_AI_REVIEW');
  assert.equal(context.varroAiStreamingObserver, undefined);
  assert.ok(cancelled && disconnected);
});

test('observer reports unavailable longtask instrumentation instead of a pass', () => {
  const context = vm.createContext({
    document: {},
    performance: { now: () => 0 },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  vm.runInContext(`(${installObserver.toString()})()`, context);
  const result = context.varroAiStreamingObserver.stop();
  assert.equal(result.longtasksSupported, false);
  assert.equal(result.status, 'NEEDS_AI_REVIEW');
});
