import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

import { buildReplayTimeline } from './ai-session-playback.mjs';
import { prepareStreamingRun } from './ai-streaming-selection.mjs';
import { createStreamingServer } from './ai-streaming-server.mjs';
import {
  createCdpRequestClient,
  vscodeLaunchCommandMatches,
  writeVscodeLaunchMetadata,
} from './vscode-launch-process.mjs';

const { ws: Socket } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (file, value) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const schemas = {
  prepare: ['source', 'directory', 'controller-session', 'seed', 'count', 'output'],
  run: [
    'capture',
    'output',
    'short-gap-ms',
    'max-gap-ms',
    'setup-timeout-ms',
    'start-timeout-ms',
    'replay-timeout-ms',
  ],
  start: ['control'],
  status: ['control'],
  stop: ['control'],
};

export function parseArgs(args) {
  const [command, ...rest] = args;
  if (!Object.hasOwn(schemas, command))
    throw new Error('Expected prepare, run, start, status, or stop');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2);
    if (
      !rest[i].startsWith('--') ||
      !schemas[command].includes(key) ||
      key in options ||
      !rest[i + 1] ||
      rest[i + 1].startsWith('--')
    ) {
      throw new Error(`Invalid or duplicate option: ${rest[i]}`);
    }
    options[key] = rest[i + 1];
  }
  const required =
    command === 'prepare'
      ? ['source', 'directory', 'controller-session', 'seed']
      : command === 'run'
        ? ['capture', 'output']
        : ['control'];
  for (const key of required) if (!options[key]?.trim()) throw new Error(`--${key} is required`);
  for (const [key, value] of Object.entries(options)) {
    if (key === 'count' || key.endsWith('-ms')) {
      const number = Number(value);
      if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(number) ||
        number > 2_147_483_647 ||
        (number === 0 && !key.includes('gap'))
      )
        throw new Error(`Invalid --${key}`);
      options[key] = number;
    }
  }
  if (command === 'run' && (options['short-gap-ms'] ?? 250) > (options['max-gap-ms'] ?? 500))
    throw new Error('short-gap-ms must not exceed max-gap-ms');
  return { command, options };
}

export async function bounded(promise, ms, label, signal) {
  // The operation may already have started when its caller notices cancellation.
  if (signal?.aborted) {
    void Promise.resolve(promise).catch(() => {});
    throw signal.reason;
  }
  let timer;
  let abort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        abort = () => reject(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function listen(handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        for (const socket of sockets) socket.destroy();
      }),
  };
}

