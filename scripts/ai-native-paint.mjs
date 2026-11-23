import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { CdpController, revealRetainedActivity } from './ai-fuzzy-live.mjs';
import { goToLatest } from './ai-fuzzy-navigation.mjs';
import { controlRequest } from './ai-streaming.mjs';
import {
  createCdpRequestClient,
  executeVscodeCommand,
  isVscodeWorkbenchTarget,
  listCdpTargets,
  openCdpSocket,
} from './vscode-launch-process.mjs';
import { nativePaintFixture } from './ai-native-paint-fixture.mjs';
import { installNativePaintProbe } from './ai-native-paint-probe.mjs';
import { analyzeNativePaint } from './ai-native-paint-analysis.mjs';
import { startPaintTrace, PAINT_TRACE_CATEGORIES } from './ai-native-paint-trace.mjs';
import {
  firstAppliedPage,
  summarizeTrace,
  topTargeting,
  verdict,
} from './ai-native-paint-oracles.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  if (
    !['--capture', '--checkpoint', '--output', '--extension-root'].includes(key) ||
    !args[index + 1]
  ) {
    throw new Error(
      'Usage: ai-native-paint.mjs [--capture file --checkpoint count] [--output directory] [--extension-root built-worktree]'
    );
  }
  options[key.slice(2)] = args[index + 1];
}
// Run the same native driver and pixel oracles against either built worktree.
// Its own launcher retains the existing endpoint/profile isolation checks.
const extensionRoot = options['extension-root'] ? path.resolve(options['extension-root']) : root;
const { runCapture } = await import(
  pathToFileURL(path.join(extensionRoot, 'scripts/ai-streaming.mjs')).href
);
const builtVersion = (
  await readFile(path.join(extensionRoot, 'dist/webview/webview.version'), 'utf8')
).trim();
const extensionSha256 = createHash('sha256')
  .update(await readFile(path.join(extensionRoot, 'dist/extension/extension.js')))
  .digest('hex');
const output = path.resolve(
  options.output ?? path.join(root, 'artifacts/ai-streaming', `native-paint-${Date.now()}`)
);
await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { mode: 0o700 }); // Do not overwrite earlier evidence.
await mkdir(path.join(output, 'frames'));
const save = (name, value) =>
  writeFile(path.join(output, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const capturePath = options.capture
  ? path.resolve(options.capture)
  : path.join(output, 'capture.json');
if (!options.capture) await save('capture.json', nativePaintFixture());
const captureBytes = await readFile(capturePath);
const capture = JSON.parse(captureBytes);
const checkpoint = Number(options.checkpoint ?? 0);
assert.ok(
  Number.isSafeInteger(checkpoint) && checkpoint >= 0 && checkpoint <= capture.events.length
);
const result = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: extensionRoot,
    encoding: 'utf8',
  }).trim(),
  initialStatus: execFileSync('git', ['status', '--short'], {
    cwd: extensionRoot,
    encoding: 'utf8',
  }),
  extensionRoot,
  builtVersion,
  extensionSha256,
  captureSha256: createHash('sha256').update(captureBytes).digest('hex'),
  generated: !options.capture,
  checkpoint,
  traceCategories: PAINT_TRACE_CATEGORIES,
  actions: [],
  pages: [],
  errors: [],
  started: new Date().toISOString(),
};
let finished = false;
let control,
  cdp,
  socket,
  workbench,
  trace,
  recording = false,
  evidence;
let traceName = 'compositor-trace.json';
const images = [];
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
  { onMessagePage: (page) => result.pages.push(page) }
)
  .then(
    (value) => ({ value }),
    (error) => ({ error: error.stack })
  )
  .finally(() => {
    finished = true;
  });
