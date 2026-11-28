// Native wheel paint regression: wheel jumps up to 800 px must never present a blank
// transcript body, with inline file diffs shown and hidden. Generated replay only; the
// probe reads geometry and never writes scroll state. See docs/native-paint-regressions.md.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { CdpController } from './ai-fuzzy-live.mjs';
import { goToLatest } from './ai-fuzzy-navigation.mjs';
import { controlRequest, runCapture } from './ai-streaming.mjs';
import {
  createCdpRequestClient,
  executeVscodeCommand,
  isVscodeWorkbenchTarget,
  listCdpTargets,
  openCdpSocket,
} from './vscode-launch-process.mjs';
import { nativeWheelFixture } from './ai-native-paint-fixture.mjs';
import { analyzeWheelPaint } from './ai-native-paint-analysis.mjs';

// Upward through the inline diffs into text history, then back down. Every step is <= 800 px.
const DELTAS = [-120, -400, -800, -800, -800, -800, -800, -800, -800, 800, 800, 800, 800, 400, 120];
const STEP_MS = 450;

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args[0] !== '--output' || !args[1] || args.length > 2))
  throw new Error('Usage: ai-native-wheel-paint.mjs [--output directory]');
const output = path.resolve(
  args[1] ?? path.join(root, 'artifacts/ai-streaming', `native-wheel-paint-${Date.now()}`)
);
await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { mode: 0o700 }); // Do not overwrite earlier evidence.
await mkdir(path.join(output, 'frames'));
const save = (name, value) =>
  writeFile(path.join(output, name), JSON.stringify(value, null, 2), { mode: 0o600 });

const { capture, checkpoint } = nativeWheelFixture();
const capturePath = path.join(output, 'capture.json');
await save('capture.json', capture);
const result = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  initialStatus: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }),
  builtVersion: (await readFile(path.join(root, 'dist/webview/webview.version'), 'utf8')).trim(),
  checkpoint,
  deltas: DELTAS,
  settings: {},
  errors: [],
  started: new Date().toISOString(),
};
let finished = false;
const runDirectory = path.join(output, 'editor');
const runner = runCapture(
  {
    capture: capturePath,
    output: runDirectory,
    observer: 'off',
    checkpoints: [checkpoint],
    'setup-timeout-ms': 120_000,
    'start-timeout-ms': 120_000,
    'replay-timeout-ms': 300_000,
  },
  {}
)
  .then(
    (value) => ({ value }),
    (error) => ({ error: error.stack })
  )
  .finally(() => {
    finished = true;
  });

async function until(read, label, timeout = 150_000, interval = 50) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (finished) throw new Error(`Replay ended before ${label}`);
    const value = await read();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// Application-world sampler: one geometry record per animation frame while a step is labelled.
