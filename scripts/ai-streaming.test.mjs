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
  DEFAULT_MAX_GAP_MS,
  installObserver,
  inspectCapture,
  isSidebarContext,
  loopbackPortOpen,
  ownedProcessExists,
  parseArgs,
  readRouteEvidence,
  runCapture,
  stopLauncher,
  waitForSessionRoute,
} from './ai-streaming.mjs';
import { createStreamingServer } from './ai-streaming-server.mjs';
import { reserveLoopbackPort, writeVscodeLaunchMetadata } from './vscode-launch-process.mjs';

test('CLI parses explicit sources and timing, rejecting ambiguous or unsafe arguments', () => {
  assert.deepEqual(
    parseArgs(['prepare', '--source', 'db', '--directory', '/scope', '--seed', 'seed']).options,
    { source: 'db', directory: '/scope', seed: 'seed' }
  );
  assert.equal(
    parseArgs([
      'prepare',
      '--source',
      'db',
      '--directory',
      '/scope',
      '--seed',
      'seed',
      '--source-session',
      'chosen',
      '--server-url',
      'http://127.0.0.1:4096',
    ]).options['source-session'],
    'chosen'
  );
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
  assert.deepEqual(
    parseArgs(['run', '--capture', 'x', '--output', 'y', '--checkpoints', '0,12,30']).options
      .checkpoints,
    [0, 12, 30]
  );
  for (const command of ['pause', 'resume', 'snapshot']) {
    assert.equal(parseArgs([command, '--control', 'x']).command, command);
  }
  for (const args of [
    [],
    ['serve'],
    ['run', '--capture', 'x'],
    ['start', '--control'],
    ['start', '--control', 'x', '--source', 'db'],
    ['status', '--control', 'a', '--control', 'b'],
    ['run', '--capture', 'x', '--output', 'x', '--max-gap-ms', 'NaN'],
    ['run', '--capture', 'x', '--output', 'x', '--start-timeout-ms', '0'],
    ['run', '--capture', 'x', '--output', 'x', '--short-gap-ms', '1501'],
    ['run', '--capture', 'x', '--output', 'x', '--max-gap-ms', '2147483648'],
    ['run', '--capture', 'x', '--output', 'x', '--checkpoints', '2,1'],
    ['run', '--capture', 'x', '--output', 'x', '--checkpoints', '1,1'],
    ['run', '--capture', 'x', '--output', 'x', '--checkpoints', '-1'],
    ['run', '--capture', 'x', '--output', 'x', '--checkpoints', '1,'],
  ]) {
    assert.throws(() => parseArgs(args));
  }
});

test('capture inspection identifies exact part and tool boundaries without exposing output', () => {
  const update = (status) => ({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'tool',
        messageID: 'message',
        type: 'tool',
        tool: 'shell',
        state: { status, output: 'private output' },
      },
    },
  });
  const result = inspectCapture({
    scenario: 'AI-07',
    initialMessages: [],
    events: [
      { offsetMs: 0, event: update('running') },
      { offsetMs: 10, event: update('running') },
      { offsetMs: 10_000, event: update('completed') },
    ],
  });
  assert.deepEqual(
    result.boundaries.map(({ afterEvents, scheduledMs, state }) => ({
      afterEvents,
      scheduledMs,
      state,
    })),
    [
      { afterEvents: 1, scheduledMs: 0, state: 'running' },
      { afterEvents: 3, scheduledMs: 1_510, state: 'completed' },
    ]
  );
  assert.equal(JSON.stringify(result).includes('private output'), false);
});