function send(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

export async function createControl({ status, start, stop }) {
  const token = randomBytes(32).toString('hex');
  const server = await listen((request, response) => {
    request.resume();
    if (request.headers.authorization !== `Bearer ${token}`)
      return send(response, 401, { error: 'Authentication required' });
    try {
      if (request.method === 'GET' && request.url === '/status')
        return send(response, 200, status());
      if (request.method === 'POST' && request.url === '/start') {
        start();
        return send(response, 202, status());
      }
      if (request.method === 'POST' && request.url === '/stop') {
        send(response, 202, { stopping: true });
        setImmediate(stop);
        return;
      }
      send(response, 404, { error: 'Unknown control operation' });
    } catch (error) {
      send(response, 409, { error: error.message });
    }
  });
  return { ...server, token };
}

export async function controlRequest(control, command) {
  const url = new URL(control.url);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !/^[a-f0-9]{64}$/.test(control.token) ||
    !['start', 'status', 'stop'].includes(command)
  )
    throw new Error('Invalid loopback control descriptor');
  const response = await fetch(new URL(`/${command}`, url), {
    method: command === 'status' ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${control.token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Control HTTP ${response.status}`);
  return result;
}

// This adapter changes bootstrap only. It cannot reach a production server or forward mutations.
export async function createBootstrapProxy(replay) {
  const provider = {
    id: 'replay',
    name: 'Read-only replay',
    env: [],
    models: {
      replay: {
        id: 'replay',
        name: 'Read-only replay',
        providerID: 'replay',
        attachment: false,
        reasoning: false,
        tool_call: false,
        temperature: false,
        release_date: '2026-01-01',
        limit: { context: 200_000, output: 8_000 },
        cost: { input: 0, output: 0 },
      },
    },
  };
  return listen((request, response) => {
    if (request.method !== 'GET') {
      request.resume();
      return send(response, 405, { error: 'Replay is read-only' });
    }
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/provider')
      return send(response, 200, {
        all: [provider],
        connected: ['replay'],
        default: { replay: 'replay' },
      });
    if (pathname === '/config/providers')
      return send(response, 200, { providers: [provider], default: { replay: 'replay' } });
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: replay.port,
        path: request.url,
        method: 'GET',
        headers: { 'x-opencode-directory': replay.getResult().directory },
      },
      (incoming) => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
      }
    );
    upstream.on('error', (error) => {
      if (!response.headersSent) send(response, 502, { error: error.message });
      else response.destroy();
    });
    response.on('close', () => upstream.destroy());
    upstream.end();
  });
}

export function isSidebarContext(context) {
  return context?.surface === 'sidebar' && context?.viewId === 'sidebar';
}

export function readRouteEvidence() {
  const context = globalThis.__initialWebviewState?.webviewContext ?? null;
  const route =
    globalThis.__vscodeWebviewState?.getState()?.['varro.lastOpenedView'] ??
    JSON.parse(localStorage.getItem('varro.lastOpenedView') ?? 'null');
  return {
    context,
    route,
    messageIDs: [...document.querySelectorAll('[data-msg-id]')].map((row) =>
      row.getAttribute('data-msg-id')
    ),
    composerCount: document.querySelectorAll('.chat-input-container [contenteditable="true"]')
      .length,
  };
}

export async function waitForSessionRoute(frame, sessionID, signal) {
  while (true) {
    signal.throwIfAborted();
    const evidence = await frame.evaluate(readRouteEvidence);
    signal.throwIfAborted();
    if (
      isSidebarContext(evidence.context) &&
      evidence.route?.type === 'session' &&
      evidence.route.sessionId === sessionID &&
      evidence.composerCount === 1
    )
      return evidence;
    await sleep(100, undefined, { signal });
  }
}

// Executed in the selected frame. No application state, DOM, scroll, or styles are changed.
export function installObserver() {
  if (globalThis.varroAiStreamingObserver) throw new Error('Observer already installed');
  const metrics = {
    frames: 0,
    maxGapMs: 0,
    gapsOver50Ms: 0,
    gaps: [],
    longtasks: [],
    duplicateSamples: [],
    maxMountedRows: 0,
    hiddenFrames: 0,
    droppedSamples: 0,
  };
  let previous;
  let raf;
  let active = false;
  const record = (array, value) => {
    if (array.length < 2_000) array.push(value);
    else metrics.droppedSamples++;
  };
  const tick = (now) => {
    if (active) {
      metrics.frames++;
      if (document.hidden) metrics.hiddenFrames++;
      if (previous !== undefined) {
        const gap = now - previous;
        metrics.maxGapMs = Math.max(metrics.maxGapMs, gap);
        if (gap > 50) {
          metrics.gapsOver50Ms++;
          record(metrics.gaps, { at: now, duration: gap });
        }
      }
      previous = now;
      const counts = new Map();
      const rows = document.querySelectorAll('[data-msg-id]');
      metrics.maxMountedRows = Math.max(metrics.maxMountedRows, rows.length);
      for (const row of rows) {
        const id = row.getAttribute('data-msg-id');
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const duplicates = [...counts].filter(([, count]) => count > 1);
      if (duplicates.length) record(metrics.duplicateSamples, { at: now, duplicates });
    }
    raf = requestAnimationFrame(tick);
  };
  const supported =
    globalThis.PerformanceObserver?.supportedEntryTypes.includes('longtask') ?? false;
  const observer = supported
    ? new PerformanceObserver((list) => {
        if (active)
          for (const entry of list.getEntries())
            record(metrics.longtasks, { at: entry.startTime, duration: entry.duration });
      })
    : null;
  observer?.observe({ type: 'longtask' });
  raf = requestAnimationFrame(tick);
  globalThis.varroAiStreamingObserver = {
    start() {
      if (active) throw new Error('Observer already running');
      active = true;
      metrics.startedAt = performance.now();
    },
    stop() {
      active = false;
      cancelAnimationFrame(raf);
      for (const entry of observer?.takeRecords() ?? [])
        record(metrics.longtasks, { at: entry.startTime, duration: entry.duration });
      observer?.disconnect();
      delete globalThis.varroAiStreamingObserver;
      return {
        ...metrics,
        stoppedAt: performance.now(),
        longtasksSupported: supported,
        status: 'NEEDS_AI_REVIEW',
        scope: 'Mounted DOM rows only; virtualization and visual correctness require AI review',
      };
    },
  };
  return { installed: true, longtasksSupported: supported };
}

export async function connectFrameTarget(target, signal) {
  signal.throwIfAborted();
  const socket = new Socket(target.webSocketDebuggerUrl, { handshakeTimeout: 5_000 });
  const requests = createCdpRequestClient(socket, 5_000);
  const close = () => {
    requests.dispose();
    socket.terminate();
  };
  const abort = () => close();
  signal.addEventListener('abort', abort, { once: true });
  try {
    await bounded(
      new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('Frame target closed during connection')));
      }),
      5_000,
      'Frame socket',
      signal
    );
    const contexts = [];
    const listener = (event) => {
      const message = JSON.parse(event.data);
      if (
        message.method === 'Runtime.executionContextCreated' &&
        message.params.context.auxData?.isDefault
      )
        contexts.push(message.params.context);
    };
    socket.addEventListener('message', listener);
    await requests.call('Runtime.enable');
    socket.removeEventListener('message', listener);
    const matches = [];
    for (const context of contexts) {
      const result = await requests.call('Runtime.evaluate', {
        contextId: context.id,
        expression: 'globalThis.__initialWebviewState?.webviewContext',
        returnByValue: true,
      });
      if (isSidebarContext(result.result?.value)) matches.push(context);
    }
    if (matches.length !== 1)
      throw new Error(`Expected one exact sidebar content context, found ${matches.length}`);
    const evaluate = async (fn, argument) => {
      const result = await requests.call('Runtime.evaluate', {
        contextId: matches[0].id,
        expression: `(${fn.toString()})(${JSON.stringify(argument) ?? ''})`,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
        );
      return result.result.value;
    };
    signal.throwIfAborted();
    return {
      evaluate,
      close,
      url: () => target.url,
      targetID: target.id,
      pendingCount: requests.pendingCount,
      clickSession: async (sessionID) => {
        const deadline = Date.now() + 15_000;
        const actions = [];
        while (Date.now() < deadline) {
          const point = await evaluate((id) => {
            const controls = [...document.querySelectorAll('.session-item[data-session-id]')]
              .filter((row) => row.getAttribute('data-session-id') === id)
              .map((row) => row.querySelector('.session-item-main'));
            if (controls.length > 1) throw new Error('Ambiguous replay session buttons');
            for (const [action, control] of [
              ['session', controls[0]],
              ['back', document.querySelector('button[aria-label="Back to sessions"]')],
            ]) {
              if (!control) continue;
              const rect = control.getBoundingClientRect();
              const x = rect.x + rect.width / 2,
                y = rect.y + rect.height / 2;
              if (rect.width && rect.height && control.contains(document.elementFromPoint(x, y)))
                return { x, y, action };
            }
            return null;
          }, sessionID);
          if (!point) {
            await sleep(100);
            continue;
          }
          for (const [type, buttons] of [
            ['mousePressed', 1],
            ['mouseReleased', 0],
          ]) {
            await requests.call('Input.dispatchMouseEvent', {
              type,
              x: point.x,
              y: point.y,
              button: 'left',
              buttons,
              clickCount: 1,
            });
          }
          actions.push(point.action);
          if (point.action === 'session')
            return { actions, selector: '.session-item[data-session-id] .session-item-main' };
          await sleep(100);
        }
        throw new Error('Expected one visible, unobscured replay session button');
      },
    };
  } catch (error) {
    close();
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function findSidebar(port, signal) {
  while (true) {
    signal.throwIfAborted();
    const matches = [];
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal }).then(
        (response) => response.json()
      );
      for (const target of targets.filter(
        (entry) => entry.type === 'iframe' && entry.url.includes('extensionId=koltyakov.varro')
      )) {
        signal.throwIfAborted();
        const frame = await connectFrameTarget(target, signal).catch(() => null);
        if (frame) matches.push(frame);
        signal.throwIfAborted();
      }
      if (matches.length > 1) throw new Error('Multiple exact Varro sidebar frames');
      if (matches.length === 1) return matches[0];
    } catch (error) {
      for (const frame of matches) frame.close();
      throw error;
    }
    await sleep(200, undefined, { signal });
  }
}

export async function ownedProcessExists(launch, verifyCommand = true) {
  if (!Number.isInteger(launch.pid) || launch.pid <= 0 || !launch.birthIdentity)
    throw new Error('Invalid owned process identity');
  const execute = promisify(execFile);
  let birth;
  try {
    birth = await execute('ps', ['-p', String(launch.pid), '-o', 'lstart='], { timeout: 1_000 });
  } catch (error) {
    if (error.code === 1 && !error.stdout?.trim()) return false;
    throw error;
  }
  let command;
  try {
    command = await execute('ps', ['-p', String(launch.pid), '-o', 'stat=,command='], {
      timeout: 1_000,
    });
  } catch (error) {
    if (error.code === 1 && !error.stdout?.trim()) return false;
    throw error;
  }
  if (`${process.platform}:${birth.stdout.trim()}` !== launch.birthIdentity)
    throw new Error('Host identity changed; refusing to signal');
  const match = /^\s*(\S+)\s+(.*)$/.exec(command.stdout.trim());
  // A terminated process can remain a zombie briefly while its parent reaps it.
  if (!command.stdout.trim() || match?.[1].startsWith('Z')) return false;
  if (verifyCommand && (!match || !vscodeLaunchCommandMatches(match[2], launch)))
    throw new Error(`Host argv changed; refusing to signal: ${command.stdout.trim()}`);
  return true;
}

export function loopbackPortOpen(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (value, error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(500, () => finish(null, new Error('Loopback probe timed out')));
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => finish(false, error.code === 'ECONNREFUSED' ? null : error));
  });
}

export async function cleanupOwnedHost(launch, { graceMs = 3_000, exitMs = 5_000 } = {}) {
  const signal = (name) => {
    try {
      process.kill(launch.pid, name);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const alreadyExited = !(await ownedProcessExists(launch));
  let escalated = false;
  if (!alreadyExited) {
    signal('SIGTERM');
    const deadline = Date.now() + graceMs;
    while (await ownedProcessExists(launch, false)) {
      if (Date.now() >= deadline) {
        // Exiting hosts can lose argv before disappearing. Poll birth identity only, but
        // require the full command identity again immediately before any escalation.
        if (await ownedProcessExists(launch)) {
          signal('SIGKILL');
          escalated = true;
        }
        break;
      }
      await sleep(100);
    }
  }
  const deadline = Date.now() + exitMs;
  while (true) {
    const hostExited = !(await ownedProcessExists(launch, false));
    const debugEndpointStopped = !(await loopbackPortOpen(launch.remoteDebuggingPort));
    if (hostExited && debugEndpointStopped)
      return { alreadyExited, escalated, hostExited, debugEndpointStopped };
    if (Date.now() >= deadline)
      throw new Error(
        `Cleanup incomplete: hostExited=${hostExited}, debugEndpointStopped=${debugEndpointStopped}`
      );
    await sleep(100);
  }
}

export async function stopLauncher(child, exit) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    try {
      await bounded(exit, 3_000, 'Launcher SIGTERM');
    } catch {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
  await bounded(exit, 3_000, 'Launcher exit');
  return { exited: true, code: child.exitCode, signal: child.signalCode };
}

// Launcher failures can precede its final stdout. Recover only the uniquely owned workspace host.
async function recoverLaunch(workspace, output) {
  const deadline = Date.now() + 3_000;
  let matches;
  // macOS open hands launch to LaunchServices. Killing the launcher can precede Code's argv
  // becoming visible, so an immediate empty ps snapshot is not sufficient for recovery.
  while (true) {
    const { stdout } = await promisify(execFile)('ps', ['axww', '-o', 'pid=,command='], {
      timeout: 1_000,
    });
    matches = stdout
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(.+)$/.exec(line))
      .filter(
        (match) =>
          match?.[2].endsWith(` ${workspace}`) &&
          match[2].includes(` --extensionDevelopmentPath=${root} `) &&
          match[2].includes(' --no-sandbox ')
      );
    if (matches.length) break;
    if (Date.now() >= deadline) {
      const intentPath = path.join(output, 'launch-intent.json');
      const intent = await readJson(intentPath).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (intent)
        throw new Error(`Host cleanup unverified after launch handoff; inspect ${intentPath}`);
      return null;
    }
    await sleep(100);
  }
  if (matches.length !== 1) throw new Error('Ambiguous owned VS Code process; refusing cleanup');
  const [, pid, command] = matches[0];
  const argument = (name) => new RegExp(`--${name}=([^ ]+)`).exec(command)?.[1];
  const userDataDir = argument('user-data-dir');
  if (!userDataDir) throw new Error('Cannot recover owned profile identity');
  return writeVscodeLaunchMetadata(path.join(output, 'recovered-launch.json'), {
    pid: Number(pid),
    executable: command.split(' --no-sandbox ')[0],
    workspace,
    userDataDir,
    extensionsDir: argument('extensions-dir'),
    profileRoot: path.dirname(userDataDir),
    remoteDebuggingPort: Number(argument('remote-debugging-port')),
  });
}

export async function runCapture(options) {
  if (process.platform === 'win32')
    throw new Error('Owned host cleanup currently requires POSIX ps');
  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Run stopped'));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const metadata = {
    status: 'NEEDS_AI_REVIEW',
    phase: 'setup',
    output,
    capture: path.resolve(options.capture),
    startedAt: new Date().toISOString(),
  };
  let replay, proxy, control, child, browser, frame, launch, workspace;
  let launchOutput = '';
  let launchExit;
  let sidebarSearch;
  let routeSearch;
  let log;
  const cleanupErrors = [];
  try {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'vstream-'));
    metadata.workspace = workspace;
    const captureBytes = await readFile(metadata.capture);
    const capture = JSON.parse(captureBytes.toString('utf8'));
    metadata.captureSha256 = createHash('sha256').update(captureBytes).digest('hex');
    metadata.sourceSessionId = capture.sourceSessionId ?? capture.session?.id;
    metadata.sourceModel = capture.model ?? null;
    metadata.provenance = capture.scenario;
    metadata.timing = {
      shortGapMs: options['short-gap-ms'] ?? 250,
      maxGapMs: options['max-gap-ms'] ?? 500,
    };
    const timeline = buildReplayTimeline(capture.events, metadata.timing);
    const duration = timeline.reduce((total, entry) => total + entry.delayMs, 0);
    const replayTimeout = options['replay-timeout-ms'] ?? 600_000;
    if (duration + 2_000 > replayTimeout)
      throw new Error(`Replay needs at least ${duration + 2_000}ms; increase --replay-timeout-ms`);
    replay = await createStreamingServer({ capture, timeline, directory: workspace });
    proxy = await createBootstrapProxy(replay);
    metadata.sessionID = replay.getResult().sessionID;
    metadata.replayUrl = proxy.url;
    await mkdir(path.join(workspace, '.vscode'));
    const fakeCommand = path.join(workspace, 'fake-opencode');
    await writeFile(
      fakeCommand,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'scripts/vscode-sandbox/fake-opencode.mjs'))} "$@"\n`,
      { mode: 0o700 }
    );
    await json(path.join(workspace, '.vscode/settings.json'), {
      'varro.server.port': proxy.port,
      'varro.server.command': fakeCommand,
      'varro.server.autoUpdate': false,
      'varro.server.autoStart': true,
      'security.workspace.trust.enabled': false,
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'workbench.startupEditor': 'none',
    });
    let begin;
    const started = new Promise((resolve) => {
      begin = resolve;
    });
    control = await createControl({
      status: () => ({ ...metadata, progress: replay.getResult().scheduler }),
      start: () => {
        if (metadata.phase !== 'armed') throw new Error(`Run is ${metadata.phase}, not armed`);
        metadata.phase = 'starting';
        begin();
      },
      stop,
    });
    const controlPath = path.join(output, 'control.json');
    await json(controlPath, { version: 1, url: control.url, token: control.token, output });
    process.stdout.write(`${JSON.stringify({ control: controlPath, ...metadata })}\n`);
    log = createWriteStream(path.join(output, 'launcher.log'), { flags: 'wx', mode: 0o600 });
    log.on('error', (error) => controller.abort(error));
    controller.signal.throwIfAborted();
    child = spawn(process.execPath, [path.join(root, 'scripts/launch-ai-vscode.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        VARRO_AI_WORKSPACE: workspace,
        VARRO_AI_LAUNCH_INTENT: path.join(output, 'launch-intent.json'),
        VARRO_SANDBOX_FAKE_MODE: 'startup-exit',
        VARRO_SANDBOX_FAKE_VERSION: '1.18.29',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data) => {
      launchOutput = (launchOutput + data).slice(-64_000);
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    launchExit = new Promise((resolve) => {
      child.once('error', (error) => resolve({ error }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const setupTimeout = options['setup-timeout-ms'] ?? 90_000;
    const setupSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(setupTimeout)]);
    const launched = await bounded(launchExit, setupTimeout, 'Launcher', setupSignal);
    if (launched.error) throw launched.error;
    if (launched.code !== 0)
      throw new Error(`Launcher exited: ${launched.code ?? launched.signal}`);
    const launchPath = /^Launch metadata: (.+)$/m.exec(launchOutput)?.[1];
    if (!launchPath) throw new Error('Launcher did not report metadata');
    metadata.launchMetadataPath = launchPath;
    launch = await readJson(launchPath);
    if (launch.workspace !== workspace) throw new Error('Launcher workspace mismatch');
    metadata.remoteDebuggingUrl = `http://127.0.0.1:${launch.remoteDebuggingPort}`;
    await json(path.join(output, 'launch.json'), launch);
    if (!(await ownedProcessExists(launch))) throw new Error('Launched host already exited');
    setupSignal.throwIfAborted();
    const targets = await fetch(`${metadata.remoteDebuggingUrl}/json/list`, {
      signal: AbortSignal.any([setupSignal, AbortSignal.timeout(5_000)]),
    }).then((response) => response.json());
    if (
      targets.filter(
        (target) => target.type === 'page' && target.title.includes('[Extension Development Host]')
      ).length !== 1
    )
      throw new Error('Expected exactly one owned Extension Development Host');
    const { chromium } = await import('@playwright/test');
    setupSignal.throwIfAborted();
    // Use Playwright's native connection deadline, not a detached Promise.race. If stop arrives
    // during connection, acquire the result before checking cancellation so finally owns it.
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${launch.remoteDebuggingPort}`, {
      timeout: 5_000,
    });
    setupSignal.throwIfAborted();
    sidebarSearch = findSidebar(launch.remoteDebuggingPort, setupSignal).then((found) => {
      if (setupSignal.aborted) {
        found.close();
        setupSignal.throwIfAborted();
      }
      frame = found;
      return found;
    });
    frame = await bounded(sidebarSearch, setupTimeout, 'Sidebar', setupSignal);
    metadata.nativeNavigation = await bounded(
      frame.clickSession(metadata.sessionID),
      setupTimeout,
      'Open replay session',
      setupSignal
    );
    routeSearch = waitForSessionRoute(frame, metadata.sessionID, setupSignal);
    metadata.routeBefore = await bounded(
      routeSearch,
      15_000,
      'Selected session route',
      setupSignal
    );
    metadata.observer = await bounded(
      frame.evaluate(installObserver),
      5_000,
      'Install observer',
      setupSignal
    );
    metadata.frame = {
      url: frame.url(),
      targetID: frame.targetID,
      surface: 'sidebar',
      viewId: 'sidebar',
    };
    metadata.phase = 'armed';
    await json(path.join(output, 'run.json'), metadata);
    process.stdout.write(`${JSON.stringify({ control: controlPath, ...metadata })}\n`);
    await bounded(
      started,
      options['start-timeout-ms'] ?? 300_000,
      'AI watcher start',
      controller.signal
    );
    const routeSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
    routeSearch = waitForSessionRoute(frame, metadata.sessionID, routeSignal);
    metadata.routeAtStart = await bounded(routeSearch, 5_000, 'Replay route at start', routeSignal);
    await bounded(
      frame.evaluate(() => globalThis.varroAiStreamingObserver.start()),
      5_000,
      'Start observer',
      controller.signal
    );
    metadata.phase = 'running';
    const result = await bounded(replay.start(), replayTimeout, 'Replay', controller.signal);
    await sleep(1_000, undefined, { signal: controller.signal });
    const finalRouteSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
    routeSearch = waitForSessionRoute(frame, metadata.sessionID, finalRouteSignal);
    metadata.routeAfter = await bounded(
      routeSearch,
      5_000,
      'Replay route after delivery',
      finalRouteSignal
    );
    const workbenches = browser
      .contexts()
      .flatMap((context) => context.pages())
      .filter((page) => page.url().includes('/workbench/workbench.html'));
    if (workbenches.length !== 1) throw new Error('Expected one owned workbench screenshot target');
    await workbenches[0].screenshot({ path: path.join(output, 'completed.png'), timeout: 5_000 });
    await json(path.join(output, 'server-result.json'), result);
    if (result.state !== 'completed' || !result.canonicalMatch)
      throw new Error('Replay did not complete with canonical transcript equality');
    metadata.phase = 'completed';
  } catch (error) {
    metadata.phase = controller.signal.aborted ? 'stopped' : 'failed';
    metadata.error = error.message;
  } finally {
    controller.abort(new Error('Run cleanup'));
    const clean = async (label, operation, nativeDeadline = false) => {
      try {
        if (nativeDeadline) await operation();
        else await bounded(operation(), 10_000, label);
      } catch (error) {
        cleanupErrors.push(`${label}: ${error.message}`);
      }
    };
    if (child && launchExit)
      await clean('Launcher exit', async () => {
        metadata.launcherCleanup = await stopLauncher(child, launchExit);
      });
    if (frame)
      await clean('Observer evidence', async () => {
        const metrics = await frame.evaluate(
          () => globalThis.varroAiStreamingObserver?.stop() ?? null
        );
        if (metrics) await json(path.join(output, 'observer.json'), metrics);
      });
    if (frame) {
      frame.close();
      metadata.pendingFrameRequests = frame.pendingCount();
    }
    if (replay)
      await clean('Replay close', async () => {
        await replay.close();
        await json(path.join(output, 'server-result.json'), replay.getResult());
      });
    if (proxy) await clean('Proxy close', proxy.close);
    if (control) await clean('Control close', control.close);
    if (workspace && child)
      await clean(
        'Owned host cleanup',
        async () => {
          launch ??= await recoverLaunch(workspace, output);
          if (!launch) return;
          metadata.hostCleanup = await cleanupOwnedHost(launch);
        },
        true
      );
    if (browser)
      await clean('CDP disconnect', async () => {
        await browser.close();
        metadata.cdpDisconnected = !browser.isConnected();
      });
    // Closing the owned host/transport rejects outstanding evaluate calls. Join the polling
    // loops as well, rather than allowing them to outlive the CLI after a deadline.
    await clean('Pending browser operations', async () => {
      await Promise.allSettled([sidebarSearch, routeSearch]);
      metadata.browserOperationsSettled = true;
    });
    if (log && !log.destroyed)
      await clean('Launcher log', () => new Promise((resolve) => log.end(resolve)));
    metadata.cleanupErrors = cleanupErrors;
    metadata.finishedAt = new Date().toISOString();
    metadata.retainedWorkspace = workspace;
    await json(path.join(output, 'run.json'), metadata);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
  if (metadata.phase !== 'completed' || cleanupErrors.length)
    throw new Error(metadata.error ?? cleanupErrors.join('; '));
  return metadata;
}

export async function main(args = process.argv.slice(2)) {
  const { command, options } = parseArgs(args);
  if (command === 'run') return runCapture(options);
  if (command === 'prepare') {
    const suffix = options.seed.replaceAll(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const manifest = await prepareStreamingRun({
      sourceDatabase: options.source,
      directory: options.directory,
      controllerSessionId: options['controller-session'],
      seed: options.seed,
      count: options.count ?? 3,
      outputDirectory:
        options.output ??
        path.join(
          root,
          'artifacts/ai-streaming',
          `${new Date().toISOString().replaceAll(':', '-')}-${suffix}`
        ),
    });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }
  const result = await controlRequest(await readJson(options.control), command);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