function installWheelProbe() {
  const list = document.querySelector('.interactive-list');
  if (!list) throw new Error('Transcript unavailable');
  const probe = (globalThis['__nativeWheel'] = { label: '', samples: [], stopped: false });
  probe.read = () => {
    const port = list.getBoundingClientRect();
    // Mounted, nonplaceholder content in viewport coordinates distinguishes a range gap
    // from unrasterized but mounted content.
    let first = Infinity;
    let last = -Infinity;
    for (const row of list.querySelectorAll('[data-msg-id]')) {
      const r = row.getBoundingClientRect();
      if (r.height <= 0 || row.classList.contains('interactive-item-virtual-placeholder')) continue;
      first = Math.min(first, r.top - port.top);
      last = Math.max(last, r.bottom - port.top);
    }
    let diffLines = 0;
    for (const line of list.querySelectorAll('.diff-view-line')) {
      const r = line.getBoundingClientRect();
      if (r.height > 0 && r.bottom > port.top && r.top < port.bottom) diffLines++;
    }
    return {
      epoch: performance.timeOrigin + performance.now(),
      label: probe.label,
      top: list.scrollTop,
      height: list.scrollHeight,
      viewport: { x: port.x, y: port.y, width: port.width, height: port.height },
      diffLines,
      uncovered:
        Math.max(0, Math.min(port.height, first)) +
        Math.max(0, Math.min(port.height, port.height - last)),
      previews: list.querySelectorAll('.file-change-inline-diffs').length,
    };
  };
  // A capture listener at the target runs before Varro's scroll handler mounts rows.
  list.addEventListener(
    'scroll',
    () => {
      if (!probe.stopped) probe.samples.push({ ...probe.read(), event: 'scroll' });
    },
    { capture: true, passive: true }
  );
  const tick = () => {
    if (probe.stopped) return;
    probe.samples.push(probe.read());
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let cdp, socket, workbench, control, launch;
const images = [];
let samples = [];
const main = async (expression) => {
  const response = await cdp.call('Runtime.evaluate', {
    contextId: cdp.mainContextId,
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails)
    throw new Error(
      response.exceptionDetails.exception?.description ?? response.exceptionDetails.text
    );
  return response.result.value;
};
try {
  await until(async () => {
    try {
      return (
        JSON.parse(await readFile(path.join(runDirectory, 'run.json'), 'utf8')).phase === 'armed'
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  }, 'armed isolated host');
  launch = JSON.parse(await readFile(path.join(runDirectory, 'launch.json'), 'utf8'));
  control = JSON.parse(await readFile(path.join(runDirectory, 'control.json'), 'utf8'));
  const pages = (await listCdpTargets(launch.remoteDebuggingPort)).filter(isVscodeWorkbenchTarget);
  assert.equal(pages.length, 1);
  socket = await openCdpSocket(pages[0].webSocketDebuggerUrl);
  workbench = createCdpRequestClient(socket, 20_000);
  // A hidden or covered test window renders no frames; keep it in front for the capture.
  await workbench.call('Page.bringToFront');
  cdp = await CdpController.connect(launch.remoteDebuggingPort, {
    surface: 'sidebar',
    viewId: 'sidebar',
  });
  await controlRequest(control, 'start');
  const paused = await until(async () => {
    const status = await controlRequest(control, 'status');
    return status.playbackState === 'paused' ? status : false;
  }, 'replay checkpoint');
  const delivered = await fetch(
    `${paused.replayUrl}/session/${paused.sessionID}/message?limit=1000`
  ).then((r) => r.json());
  const latest = () =>
    goToLatest(cdp, { sessionId: paused.sessionID, messageId: delivered.at(-1).info.id });
  await latest();
  result.host = (
    await workbench.call('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('iframe')].map(f=>{const r=f.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}).filter(r=>r.width>400&&r.height>600)`,
      returnByValue: true,
    })
  ).result.value;
  assert.equal(result.host.length, 1, 'Expected one Varro webview host frame');
  result.host = result.host[0];
  result.runtime = await workbench.call('Browser.getVersion');
  await main(`(${installWheelProbe.toString()})()`);
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method !== 'Page.screencastFrame') return;
    images.push(message.params);
    void workbench
      .call('Page.screencastFrameAck', { sessionId: message.params.sessionId })
      .catch((error) => result.errors.push(`Screencast ack: ${error.message}`));
  });
  await workbench.call('Page.enable');
  for (const setting of ['on', 'off']) {
    const show = setting === 'on';
    await workbench.call('Page.bringToFront');
    await executeVscodeCommand(
      launch.remoteDebuggingPort,
      show ? 'Varro: Show File Diffs' : 'Varro: Hide File Diffs',
      { alreadySelectedCommand: show ? 'Varro: Hide File Diffs' : 'Varro: Show File Diffs' }
    );
    await sleep(700);
    await latest();
    const gate = await until(
      async () => {
        const sample = await main('globalThis.__nativeWheel.read()');
        return (show ? sample.diffLines > 0 : sample.previews === 0) ? sample : null;
      },
      show ? 'painted inline diff lines' : 'hidden inline diffs',
      8000
    ).catch((error) => ({ error: error.message }));
    result.settings[setting] = { gate };
    await workbench.call('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    await sleep(250);
    for (const [index, delta] of DELTAS.entries()) {
      await main(
        `globalThis.__nativeWheel.label=${JSON.stringify(`${setting}:${index}:${delta}`)}`
      );
      assert(
        await cdp.wheel('.interactive-list', delta, 'right'),
        'Native wheel target unavailable'
      );
      await sleep(STEP_MS);
      await main("globalThis.__nativeWheel.label=''");
      await sleep(60);
    }
    await workbench.call('Page.stopScreencast');
  }
  samples = await main(
    '(() => { const p = globalThis.__nativeWheel; p.stopped = true; return p.samples; })()'
  );
  await controlRequest(control, 'resume');
  await runner;
} catch (error) {
  result.errors.push(error.stack);
} finally {
  cdp?.close();
  workbench?.dispose();
  socket?.close();
  if (!finished && control) {
    try {
      await controlRequest(control, 'stop');
    } catch (error) {
      result.errors.push(`Stop: ${error.message}`);
    }
  }
  result.runner = await runner;
  try {
    result.cleanup = JSON.parse(await readFile(path.join(runDirectory, 'run.json'), 'utf8'));
  } catch (error) {
    result.errors.push(`Cleanup metadata: ${error.message}`);
  }
  const index = [];
  for (const [i, frame] of images.entries()) {
    const file = `frames/${String(i).padStart(5, '0')}.png`;
    await writeFile(path.join(output, file), Buffer.from(frame.data, 'base64'), { mode: 0o600 });
    index.push({ file, metadata: frame.metadata });
  }
  await save('frames.json', index);
  await save('dom-samples.json', samples);
  if (samples.length && result.host) {
    try {
      const paint = await analyzeWheelPaint(index, samples, result.host, (file) =>
        readFile(path.join(output, file))
      );
      for (const [setting, verdict] of Object.entries(paint))
        Object.assign((result.settings[setting] ??= {}), verdict);
    } catch (error) {
      result.errors.push(`Oracle: ${error.stack}`);
    }
  }
  result.finished = new Date().toISOString();
  await save('result.json', result);
  const summary = Object.fromEntries(
    Object.entries(result.settings).map(([setting, entry]) => [
      setting,
      {
        verdict: entry.verdict ?? 'BLOCKED',
        checkedFrames: entry.checkedFrames ?? 0,
        blankFrames: entry.failures?.map(({ file, label }) => `${label} ${file}`) ?? [],
      },
    ])
  );
  process.stdout.write(
    JSON.stringify(
      {
        output,
        settings: summary,
        errors: result.errors,
        cleanup: result.runner.value?.hostCleanup,
      },
      null,
      2
    ) + '\n'
  );
  if (
    result.errors.length ||
    result.runner.error ||
    result.runner.value?.cleanupErrors?.length ||
    !result.runner.value?.hostCleanup?.hostExited ||
    ['on', 'off'].some((setting) => result.settings[setting]?.verdict !== 'PASS')
  )
    process.exitCode = 1;
}
