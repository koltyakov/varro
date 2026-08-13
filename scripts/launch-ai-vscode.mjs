import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
// Keep this short because macOS limits local IPC socket paths to roughly 103 bytes.
const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'vfz-'));
const userData = path.join(profileRoot, 'u');
const extensions = path.join(profileRoot, 'e');
await mkdir(userData);
await mkdir(extensions);

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(
  executable,
  [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-updates',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--new-window',
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensions}`,
    `--extensionDevelopmentPath=${projectRoot}`,
    projectRoot,
  ],
  {
    cwd: projectRoot,
    detached: true,
    env: environment,
    stdio: 'ignore',
  }
);

await new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, 2_000);
  child.once('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    reject(
      new Error(
        `VS Code exited during startup (${signal ? `signal ${signal}` : `code ${String(code)}`})`
      )
    );
  });
});

child.unref();
process.stdout.write(`Launched persistent VS Code Extension Development Host (PID ${String(child.pid)})\n`);
process.stdout.write(`Profile: ${profileRoot}\n`);
