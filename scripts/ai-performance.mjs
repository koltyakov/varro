import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { connectFrameTarget, controlRequest } from './ai-streaming.mjs';
import { createCdpRequestClient } from './vscode-launch-process.mjs';

export function summarizeSamples(samples) {
  if (samples.length < 2) throw new Error('At least two samples are required');
  const first = samples[0],
    last = samples.at(-1);
  const seconds = (last.at - first.at) / 1000;
  if (seconds <= 0) throw new Error('Measurement window must be positive');
  const deltas = Object.fromEntries(
    [
      'TaskDuration',
      'ScriptDuration',
      'LayoutDuration',
      'RecalcStyleDuration',
      'LayoutCount',
      'RecalcStyleCount',
      'Nodes',
      'JSEventListeners',
      'JSHeapUsedSize',
    ].map((key) => [
      key,
      Number.isFinite(first.metrics[key]) && Number.isFinite(last.metrics[key])
        ? last.metrics[key] - first.metrics[key]
        : null,
    ])
  );
  const processCpu =
    last.processes?.map((process) => {
      const before = first.processes?.find((entry) => entry.id === process.id);
      return {
        id: process.id,
        type: process.type,
        percentOfOneCore: before ? (100 * (process.cpuTime - before.cpuTime)) / seconds : null,
      };
    }) ?? null;
  const heaps = samples.filter((sample) => Number.isFinite(sample.metrics.JSHeapUsedSize));
  const meanTime =
    heaps.reduce((sum, sample) => sum + (sample.at - first.at) / 1000, 0) / heaps.length;
  const meanHeap =
    heaps.reduce((sum, sample) => sum + sample.metrics.JSHeapUsedSize, 0) / heaps.length;
  let numerator = 0,
    denominator = 0;
  for (const sample of heaps) {
    const x = (sample.at - first.at) / 1000 - meanTime;
    numerator += x * (sample.metrics.JSHeapUsedSize - meanHeap);
    denominator += x * x;
  }
  return {
    seconds,
    deltas,
    processCpu,
    heapBytesPerSecond: denominator ? numerator / denominator : null,
    mainThreadBusyPercent:
      deltas.TaskDuration === null ? null : (100 * deltas.TaskDuration) / seconds,
  };
}

// Diagnostic only. Existing timers predate this probe and are explicitly outside its coverage.
export function installSchedulingProbe() {
  if (globalThis.varroSchedulingProbe) throw new Error('Scheduling probe already installed');
  const sites = new Map();
  const originals = new Map();
  const longtasks = [];
  let captures = 0,
    active = true;
  for (const name of [
    'setTimeout',
    'setInterval',
    'requestAnimationFrame',
    'requestIdleCallback',
  ]) {
    const original = globalThis[name];
    if (!original) continue;
    originals.set(name, original);
    globalThis[name] = function (callback, ...args) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Scheduling APIs also accept string handlers; preserve their native behavior.
      if (typeof callback !== 'function' || !active) return original.call(this, callback, ...args);
      const site = captures++ < 500 ? `${name}\n${new Error().stack}` : `${name}: capture limit`;
      return original.call(
        this,
        function (...values) {
          const start = performance.now();
          try {
            return callback.apply(this, values);
          } finally {
            if (active) {
              const entry = sites.get(site) ?? { calls: 0, milliseconds: 0 };
              entry.calls++;
              entry.milliseconds += performance.now() - start;
              sites.set(site, entry);
            }
          }
        },
        ...args
      );
    };
  }
  const supported = PerformanceObserver.supportedEntryTypes.includes('longtask');
  const observer = supported
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          if (longtasks.length < 2000) longtasks.push(entry.duration);
      })
    : null;
  observer?.observe({ type: 'longtask' });
  globalThis.varroSchedulingProbe = {
    stop() {
      active = false;
      observer?.disconnect();
      for (const [name, original] of originals) globalThis[name] = original;
      delete globalThis.varroSchedulingProbe;
      return {
        scope: 'Callbacks scheduled after probe installation only',
        longtasks: supported ? longtasks : null,
        sites: [...sites].map(([site, value]) => ({ site, ...value })),
      };
    },
  };
}

