import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireIsolatedTestServer, testServerOrigin } from './ai-test-isolation.mjs';

import {
  executeVscodeCommand,
  reserveLoopbackPort,
  resizeVscodeSidebar,
  waitForVscodeProcess,
  writeVscodeLaunchMetadata,
} from './vscode-launch-process.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function resolveVscodeExecutable() {
  const configured = process.env.VARRO_VSCODE_EXECUTABLE?.trim();
  if (configured) {
    await access(configured);
    return configured;
  }

  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Code']
      : process.platform === 'win32'
        ? [
            path.join(process.env.LOCALAPPDATA || '', 'Programs/Microsoft VS Code/Code.exe'),
            path.join(process.env.ProgramFiles || '', 'Microsoft VS Code/Code.exe'),
          ]
        : ['/usr/share/code/code', '/usr/share/code-insiders/code-insiders'];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }

  throw new Error(
    'Could not locate the VS Code application executable; set VARRO_VSCODE_EXECUTABLE to the GUI executable'
  );
}

const executable = await resolveVscodeExecutable();
const workspace = path.resolve(process.env.VARRO_AI_WORKSPACE?.trim() || projectRoot);
await access(workspace);
const replayUrl = process.env.VARRO_AI_REPLAY_URL;
const testServerUrl = testServerOrigin(replayUrl ?? process.env.VARRO_AI_SERVER_URL);
let isolation;
if (replayUrl) {
  const response = await fetch(new URL('/varro/test-isolation', testServerUrl), {
    redirect: 'error', signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok || (await response.json()).kind !== 'read-only-replay') {
    throw new Error('The replay endpoint is not a read-only replay server');
  }
} else {
  isolation = await requireIsolatedTestServer(testServerUrl, workspace);
}
// Keep this short because macOS limits local IPC socket paths to roughly 103 bytes.
const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'vfz-'));
const userData = path.join(profileRoot, 'u');
const extensions = path.join(profileRoot, 'e');
await mkdir(userData);
await mkdir(extensions);
await mkdir(path.join(userData, 'User'));
await writeFile(path.join(userData, 'User/settings.json'), JSON.stringify({
  'varro.server.port': Number(new URL(testServerUrl).port),
  'varro.server.autoStart': false,
  'varro.server.autoUpdate': false,
}));
const remoteDebuggingPort = await reserveLoopbackPort();
const configuredSidebarWidth = Number(process.env.VARRO_AI_SIDEBAR_WIDTH ?? 486);
if (!Number.isFinite(configuredSidebarWidth) || configuredSidebarWidth < 300) {
  throw new Error('VARRO_AI_SIDEBAR_WIDTH must be a number of at least 300 CSS pixels');
}

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.OPENCODE_PID;
environment.VARRO_TEST_SERVER_URL = testServerUrl;
environment.XDG_DATA_HOME = isolation?.xdgDataHome ?? path.join(profileRoot, 'data');
environment.XDG_STATE_HOME = path.join(profileRoot, 'state');
environment.XDG_CACHE_HOME = path.join(profileRoot, 'cache');
environment.XDG_CONFIG_HOME = path.join(profileRoot, 'config');
environment.OPENCODE_DB = isolation?.sourceDatabase ?? path.join(profileRoot, 'opencode.db');
environment.OPENCODE_PID = '';

const vscodeArgs = [
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--password-store=basic',
  '--use-mock-keychain',
  '--disable-updates',
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  '--new-window',
  '--remote-debugging-address=127.0.0.1',
  `--remote-debugging-port=${String(remoteDebuggingPort)}`,
  `--user-data-dir=${userData}`,
  `--extensions-dir=${extensions}`,
  `--extensionDevelopmentPath=${projectRoot}`,
  workspace,
];
const launchExecutable = process.platform === 'darwin' ? '/usr/bin/open' : executable;
const launchArgs =
  process.platform === 'darwin'
    ? ['-n', '-a', path.resolve(executable, '../../..'),
      ...['VARRO_TEST_SERVER_URL', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_DB', 'OPENCODE_PID'].flatMap(
        (key) => ['--env', `${key}=${environment[key]}`]
      ), '--args', ...vscodeArgs]
    : vscodeArgs;
// Preserve recovery identifiers before macOS hands the launch to LaunchServices.
if (process.env.VARRO_AI_LAUNCH_INTENT) {
  await writeFile(
    process.env.VARRO_AI_LAUNCH_INTENT,
    `${JSON.stringify(
      {
        executable,
        workspace,
        profileRoot,
        userDataDir: userData,
        extensionsDir: extensions,
        remoteDebuggingPort,
      },
      null,
      2
    )}\n`,
    { flag: 'wx', mode: 0o600 }
  );
}
const child = spawn(launchExecutable, launchArgs, {
  cwd: projectRoot,
  detached: true,
  env: environment,
  stdio: 'ignore',
});

await new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, 2_000);
  child.once('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    if (process.platform === 'darwin' && code === 0) {
      resolve();
      return;
    }
    reject(
      new Error(
        `VS Code exited during startup (${signal ? `signal ${signal}` : `code ${String(code)}`})`
      )
    );
  });
});

const codePid =
  process.platform === 'darwin' ? await waitForVscodeProcess(executable, userData) : child.pid;
const focusDeadline = Date.now() + 30_000;
let sidebarWidth;
while (true) {
  try {
    await executeVscodeCommand(remoteDebuggingPort, 'View: Focus on Varro View');
    sidebarWidth = await resizeVscodeSidebar(remoteDebuggingPort, configuredSidebarWidth, 2_000);
    break;
  } catch (error) {
    if (Date.now() >= focusDeadline) throw error;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
const metadataPath = path.join(profileRoot, 'launch.json');
const metadata = await writeVscodeLaunchMetadata(metadataPath, {
  pid: codePid,
  executable,
  profileRoot,
  userDataDir: userData,
  extensionsDir: extensions,
  workspace,
  remoteDebuggingPort,
  sidebarWidth,
});
metadata.testServerUrl = testServerUrl;
metadata.isolation = isolation ?? { kind: 'read-only-replay' };
await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });

child.unref();
process.stdout.write(
  `Launched persistent VS Code Extension Development Host (Code PID ${String(metadata.pid)})\n`
);
process.stdout.write(`Profile: ${profileRoot}\n`);
process.stdout.write(`Workspace: ${workspace}\n`);
process.stdout.write(`Launch metadata: ${metadataPath}\n`);
process.stdout.write(`Remote debugging: http://127.0.0.1:${String(remoteDebuggingPort)}\n`);
process.stdout.write(`Varro sidebar width: ${String(sidebarWidth)}px\n`);