async function until(read, label, timeout = 150_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (finished) throw new Error(`Replay ended before ${label}: ${JSON.stringify(await runner)}`);
    const value = await read();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
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
const snapshot = () => main('globalThis.__nativePaint.snapshot()');
async function readWorkCounters() {
  const { metrics } = await cdp.call('Performance.getMetrics');
  return {
    at: Date.now(),
    metrics: Object.fromEntries(metrics.map(({ name, value }) => [name, value])),
  };
}
async function drag(name) {
  const action = { name, started: Date.now(), before: await snapshot(), dispatches: [] };
  result.actions.push(action);
  await main(`globalThis.__nativePaint.begin(${JSON.stringify(name)})`);
  const geo = await main(`(()=>{
    const l=document.querySelector('.interactive-list'),r=l.getBoundingClientRect();
    const thumb=Math.max(20,r.height*l.clientHeight/l.scrollHeight);
    return {x:r.right-Math.max(3,(l.offsetWidth-l.clientWidth)/2),
      start:r.top+l.scrollTop/(l.scrollHeight-l.clientHeight)*(r.height-thumb)+thumb/2,
      reference:r.top+thumb/2+200/(l.scrollHeight-l.clientHeight)*(r.height-thumb),
      end:Math.max(1,r.top-40)};
  })()`);
  try {
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: geo.x,
      y: geo.start,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await sleep(400);
    action.held = (await snapshot()).held;
    for (let step = 1; step <= 20; step++) {
      const started = Date.now();
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: geo.x,
        y:
          result.generated && step === 18
            ? geo.reference
            : geo.start + ((geo.end - geo.start) * step) / 20,
        button: 'left',
        buttons: 1,
      });
      action.dispatches.push({ step, started, completed: Date.now() });
      if (result.generated && step === 18) {
        // Generated-only reference gate, above the 24 px history trigger. Earlier
        // cold failures remain untouched. Retained recordings keep their real input cadence.
        await sleep(500);
        action.referenceArm = await snapshot();
      }
      await sleep(20);
    }
    await sleep(1000);
    action.heldDestination = await snapshot();
  } finally {
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: geo.x,
      y: geo.end,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }
  await sleep(1000);
  action.after = await snapshot();
  action.finished = Date.now();
}
async function stopTrace() {
  if (!trace) return;
  const current = trace;
  trace = null;
  const captured = await current.stop();
  const { path: tracePath, ...details } = captured;
  const metadata = { file: traceName, ...details };
  result.traces ??= [];
  result.traces.push(metadata);
  result.trace ??= metadata;
  const summary = summarizeTrace(JSON.parse(await readFile(tracePath, 'utf8')).traceEvents);
  await save(
    traceName === 'compositor-trace.json' ? 'trace-summary.json' : 'prepend-trace-summary.json',
    summary
  );
}
try {
  await until(async () => {
    try {
      const run = JSON.parse(await readFile(path.join(runDirectory, 'run.json'), 'utf8'));
      return run.phase === 'armed';
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  }, 'armed isolated host');
  result.launch = JSON.parse(await readFile(path.join(runDirectory, 'launch.json'), 'utf8'));
  control = JSON.parse(await readFile(path.join(runDirectory, 'control.json'), 'utf8'));
  cdp = await CdpController.connect(result.launch.remoteDebuggingPort, {
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
  result.messageCount = delivered.length;
  await goToLatest(cdp, { sessionId: paused.sessionID, messageId: delivered.at(-1).info.id });
  const scope = { messageIds: delivered.slice(-8).map((message) => message.info.id) };
  const retained = await revealRetainedActivity(cdp, paused.sessionID, scope);
  if (retained.found) {
    const disclosure = retained.state.disclosures.find((entry) => entry.visible);
    const selector = `.assistant-activity-summary[data-activity-summary-group-key=${JSON.stringify(disclosure.key)}]`;
    await cdp.click(selector, scope);
    await sleep(250);
    await cdp.click(selector, scope);
    await sleep(250);
  }
  await executeVscodeCommand(result.launch.remoteDebuggingPort, 'Varro: Show File Diffs', {
    alreadySelectedCommand: 'Varro: Hide File Diffs',
  });
  await sleep(700);
  await goToLatest(cdp, { sessionId: paused.sessionID, messageId: delivered.at(-1).info.id });
  const targets = await listCdpTargets(result.launch.remoteDebuggingPort);
  const pages = targets.filter(isVscodeWorkbenchTarget);
  assert.equal(pages.length, 1);
  socket = await openCdpSocket(pages[0].webSocketDebuggerUrl);
  workbench = createCdpRequestClient(socket, 20_000);
  const hosts = (
    await workbench.call('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('iframe')].map(f=>{const r=f.getBoundingClientRect();return {
      x:r.x,y:r.y,width:r.width,height:r.height}}).filter(r=>r.width>400&&r.height>600)`,
      returnByValue: true,
    })
  ).result.value;
  assert.equal(hosts.length, 1);
  result.host = hosts[0];
  result.runtime = await workbench.call('Browser.getVersion');
  await cdp.call('Performance.enable');
  await main(`(${installNativePaintProbe.toString()})()`);
  result.initial = await snapshot();
  assert.ok(
    result.initial.height > result.initial.viewport.height * 8,
    'Long virtualized history required'
  );
  result.diffPreviewGate = result.initial.diffLines > 0;
  const setupImage = await workbench.call('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
  });
  await writeFile(path.join(output, 'setup.png'), Buffer.from(setupImage.data, 'base64'), {
    mode: 0o600,
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Page.screencastFrame') {
      images.push(message.params);
      void workbench
        .call('Page.screencastFrameAck', { sessionId: message.params.sessionId })
        .catch((error) => result.errors.push(`Screencast ack: ${error.message}`));
    }
  });
  trace = await startPaintTrace(result.launch.remoteDebuggingPort, {
    outputPath: path.join(output, traceName),
  });
  await workbench.call('Page.enable');
  await workbench.call('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  recording = true;
  result.firstDragWork = { before: await readWorkCounters() };
  await drag('first-top');
  result.firstDragWork.after = await readWorkCounters();
  await workbench.call('Page.stopScreencast');
  recording = false;
  await main("globalThis.__nativePaint.label = ''");
  // Trace only the first movement/prepend window, not warm navigation or image export.
  await stopTrace();
  const first = result.actions[0];
  if (first.after.top > 1.5) {
    // One labelled re-grab with new thumb geometry. Original paint evidence is immutable.
    let previous = await snapshot();
    await until(
      async () => {
        await sleep(100);
        const current = await snapshot();
        const stable =
          Math.abs(current.top - previous.top) <= 1 &&
          Math.abs(current.height - previous.height) <= 1;
        previous = current;
        return stable;
      },
      'pagination geometry settlement',
      3000
    );
    await workbench.call('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    recording = true;
    if (
      result.generated &&
      first.after.banner &&
      !firstAppliedPage(
        await main('globalThis.__nativePaint.samples'),
        result.pages,
        result.initial
      )
    ) {
      await main("globalThis.__nativePaint.begin('retained-reference-arm')");
      const beforeArm = await snapshot();
      await cdp.wheel('.interactive-list', 200 - beforeArm.top, 'right');
      await sleep(500);
      result.retainedReferenceArm = { before: beforeArm, after: await snapshot() };
      // A separate bounded trace covers prepend if the first grab did not load it.
      traceName = 'compositor-prepend-trace.json';
      trace = await startPaintTrace(result.launch.remoteDebuggingPort, {
        outputPath: path.join(output, traceName),
      });
    }
    await drag('pagination-regrab');
    await workbench.call('Page.stopScreencast');
    recording = false;
    await main("globalThis.__nativePaint.label = ''");
    if (trace) await stopTrace();
  }
  evidence = await main('globalThis.__nativePaint.stop()');
  await controlRequest(control, 'resume');
  await runner;
} catch (error) {
  result.errors.push(error.stack);
} finally {
  if (trace) {
    try {
      await stopTrace();
    } catch (error) {
      result.errors.push(`Trace: ${error.stack}`);
    }
  }
  if (recording) {
    try {
      await workbench.call('Page.stopScreencast');
    } catch (error) {
      result.errors.push(error.stack);
    }
  }
  if (!evidence && cdp) {
    try {
      evidence = await main('globalThis.__nativePaint.stop()');
    } catch (error) {
      result.errors.push(error.stack);
    }
  }
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
  if (evidence) {
    await save('dom-evidence.json', evidence);
    try {
      const pages = result.pages;
      result.prepend = firstAppliedPage(evidence.samples, pages, result.initial);
      result.prependEpoch = result.prepend?.epoch ?? null;
      result.paint = await analyzeNativePaint(
        index,
        evidence.samples,
        result.host,
        (file) => readFile(path.join(output, file)),
        result.prependEpoch ?? Infinity,
        {
          referenceDeadline: result.prepend?.referenceDeadline ?? Infinity,
          firstMoveEpoch: result.actions[0]?.dispatches[0]?.started,
        }
      );
      result.top = result.actions.map((action) => ({
        name: action.name,
        ...topTargeting(action, evidence.samples, pages, capture.initialMessages[0].info.id),
      }));
      if (!result.top[0]?.delivered) {
        for (const check of [result.paint.cold, result.paint.retained]) {
          if (check.verdict === 'PASS') check.verdict = 'BLOCKED';
        }
      }
      const complete = result.top.some((action) => action.completeTop);
      result.completeHistoryTop = verdict([], complete);
    } catch (error) {
      result.errors.push(`Oracle: ${error.stack}`);
    }
  }
  result.finished = new Date().toISOString();
  await save('result.json', result);
  process.stdout.write(
    JSON.stringify(
      {
        output,
        cold: result.paint?.cold.verdict,
        retained: result.paint?.retained.verdict,
        top: result.top,
        completeHistoryTop: result.completeHistoryTop,
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
    result.paint?.cold.verdict !== 'PASS' ||
    result.paint?.retained.verdict !== 'PASS' ||
    result.completeHistoryTop !== 'PASS'
  )
    process.exitCode = 1;
}
