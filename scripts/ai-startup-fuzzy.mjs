import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CdpController } from './ai-fuzzy-live.mjs';
import { cleanupOwnedHost, loopbackPortOpen } from './ai-streaming.mjs';
import { requireIsolatedTestServer } from './ai-test-isolation.mjs';
import { AdapterProcessCleanup } from './opencode-compatibility/process-cleanup.mjs';
import { isolateVarroTestState } from './varro-test-state.mjs';
import {
  createCdpRequestClient,
  executeVscodeCommand,
  reserveLoopbackPort,
  reloadVscodeWindow,
  writeVscodeLaunchMetadata,
} from './vscode-launch-process.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const seed = process.env.VARRO_STARTUP_SEED || '919af3';
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/.test(seed))
  throw new Error('Use a short alphanumeric startup seed');
const installedEditor =
  process.platform === 'darwin'
    ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code'
    : process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || '', 'Programs/Microsoft VS Code/Code.exe')
      : '/usr/share/code/code';
const tools = process.env.VARRO_STARTUP_TOOLS
  ? JSON.parse(await readFile(process.env.VARRO_STARTUP_TOOLS, 'utf8'))
  : {
      binary:
        process.env.VARRO_OPENCODE_TEST_BINARY ||
        (await execute(process.platform === 'win32' ? 'where.exe' : 'which', ['opencode2'])).stdout
          .trim()
          .split(/\r?\n/)[0],
      executable: process.env.VARRO_VSCODE_EXECUTABLE || installedEditor,
    };
await access(tools.binary);
await access(tools.executable);
const testRoot = path.join(root, 'artifacts/ai-test-data');
await mkdir(testRoot, { recursive: true });
const run = await mkdtemp(path.join(testRoot, `startup-${seed}-`));
const inventory = new AdapterProcessCleanup(run);
const baseline = await inventory.inventory();
const baselineIds = new Set(baseline.map((entry) => `${entry.pid}:${entry.birth}`));
const results = [];
const plan = [
  { name: 'normal-reload', delay: 0, reloads: 2 },
  { name: 'slow-plugin', delay: 30_000 },
  { name: 'slow-plugin-reload-fuzz', delay: 45_000, reloads: 2 },
  { name: 'activation-budget-retry', delay: 120_000, retry: true },
  { name: 'slow-mcp', delay: 0, mcp: true, mcpTimeout: 1_500 },
  { name: 'shutdown-pending-plugin', delay: 120_000, shutdownPending: true },
  { name: 'shutdown-pending-mcp', delay: 0, mcp: true, mcpTimeout: 45_000, shutdownPending: true },
];
if (process.env.VARRO_STARTUP_CASES) {
  const selected = process.env.VARRO_STARTUP_CASES.split(',');
  for (const name of selected)
    if (!plan.some((scenario) => scenario.name === name))
      throw new Error(`Unknown startup case: ${name}`);
  for (let index = plan.length - 1; index >= 0; index--)
    if (!selected.includes(plan[index].name)) plan.splice(index, 1);
}
await writeFile(
  path.join(run, 'plan.json'),
  JSON.stringify({ seed, tools, plan, baseline: baseline.map(safeProcess) }, null, 2)
);
process.stdout.write(`Startup evidence: ${run}\n`);