export async function measurePerformance({
  control: file,
  output,
  duration = 10000,
  scenario = 'visible-idle',
  diagnostic = false,
}) {
  if (!Number.isInteger(duration) || duration < 1000 || duration > 120000)
    throw new Error('duration must be 1000..120000 milliseconds');
  if (!['visible-idle', 'hidden-idle', 'background-stream', 'session-switches'].includes(scenario))
    throw new Error('Unknown performance scenario');
  const control = JSON.parse(await readFile(file, 'utf8'));
  const state = await controlRequest(control, 'status');
  if (!['armed', 'running'].includes(state.phase) || !state.frame?.targetID)
    throw new Error('An armed or running isolated replay host is required');
  if (!diagnostic && state.observer?.installed)
    throw new Error('CPU measurements require a replay launched with --observer off');
  const signal = AbortSignal.timeout(duration + 20000);
  const targets = await fetch(`${state.remoteDebuggingUrl}/json/list`, { signal }).then((r) =>
    r.json()
  );
  const target = targets.find((item) => item.id === state.frame.targetID);
  if (!target) throw new Error('Owned replay frame is unavailable');
  const frame = await connectFrameTarget(target, signal);
  let socket, browser, probe, report;
  try {
    await frame.call('Performance.enable');
    const version = await fetch(`${state.remoteDebuggingUrl}/json/version`, { signal }).then((r) =>
      r.json()
    );
    socket = new WebSocket(version.webSocketDebuggerUrl, { handshakeTimeout: 5000 });
    browser = createCdpRequestClient(socket, 5000);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    if (diagnostic) {
      await frame.evaluate(installSchedulingProbe);
      probe = true;
    }
    const samples = [];
    const startedAt = Date.now();
    do {
      const metrics = await frame.call('Performance.getMetrics');
      let processes = null;
      try {
        processes = (await browser.call('SystemInfo.getProcessInfo')).processInfo;
      } catch {
        /* Electron builds may omit the browser SystemInfo domain. Report unavailable. */
      }
      samples.push({
        at: Date.now(),
        metrics: Object.fromEntries(metrics.metrics.map((m) => [m.name, m.value])),
        processes,
        view: await frame.evaluate(() => ({
          hidden: document.hidden,
          width: innerWidth,
          height: innerHeight,
          route: globalThis.__initialWebviewState?.webviewContext,
        })),
      });
      if (Date.now() - startedAt >= duration) break;
      await sleep(1000, undefined, { signal });
    } while (!signal.aborted);
    report = {
      version: 1,
      status: 'NEEDS_REVIEW',
      scenario,
      diagnostic,
      captureSha256: state.captureSha256,
      sourceModel: state.sourceModel,
      timing: state.timing,
      replayOutput: state.output,
      targetID: target.id,
      startedAt,
      notes: [
        'Scenario actions are performed by the controller; inspect visibility and action evidence.',
        'Process totals include the isolated editor. Extension-host and OpenCode attribution is unavailable in this replay capture.',
        'Calibrate budgets against repeated unchanged-build runs; diagnostic overhead affects CPU.',
      ],
      summary: summarizeSamples(samples),
      samples,
    };
    if (probe) {
      report.attribution = await frame.evaluate(() => globalThis.varroSchedulingProbe.stop());
      probe = false;
    }
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return report;
  } finally {
    if (probe) await frame.evaluate(() => globalThis.varroSchedulingProbe?.stop()).catch(() => {});
    await frame.call('Performance.disable').catch(() => {});
    frame.close();
    browser?.dispose();
    socket?.terminate();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2),
    options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    if (
      !['control', 'output', 'duration', 'scenario', 'diagnostic'].includes(key) ||
      !args[i + 1] ||
      key in options
    )
      throw new Error(`Invalid option: ${args[i]}`);
    options[key] =
      key === 'duration'
        ? Number(args[i + 1])
        : key === 'diagnostic'
          ? args[i + 1] === 'true'
          : args[i + 1];
  }
  if (!options.control || !options.output) throw new Error('--control and --output are required');
  const result = await measurePerformance(options);
  process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
}
