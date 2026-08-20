import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeVscodeLaunchMetadata } from '../vscode-launch-process.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '../..');
const suitePath = path.join(scriptDirectory, 'suite.cjs');
const fakeCliPath = path.join(scriptDirectory, 'fake-opencode.mjs');
const keepSandboxes = process.env.VARRO_KEEP_VSCODE_SANDBOX === '1';

const SCENARIOS = [
  'clean-install-missing-cli',
  'invalid-cli-path',
  'auto-start-disabled',
  'version-command-failure',
  'malformed-cli-version',
  'startup-process-exit',
  'runtime-crash-recovery',
  'event-stream-failure',
  'port-conflict-fallback',
  'required-update-disabled',
  'required-update-failure',
  'required-update-no-change',
  'file-link-open',
  'healthy-first-run',
];

function selectScenarios(args) {
  const requested = args.filter((arg) => !arg.startsWith('-'));
  if (args.includes('--list')) {
    process.stdout.write(`${SCENARIOS.join('\n')}\n`);
    process.exit(0);
  }
  if (requested.length === 0) return SCENARIOS;
  for (const scenario of requested) {
    if (!SCENARIOS.includes(scenario)) {
      throw new Error(`Unknown VS Code sandbox scenario: ${scenario}`);
    }
  }
  return requested;
}

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
    'Could not locate the VS Code application executable; set VARRO_VSCODE_EXECUTABLE to Code, Code.exe, or the Linux code binary'
  );
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's socket boundary returns either an address object or a pipe name.
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a local sandbox port'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function occupyPort(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function quoteShellArgument(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function createFakeCliLauncher(root) {
  if (process.platform === 'win32') {
    const launcher = path.join(root, 'fake-opencode.cmd');
    await writeFile(launcher, `@"${process.execPath}" "${fakeCliPath}" %*\r\n`);
    return launcher;
  }

  const launcher = path.join(root, 'fake-opencode');
  await writeFile(
    launcher,
    `#!/bin/sh\nexec ${quoteShellArgument(process.execPath)} ${quoteShellArgument(fakeCliPath)} "$@"\n`,
    { mode: 0o755 }
  );
  return launcher;
}

function getScenarioSettings(scenario, port, fakeCommand, missingCommand) {
  const common = {
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'workbench.startupEditor': 'none',
    'varro.server.port': port,
  };

  switch (scenario) {
    case 'clean-install-missing-cli':
      return { ...common, 'varro.debug.simulateMissingCli': true };
    case 'invalid-cli-path':
      return { ...common, 'varro.server.command': missingCommand };
    case 'auto-start-disabled':
      return { ...common, 'varro.server.autoStart': false };
    case 'required-update-disabled':
      return {
        ...common,
        'varro.server.autoUpdate': false,
        'varro.server.command': fakeCommand,
      };
    case 'required-update-failure':
      return {
        ...common,
        'varro.debug.simulateUpgradeFailure': 'network request failed while downloading OpenCode',
        'varro.server.command': fakeCommand,
      };
    default:
      return { ...common, 'varro.server.command': fakeCommand };
  }
}

function getScenarioEnvironment(scenario, root) {
  if (scenario === 'clean-install-missing-cli') {
    const home = path.join(root, 'home');
    if (process.platform === 'win32') {
      const cleanPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
      return {
        APPDATA: path.join(home, 'AppData/Roaming'),
        HOME: home,
        LOCALAPPDATA: path.join(home, 'AppData/Local'),
        PATH: cleanPath,
        Path: cleanPath,
        USERPROFILE: home,
      };
    }
    return { HOME: home, PATH: '/usr/bin:/bin' };
  }
  if (scenario === 'version-command-failure') {
    return { VARRO_SANDBOX_FAKE_MODE: 'version-error', VARRO_SANDBOX_FAKE_VERSION: '1.18.15' };
  }
  if (scenario === 'malformed-cli-version') {
    return { VARRO_SANDBOX_FAKE_MODE: 'malformed-version', VARRO_SANDBOX_FAKE_VERSION: '1.18.15' };
  }
  if (scenario === 'startup-process-exit') {
    return { VARRO_SANDBOX_FAKE_MODE: 'startup-exit', VARRO_SANDBOX_FAKE_VERSION: '1.18.15' };
  }
  if (scenario === 'runtime-crash-recovery') {
    return { VARRO_SANDBOX_FAKE_MODE: 'crash-once', VARRO_SANDBOX_FAKE_VERSION: '1.18.15' };
  }
  if (scenario === 'event-stream-failure') {
    return { VARRO_SANDBOX_FAKE_MODE: 'event-error', VARRO_SANDBOX_FAKE_VERSION: '1.18.15' };
  }
  if (
    scenario === 'required-update-disabled' ||
    scenario === 'required-update-failure' ||
    scenario === 'required-update-no-change'
  ) {
    return {
      VARRO_SANDBOX_FAKE_MODE:
        scenario === 'required-update-no-change' ? 'upgrade-no-change' : 'healthy',
      VARRO_SANDBOX_FAKE_VERSION: '1.15.0',
    };
  }
  return { VARRO_SANDBOX_FAKE_MODE: 'healthy', VARRO_SANDBOX_FAKE_VERSION: '1.18.15' };
}