for (const scenario of plan) {
  const result = { name: scenario.name, state: 'BLOCKED', steps: [], cleanup: null };
  results.push(result);
  const directory = path.join(run, scenario.name);
  const workspace = path.join(directory, 'workspace');
  const release = path.join(directory, 'release');
  const events = path.join(directory, 'addon-events.jsonl');
  const data = path.join(directory, 'data/opencode');
  const environment = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.OPENCODE_CONFIG;
  delete environment.OPENCODE_CONFIG_DIR;
  delete environment.OPENCODE_CONFIG_CONTENT;
  delete environment.OPENCODE_PID;
  const password = randomUUID();
  Object.assign(environment, {
    XDG_DATA_HOME: path.join(directory, 'data'),
    XDG_CONFIG_HOME: path.join(directory, 'config'),
    XDG_CACHE_HOME: path.join(directory, 'cache'),
    OPENCODE_DB: path.join(data, 'opencode.db'),
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
  });
  await isolateVarroTestState(environment, directory);
  await Promise.all(
    [workspace, data, path.join(directory, 'config/opencode'), environment.XDG_CACHE_HOME].map(
      (item) => mkdir(item, { recursive: true })
    )
  );
  const plugin = path.join(workspace, '.opencode/plugins/fixture');
  if (scenario.delay) {
    await mkdir(plugin, { recursive: true });
    await writeFile(
      path.join(plugin, 'index.js'),
      `import { appendFileSync, existsSync } from 'node:fs';
export default { id: 'varro.startup-delay-fixture', async setup() {
 const mark = event => appendFileSync(${JSON.stringify(events)}, JSON.stringify({event,pid:process.pid,ppid:process.ppid,time:Date.now()})+'\\n');
 mark('plugin-start'); const start=Date.now();
 while (!existsSync(${JSON.stringify(release)}) && Date.now()-start<${scenario.delay}) await new Promise(resolve=>setTimeout(resolve,50));
 mark('plugin-ready'); return () => mark('plugin-stop');
} };\n`
    );
  }
  const config = { $schema: 'https://opencode.ai/config.json', plugins: [] };
  if (scenario.mcp) {
    const fixture = path.join(directory, 'dummy-mcp.cjs');
    await writeFile(
      fixture,
      `const fs=require('node:fs');const log=event=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({event,pid:process.pid,ppid:process.ppid,time:Date.now()})+'\\n');
log('mcp-start');process.on('SIGTERM',()=>{log('mcp-sigterm');process.exit(0)});process.stdin.on('end',()=>{log('mcp-eof');process.exit(0)});
let input='';process.stdin.on('data',chunk=>{input+=chunk;let n;while((n=input.indexOf('\\n'))>=0){let line=input.slice(0,n);input=input.slice(n+1);if(!line.trim())continue;let m=JSON.parse(line);if(m.method==='initialize')setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{},serverInfo:{name:'slow-mcp-fixture',version:'1'}}})+'\\n'),60000);else if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[],resources:[],prompts:[]}})+'\\n')}});`
    );
    config.mcp = {
      servers: {
        'slow-proxy-fixture': {
          type: 'local',
          command: [process.execPath, fixture],
          timeout: { startup: scenario.mcpTimeout, catalog: 45_000, execution: 45_000 },
        },
      },
    };
  }
  await writeFile(path.join(directory, 'config/opencode/opencode.json'), JSON.stringify(config));
  const port = await reserveLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
  };
  let server;
  let host;
  let frame;
  let serverIdentity;
  const seen = new Map();
  try {
    const log = await open(path.join(directory, 'server.log'), 'wx', 0o600);
    try {
      server = spawn(tools.binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: workspace,
        env: environment,
        stdio: ['ignore', log.fd, log.fd],
        detached: process.platform !== 'win32',
      });
      await once(server, 'spawn');
    } finally {
      await log.close();
    }
    serverIdentity = (await inventory.inventory()).find((entry) => entry.pid === server.pid);
    assert.ok(serverIdentity, 'Spawned server birth identity must be observable');
    await wait(
      async () => {
        try {
          const info = await fetch(`${url}/api/info`, {
            headers,
            signal: AbortSignal.timeout(1_000),
          }).then((response) => response.json());
          return info.pid === server.pid && info.version === '2.2.7';
        } catch {
          return false;
        }
      },
      30_000,
      'native OpenCode health'
    );
    result.server = safeProcess(serverIdentity);
    result.port = port;
    const previousPassword = process.env.OPENCODE_SERVER_PASSWORD;
    const previousData = process.env.VARRO_AI_DATA_DIR;
    process.env.OPENCODE_SERVER_PASSWORD = password;
    process.env.VARRO_AI_DATA_DIR = data;
    try {
      result.isolation = await requireIsolatedTestServer(url, workspace, testRoot, data);
    } finally {
      if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
      else process.env.OPENCODE_SERVER_PASSWORD = previousPassword;
      if (previousData === undefined) delete process.env.VARRO_AI_DATA_DIR;
      else process.env.VARRO_AI_DATA_DIR = previousData;
    }
    await recordProcesses();
    const intent = path.join(directory, 'launch-intent.json');
    const launched = await execute(
      process.execPath,
      [path.join(root, 'scripts/launch-ai-vscode.mjs')],
      {
        cwd: root,
        env: {
          ...environment,
          VARRO_AI_WORKSPACE: workspace,
          VARRO_AI_SERVER_URL: url,
          VARRO_AI_DATA_DIR: data,
          VARRO_VSCODE_EXECUTABLE: tools.executable,
          VARRO_AI_LAUNCH_INTENT: intent,
          // Keep the launcher's outer profile path short enough for Unix IPC sockets.
          TMPDIR: os.tmpdir(),
          TMP: os.tmpdir(),
          TEMP: os.tmpdir(),
        },
        timeout: 90_000,
        maxBuffer: 1024 * 1024,
      }
    );
    await writeFile(path.join(directory, 'launcher.log'), launched.stdout + launched.stderr);
    const metadata = /^Launch metadata: (.+)$/m.exec(launched.stdout)?.[1]?.trim();
    assert.ok(metadata, 'Launcher must retain the exact host identity');
    host = JSON.parse(await readFile(metadata, 'utf8'));
    result.host = host;
    frame = await CdpController.connect(
      host.remoteDebuggingPort,
      { surface: 'sidebar', viewId: 'sidebar' },
      30_000
    );
    result.steps.push({ event: 'bound-sidebar', context: frame.targetContext, time: Date.now() });
    if (scenario.delay) {
      await wait(async () => (await sample()).waiting, 15_000, 'painted plugin waiting message');
      result.steps.push({ event: 'waiting-observed', time: Date.now() });
    }
    if (scenario.shutdownPending) {
      if (scenario.mcp)
        await wait(
          async () => (await readEvents()).some((event) => event.event === 'mcp-start'),
          15_000,
          'dummy MCP child'
        );
      result.steps.push({ event: 'shutdown-during-pending', time: Date.now() });
    } else {
      if (scenario.reloads && scenario.delay) {
        await reloads(scenario.reloads);
        await hideAndReveal();
      }
      if (scenario.retry) {
        await wait(
          async () =>
            (await sample()).error.includes('503 Location plugins did not finish activating'),
          75_000,
          'retained activation error'
        );
        result.steps.push({ event: 'budget-error-observed', time: Date.now() });
        await writeFile(release, 'release only this test plugin');
        await wait(
          async () => (await readEvents()).some((event) => event.event === 'plugin-ready'),
          10_000,
          'plugin release'
        );
        assert.equal(await frame.clickText('Retry'), true, 'Native Retry must be actionable');
      }
      await wait(async () => (await sample()).ready, 70_000, 'restored composer');
      result.steps.push({ event: 'ready-observed', time: Date.now() });
      if (scenario.reloads && !scenario.delay) await reloads(scenario.reloads);
      if (scenario.mcp) {
        await wait(
          async () => {
            const response = await fetch(
              `${url}/api/mcp?location[directory]=${encodeURIComponent(workspace)}`,
              { headers, signal: AbortSignal.timeout(2_000) }
            ).then((item) => item.json());
            result.mcp = response.data;
            return response.data?.some(
              (entry) => entry.name === 'slow-proxy-fixture' && entry.status.status === 'failed'
            );
          },
          15_000,
          'named MCP timeout'
        );
        assert.equal((await sample()).ready, true, 'A failed MCP must not hide a ready composer');
      }
      assert.equal(
        (await fetch(`${url}/api/info`, { headers }).then((item) => item.json())).pid,
        server.pid,
        'Reload/retry must not replace a healthy server'
      );
    }
    result.state = 'PASS';
  } catch (error) {
    result.error = error.stack || error.message;
    result.state = error.name === 'AssertionError' ? 'FAIL' : 'BLOCKED';
  } finally {
    frame?.close();
    try {
      if (!host) {
        const intent = JSON.parse(
          await readFile(path.join(directory, 'launch-intent.json'), 'utf8')
        );
        const matches = (await inventory.inventory()).filter(
          (entry) =>
            entry.command.startsWith(intent.executable) &&
            entry.command.includes(`--user-data-dir=${intent.userDataDir}`)
        );
        if (matches.length === 1)
          host = await writeVscodeLaunchMetadata(path.join(directory, 'recovered-launch.json'), {
            ...intent,
            pid: matches[0].pid,
          });
        else if (matches.length > 1)
          result.launchRecoveryError = 'Ambiguous failed-launch host identity';
      }
    } catch (error) {
      if (error.code !== 'ENOENT') result.launchRecoveryError = error.message;
    }
    try {
      await recordProcesses();
      if (host) result.hostCleanup = await cleanupOwnedHost(host);
      await recordProcesses();
      if (server && server.exitCode === null && server.signalCode === null) {
        const current = (await inventory.inventory()).find((entry) => entry.pid === server.pid);
        assert.equal(
          current?.birth,
          serverIdentity?.birth,
          'Revalidate owned server birth before stop'
        );
        server.kill('SIGTERM');
        try {
          await wait(
            async () => server.exitCode !== null || server.signalCode !== null,
            5_000,
            'owned server exit'
          );
        } catch {
          // The deliberately uncooperative Promise plugin has no cancellation signal.
          // Bound fixture teardown independently of its artificial activation delay.
          const fresh = (await inventory.inventory()).find((entry) => entry.pid === server.pid);
          assert.equal(
            fresh?.birth,
            serverIdentity.birth,
            'Revalidate fixture identity before escalation'
          );
          assert.equal(
            fresh?.command,
            serverIdentity.command,
            'Revalidate fixture executable before escalation'
          );
          result.serverStopEscalated = true;
          server.kill('SIGKILL');
          await wait(
            async () => server.exitCode !== null || server.signalCode !== null,
            5_000,
            'owned server kill'
          );
        }
      }
      await sleep(500);
      const remaining = (await inventory.inventory()).filter((entry) =>
        seen.has(`${entry.pid}:${entry.birth}`)
      );
      result.cleanup = {
        remaining: remaining.map(safeProcess),
        serverListenerClosed: !(await loopbackPortOpen(port)),
      };
      if (remaining.length || !result.cleanup.serverListenerClosed) {
        result.cleanup.issue = 'Owned processes survived ordinary teardown';
        // Scope fallback cleanup to this run's binary and recorded descendant identities only.
        for (const entry of remaining) {
          const fresh = (await inventory.inventory()).find(
            (item) =>
              item.pid === entry.pid && item.birth === entry.birth && item.command === entry.command
          );
          if (!fresh) continue;
          if (process.platform === 'win32')
            await execute('taskkill.exe', ['/PID', String(entry.pid), '/T', '/F']);
          else process.kill(entry.pid, 'SIGKILL');
        }
        result.state = 'FAIL';
        result.cleanup.afterRecovery = (await inventory.inventory())
          .filter((entry) => seen.has(`${entry.pid}:${entry.birth}`))
          .map(safeProcess);
      }
    } catch (error) {
      result.cleanupError = error.stack || error.message;
      result.state = 'FAIL';
    }
    result.addonEvents = await readEvents();
    result.processes = [...seen.values()].map(safeProcess);
    await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    await writeFile(
      path.join(run, 'results.json'),
      JSON.stringify({ seed, tools, results }, null, 2)
    );
    process.stdout.write(
      `${scenario.name}: ${result.state}${result.error ? ` ${result.error.split('\n')[0]}` : ''}${result.cleanupError ? ` CLEANUP: ${result.cleanupError.split('\n')[0]}` : ''}\n`
    );
  }

  async function recordProcesses() {
    const current = await inventory.inventory();
    const owned = new Set([server?.pid, host?.pid].filter(Boolean));
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of current)
        if (owned.has(item.parent) && !owned.has(item.pid)) {
          owned.add(item.pid);
          changed = true;
        }
    }
    for (const item of current)
      if (
        !baselineIds.has(`${item.pid}:${item.birth}`) &&
        (owned.has(item.pid) ||
          item.command.includes(directory) ||
          item.command.includes(host?.userDataDir ?? '\u0000'))
      )
        seen.set(`${item.pid}:${item.birth}`, item);
  }
  async function readEvents() {
    try {
      return (await readFile(events, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  async function sample() {
    const snapshot = await frame.evaluate(`(() => {
      const loading = document.querySelector('[aria-label="Loading workspace"]');
      const composer = document.querySelector('[aria-label="Message composer"]');
      const painted = node => { if (!node) return false; const r=node.getBoundingClientRect(); return r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && getComputedStyle(node).visibility!=='hidden'; };
      return {time:Date.now(), loading:painted(loading), waiting:painted(loading) && loading.innerText.includes('Waiting for OpenCode plugins'), ready:!loading && !!composer, error:document.querySelector('.session-action-feedback-message')?.getAttribute('aria-label') || '', visible:document.visibilityState, width:innerWidth};
    })()`);
    result.steps.push(snapshot);
    return snapshot;
  }
  async function reloads(count) {
    for (let index = 0; index < count; index++) {
      const jitter =
        200 +
        (parseInt(
          createHash('sha256')
            .update(`${seed}:${scenario.name}:${index}`)
            .digest('hex')
            .slice(0, 4),
          16
        ) %
          800);
      result.steps.push({ event: 'planned-native-reload', jitter, index, time: Date.now() });
      await sleep(jitter);
      frame.close();
      await reloadVscodeWindow(host.remoteDebuggingPort);
      frame = await CdpController.connect(
        host.remoteDebuggingPort,
        { surface: 'sidebar', viewId: 'sidebar' },
        30_000
      );
      if (!scenario.delay)
        await wait(async () => (await sample()).ready, 30_000, 'ready after native reload');
      await recordProcesses();
    }
  }
  async function hideAndReveal() {
    const visibility = `(() => {
      const frames=[...document.querySelectorAll('iframe.webview')].filter(frame => (frame.src.includes('extensionId=koltyakov.varro') || frame.title.includes('Varro')) && frame.getBoundingClientRect().width>0);
      for (const [side, selector] of [['Secondary', '.part.auxiliarybar'], ['Primary', '.part.sidebar']]) {
        const pane=document.querySelector(selector)?.getBoundingClientRect();
        if (pane?.width>0 && frames.some(frame => {const rect=frame.getBoundingClientRect(),x=rect.x+rect.width/2,y=rect.y+rect.height/2;return x>=pane.left && x<=pane.right && y>=pane.top && y<=pane.bottom;})) return side;
      }
      return null;
    })()`;
    const side = await workbenchRead(visibility);
    if (side !== 'Primary' && side !== 'Secondary')
      throw new Error('Could not resolve the visible Varro sidebar for native hide/reveal');
    await executeVscodeCommand(
      host.remoteDebuggingPort,
      `View: Toggle ${side} Side Bar Visibility`
    );
    await wait(
      async () => (await workbenchRead(visibility)) === null,
      5_000,
      'native sidebar hide'
    );
    result.steps.push({ event: 'native-hide-verified', side, time: Date.now() });
    frame.close();
    await executeVscodeCommand(host.remoteDebuggingPort, 'Varro: Focus on Varro View');
    frame = await CdpController.connect(
      host.remoteDebuggingPort,
      { surface: 'sidebar', viewId: 'sidebar' },
      30_000
    );
    await wait(
      async () => Boolean(await workbenchRead(visibility)),
      5_000,
      'native sidebar reveal layout'
    );
    result.steps.push({
      event: 'native-reveal-verified',
      context: frame.targetContext,
      time: Date.now(),
    });
  }
  async function workbenchRead(expression) {
    const targets = await fetch(`http://127.0.0.1:${host.remoteDebuggingPort}/json/list`).then(
      (response) => response.json()
    );
    const workbenches = targets.filter(
      (target) => target.type === 'page' && target.title.includes('[Extension Development Host]')
    );
    assert.equal(workbenches.length, 1, 'Read only the exact isolated workbench');
    const socket = new WebSocket(workbenches[0].webSocketDebuggerUrl);
    await once(socket, 'open');
    const client = createCdpRequestClient(socket);
    try {
      return (await client.call('Runtime.evaluate', { expression, returnByValue: true })).result
        .value;
    } finally {
      client.dispose();
      socket.close();
    }
  }
}
const finalInventory = await inventory.inventory();
const identities = new Set(
  results.flatMap((result) => result.processes ?? []).map((entry) => `${entry.pid}:${entry.birth}`)
);
const profiles = results.flatMap((result) =>
  result.host?.userDataDir ? [result.host.userDataDir] : []
);
const finalResidue = finalInventory.filter(
  (entry) =>
    entry.pid !== process.pid &&
    !baselineIds.has(`${entry.pid}:${entry.birth}`) &&
    (identities.has(`${entry.pid}:${entry.birth}`) ||
      entry.command.includes(run) ||
      profiles.some((profile) => entry.command.includes(profile)))
);
await writeFile(
  path.join(run, 'final-process-scan.json'),
  JSON.stringify(
    { checkedAt: new Date().toISOString(), remaining: finalResidue.map(safeProcess) },
    null,
    2
  )
);
if (finalResidue.length) process.exitCode = 1;
process.stdout.write(
  JSON.stringify(
    { run, seed, cases: results.map(({ name, state, cleanup }) => ({ name, state, cleanup })) },
    null,
    2
  ) + '\n'
);
if (results.some((result) => result.state === 'FAIL')) process.exitCode = 1;

function safeProcess(entry) {
  return { pid: entry.pid, parent: entry.parent, birth: entry.birth, group: entry.group };
}
async function wait(check, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