test('inspection exposes native v2 part and tool checkpoints without leaking bodies', () => {
  const event = (kind, properties) => ({
    offsetMs: 0,
    event: {
      type: `session.next.${kind}`,
      properties: { assistantMessageID: 'message', ...properties },
    },
  });
  const result = inspectCapture({
    initialMessages: [],
    events: [
      event('reasoning.started', { reasoningID: 'reasoning' }),
      event('reasoning.delta', { reasoningID: 'reasoning', delta: 'private reasoning' }),
      event('text.started', { textID: 'text' }),
      event('text.delta', { textID: 'text', delta: 'private text' }),
      event('tool.input.started', { id: 'patch', name: 'patch' }),
      event('tool.input.ended', { callID: 'patch', text: 'private input' }),
      event('tool.called', { callID: 'patch', input: 'private input' }),
      event('tool.progress', { callID: 'patch', output: 'private progress' }),
      event('tool.success', { callID: 'patch', output: 'private output' }),
      event('tool.input.started', { callID: 'read', name: 'read' }),
      event('tool.called', { callID: 'read' }),
      event('tool.failed', { callID: 'read', error: 'private error' }),
    ],
  });
  assert.deepEqual(
    result.boundaries.map(({ afterEvents, messageID, partID, partType, tool, state }) => ({
      afterEvents,
      messageID,
      partID,
      partType,
      tool,
      state,
    })),
    [
      {
        afterEvents: 1,
        messageID: 'message',
        partID: 'reasoning',
        partType: 'reasoning',
        tool: undefined,
        state: undefined,
      },
      {
        afterEvents: 3,
        messageID: 'message',
        partID: 'text',
        partType: 'text',
        tool: undefined,
        state: undefined,
      },
      {
        afterEvents: 5,
        messageID: 'message',
        partID: 'patch',
        partType: 'tool',
        tool: 'patch',
        state: 'pending',
      },
      {
        afterEvents: 7,
        messageID: 'message',
        partID: 'patch',
        partType: 'tool',
        tool: 'patch',
        state: 'running',
      },
      {
        afterEvents: 9,
        messageID: 'message',
        partID: 'patch',
        partType: 'tool',
        tool: 'patch',
        state: 'completed',
      },
      {
        afterEvents: 10,
        messageID: 'message',
        partID: 'read',
        partType: 'tool',
        tool: 'read',
        state: 'pending',
      },
      {
        afterEvents: 11,
        messageID: 'message',
        partID: 'read',
        partType: 'tool',
        tool: 'read',
        state: 'running',
      },
      {
        afterEvents: 12,
        messageID: 'message',
        partID: 'read',
        partType: 'tool',
        tool: 'read',
        state: 'error',
      },
    ]
  );
  assert.equal(JSON.stringify(result).includes('private'), false);
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

test('route evidence reads the current folder sidebar route instead of a stale shared route', () => {
  const workspace = '/isolated/workspace';
  const expected = { type: 'session', sessionId: 'wanted', directory: workspace };
  const context = {
    __initialWebviewState: {
      webviewContext: { surface: 'sidebar', viewId: 'sidebar' },
      editorContext: { workspacePath: workspace },
    },
    __vscodeWebviewState: {
      getState: () => ({
        'varro.lastOpenedView': { type: 'session', sessionId: 'stale' },
        [`varro.lastOpenedView:${workspace}`]: expected,
        'varro.lastOpenedView:/other': { type: 'session', sessionId: 'other', directory: '/other' },
      }),
    },
    localStorage: { getItem: () => null },
    document: { querySelectorAll: () => [] },
  };
  const result = vm.runInNewContext(`(${readRouteEvidence.toString()})()`, context);
  assert.equal(result.route, expected);
  context.__initialWebviewState.editorContext.workspacePath = '/missing';
  assert.equal(vm.runInNewContext(`(${readRouteEvidence.toString()})()`, context).route, null);
  context.__initialWebviewState.webviewContext.surface = 'editor';
  assert.equal(
    vm.runInNewContext(`(${readRouteEvidence.toString()})()`, context).route.sessionId,
    'stale'
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

test('route evidence selects the normalized workspace key independently of session directory', () => {
  for (const [workspace, key] of [
    ['/repo/', '/repo'],
    ['C:\\Work\\Repo\\', 'c:/work/repo'],
    ['\\\\Server\\Share\\Repo', '//server/share/repo'],
    ['\\\\?\\UNC\\Server\\Share\\Repo', '//server/share/repo'],
    ['\\\\?\\C:\\Work\\Repo', 'c:/work/repo'],
    ['\\\\?\\Volume{ABC}\\Repo\\', '//?/volume{abc}/repo'],
    ['/repo/child/../', '/repo'],
    ['/repo/back\\slash', '/repo/back\\slash'],
  ]) {
    for (const expected of [
      { type: 'session', sessionId: 'wanted', directory: '/repo/nested' },
      { type: 'new-session' },
      { type: 'sessions-list' },
    ]) {
      const result = vm.runInNewContext(`(${readRouteEvidence.toString()})()`, {
        __initialWebviewState: {
          webviewContext: { surface: 'sidebar', viewId: 'sidebar' },
          editorContext: { workspacePath: workspace },
        },
        __vscodeWebviewState: {
          getState: () => ({
            [`varro.lastOpenedView:${key}`]: expected,
            'varro.lastOpenedView:/other': {
              type: 'session',
              sessionId: 'stale',
              directory: workspace,
            },
          }),
        },
        localStorage: { getItem: () => null },
        document: { querySelectorAll: () => [] },
      });
      assert.equal(result.route, expected);
    }
  }
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
  { timeout: 90_000 },
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
    await assert.rejects(
      cleanupOwnedHost({ ...launch, userDataDir: path.join(directory, 'another-profile') }),
      /argv changed/
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

test('launcher shutdown waits for process exit, escalating when SIGTERM is ignored', async (t) => {
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
  // Windows terminates the child on SIGTERM even when it has a signal handler.
  const signal = process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL';
  assert.equal((await stopLauncher(child, exit)).signal, signal);
  assert.equal(child.signalCode, signal);
});

test(
  'pre-launch timing failure persists failed review metadata and refuses output reuse',
  {},
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
    pause: () => {
      phase = 'paused';
    },
    resume: () => {
      phase = 'running';
    },
    snapshot: async () => {
      await sleep(5);
      return { json: 'snapshot-1.json', screenshot: 'snapshot-1.png' };
    },
  });
  t.after(() => control.close());
  for (const operation of ['status', 'start', 'stop', 'pause', 'resume', 'snapshot']) {
    const response = await fetch(`${control.url}/${operation}`, {
      method: operation === 'status' ? 'GET' : 'POST',
    });
    assert.equal(response.status, 401);
  }
  await assert.rejects(controlRequest(control, 'start'), /not armed/);
  phase = 'armed';
  assert.equal((await controlRequest(control, 'start')).phase, 'running');
  assert.equal((await controlRequest(control, 'pause')).phase, 'paused');
  assert.deepEqual((await controlRequest(control, 'snapshot')).evidence, {
    json: 'snapshot-1.json',
    screenshot: 'snapshot-1.png',
  });
  assert.equal((await controlRequest(control, 'resume')).phase, 'running');
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

test('observer attributes a frame gap and records a hidden interval rAF cannot see', () => {
  let tick;
  let beat;
  let clock = 0;
  let cleared = false;
  const listeners = { document: new Map(), window: new Map() };
  const target = (name) => ({
    addEventListener: (type, fn) => listeners[name].set(type, fn),
    removeEventListener: (type) => listeners[name].delete(type),
  });
  const context = vm.createContext({
    document: {
      ...target('document'),
      hidden: false,
      visibilityState: 'visible',
      hasFocus: () => true,
      querySelectorAll: () => [],
    },
    ...target('window'),
    performance: { now: () => clock },
    requestAnimationFrame: (fn) => {
      tick = fn;
      return 1;
    },
    cancelAnimationFrame() {},
    setInterval: (fn) => {
      beat = fn;
      return 7;
    },
    clearInterval: (id) => {
      cleared = id === 7;
    },
  });
  vm.runInContext(`(${installObserver.toString()})()`, context);
  tick(0);
  // Armed but not started: no diagnostic timer or listeners add overhead yet.
  assert.equal(beat, undefined);
  assert.equal(listeners.document.size + listeners.window.size, 0);
  context.varroAiStreamingObserver.start();
  clock = 8;
  tick(8);

  // Main thread stays live for a one-second rendering pause.
  for (let i = 0; i < 19; i++) {
    clock += 50;
    beat();
    if (i === 9) {
      listeners.window.get('message')({ data: { type: 'server/event', payload: {} } });
      listeners.window.get('message')({ data: { type: 'server/event', payload: {} } });
      listeners.window.get('message')({ data: { type: 'unrelated' } });
      // rAF does not run while hidden, so only the lifecycle event reveals this interval.
      context.document.hidden = true;
      context.document.visibilityState = 'hidden';
      listeners.document.get('visibilitychange')({ type: 'visibilitychange' });
    }
    if (i === 11) {
      context.document.hidden = false;
      context.document.visibilityState = 'visible';
      listeners.document.get('visibilitychange')({ type: 'visibilitychange' });
    }
  }
  clock = 1_008;
  tick(1008);

  // Beat spacing exposes a block independently of the total counts.
  clock = 1_058;
  beat();
  clock = 1_108;
  tick(1108);
  clock = 1_908;
  beat();
  clock = 1_958;
  beat();
  clock = 2_008;
  tick(2008);

  const result = context.varroAiStreamingObserver.stop();
  assert.equal(result.hiddenFrames, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.gaps)), [
    { at: 1008, duration: 1000, heartbeats: 19, messages: 2, maxHeartbeatSpacingMs: 50 },
    { at: 1108, duration: 100, heartbeats: 1, messages: 0, maxHeartbeatSpacingMs: 50 },
    { at: 2008, duration: 900, heartbeats: 2, messages: 0, maxHeartbeatSpacingMs: 800 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.lifecycle)), [
    { at: 0, type: 'observer-start', visibility: 'visible', focused: true },
    { at: 508, type: 'visibilitychange', visibility: 'hidden', focused: true },
    { at: 608, type: 'visibilitychange', visibility: 'visible', focused: true },
  ]);
  assert.equal(cleared, true);
  assert.equal(listeners.document.size, 0);
  assert.equal(listeners.window.size, 0);
});

test('observer records a view that is already hidden when observation starts', () => {
  let tick;
  let visibilityListener;
  const context = vm.createContext({
    document: {
      hidden: true,
      visibilityState: 'hidden',
      hasFocus: () => false,
      querySelectorAll: () => [],
      addEventListener: (_type, fn) => {
        visibilityListener = fn;
      },
      removeEventListener() {},
    },
    performance: { now: () => 5 },
    requestAnimationFrame: (fn) => {
      tick = fn;
      return 1;
    },
    cancelAnimationFrame() {},
  });
  vm.runInContext(`(${installObserver.toString()})()`, context);
  context.varroAiStreamingObserver.start();

  context.document.hidden = false;
  context.document.visibilityState = 'visible';
  visibilityListener({ type: 'visibilitychange' });
  tick(1_000);

  const result = context.varroAiStreamingObserver.stop();
  assert.equal(result.hiddenFrames, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.lifecycle)), [
    { at: 5, type: 'observer-start', visibility: 'hidden', focused: false },
    { at: 5, type: 'visibilitychange', visibility: 'visible', focused: false },
  ]);
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

test('default long-gap cap lets replay show the Thinking row', async () => {
  // A recorded wait longer than the transcript's Thinking reappearance delay must replay long
  // enough for the row to paint, or playback hides a state that live sessions show.
  const source = await readFile(
    new URL('../src/webview/components/MessageList.tsx', import.meta.url),
    'utf8'
  );
  const reappearDelay = Number(source.match(/const LOADING_ROW_REAPPEAR_DELAY_MS = (\d+);/)?.[1]);
  assert.ok(Number.isFinite(reappearDelay));
  assert.ok(DEFAULT_MAX_GAP_MS >= reappearDelay + 500);
});