function runCode(executable, args, env, launchDetails) {
  return new Promise((resolve, reject) => {
    const launchEnvironment = { ...env };
    // Integrated terminals can inherit this from VS Code itself. Leaving it
    // set makes the Electron application binary run as plain Node.
    delete launchEnvironment.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, args, {
      cwd: projectRoot,
      env: launchEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let output = '';
    const appendOutput = (chunk) => {
      output = `${output}${String(chunk)}`.slice(-100_000);
    };
    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);
    child.once('error', reject);
    void writeVscodeLaunchMetadata(launchDetails.metadataPath, {
      pid: child.pid,
      executable,
      profileRoot: launchDetails.profileRoot,
      userDataDir: launchDetails.userDataDir,
      extensionsDir: launchDetails.extensionsDir,
      workspace: launchDetails.workspace,
    }).catch((error) => {
      child.kill();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const outcome = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      reject(new Error(`${executable} failed with ${outcome}\n${output.slice(-20_000)}`));
    });
  });
}

async function stopFakeCli(pidFile) {
  let pid;
  try {
    pid = Number((await readFile(pidFile, 'utf8')).trim());
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid < 1) return;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

async function runScenario(scenario, vscodeExecutable) {
  // Keep this short: macOS limits local IPC socket paths to roughly 103 bytes.
  const root = await mkdtemp(path.join(os.tmpdir(), 'vr-'));
  const workspace = path.join(root, 'w');
  const settingsDirectory = path.join(workspace, '.vscode');
  const userData = path.join(root, 'u');
  const extensions = path.join(root, 'e');
  const launchFile = path.join(root, 'launches.log');
  const pidFile = path.join(root, 'fake.pid');
  let conflictServer;

  try {
    await mkdir(settingsDirectory, { recursive: true });
    await mkdir(userData);
    await mkdir(extensions);
    await mkdir(path.join(root, 'home'));
    let fileLinkRoot = '';
    let fileLinkTarget = '';
    if (scenario === 'file-link-open') {
      fileLinkRoot = path.join(root, 'project');
      fileLinkTarget = path.join(fileLinkRoot, 'src/webview/components/MarkdownRenderer.tsx');
      await mkdir(path.dirname(fileLinkTarget), { recursive: true });
      await writeFile(
        fileLinkTarget,
        `${Array.from({ length: 1_500 }, (_, index) => `// line ${String(index + 1)}`).join('\n')}\n`
      );
    }
    const port = await reservePort();
    const fakeCommand = await createFakeCliLauncher(root);
    const missingCommand = path.join(root, 'missing-opencode');
    const settings = getScenarioSettings(scenario, port, fakeCommand, missingCommand);
    await writeFile(
      path.join(settingsDirectory, 'settings.json'),
      `${JSON.stringify(settings, null, 2)}\n`
    );

    if (scenario === 'port-conflict-fallback') conflictServer = await occupyPort(port);

    process.stdout.write(`\nRunning VS Code sandbox scenario: ${scenario}\n`);
    await runCode(
      vscodeExecutable,
      [
        '--no-sandbox',
        '--disable-gpu-sandbox',
        // Each scenario uses a throwaway user data directory, so the OS keychain
        // has no encryption key for it. Without these flags macOS shows a modal
        // "Keychain Not Found" dialog that blocks the extension host forever.
        '--password-store=basic',
        '--use-mock-keychain',
        '--disable-updates',
        '--disable-extensions',
        '--disable-workspace-trust',
        '--no-cached-data',
        '--skip-welcome',
        '--skip-release-notes',
        `--user-data-dir=${userData}`,
        `--extensions-dir=${extensions}`,
        `--extensionDevelopmentPath=${projectRoot}`,
        `--extensionTestsPath=${suitePath}`,
        workspace,
      ],
      {
        ...process.env,
        ...getScenarioEnvironment(scenario, root),
        VARRO_SANDBOX_LAUNCH_FILE: launchFile,
        VARRO_SANDBOX_PID_FILE: pidFile,
        VARRO_SANDBOX_PORT: String(port),
        VARRO_SANDBOX_SCENARIO: scenario,
        VARRO_SANDBOX_FILE_LINK_ROOT: fileLinkRoot,
        VARRO_SANDBOX_FILE_LINK_TARGET: fileLinkTarget,
      },
      {
        metadataPath: path.join(root, 'launch.json'),
        profileRoot: root,
        userDataDir: userData,
        extensionsDir: extensions,
        workspace,
      }
    );
    process.stdout.write(`VS Code sandbox scenario passed: ${scenario}\n`);
  } finally {
    await stopFakeCli(pidFile);
    if (conflictServer) await new Promise((resolve) => conflictServer.close(resolve));
    if (keepSandboxes) process.stdout.write(`Kept VS Code sandbox: ${root}\n`);
    else await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const scenarios = selectScenarios(process.argv.slice(2));
const vscodeExecutable = await resolveVscodeExecutable();
const failures = [];
for (const scenario of scenarios) {
  try {
    await runScenario(scenario, vscodeExecutable);
  } catch (error) {
    failures.push({ scenario, error });
    process.stderr.write(
      `VS Code sandbox scenario failed: ${scenario}: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

if (failures.length > 0) {
  process.exitCode = 1;
} else {
  process.stdout.write(`\n${String(scenarios.length)} VS Code sandbox scenarios passed.\n`);
}
