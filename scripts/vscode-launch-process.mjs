import { execFile } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function writeVscodeLaunchMetadata(filePath, details) {
  const birthIdentity = await readProcessBirthIdentity(details.pid);
  const metadata = {
    version: 1,
    launchedAt: new Date().toISOString(),
    pid: details.pid,
    birthIdentity,
    executable: details.executable,
    profileRoot: details.profileRoot,
    userDataDir: details.userDataDir,
    extensionsDir: details.extensionsDir,
    workspace: details.workspace,
    remoteDebuggingPort: details.remoteDebuggingPort ?? null,
  };
  const temporaryPath = `${filePath}.${String(process.pid)}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await rename(temporaryPath, filePath);
  return metadata;
}

export function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a VS Code debugging port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

export async function waitForVscodeProcess(executable, userDataDir, timeoutMs = 15_000) {
  const expectedArgument = `--user-data-dir=${userDataDir}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { stdout } = await execFileAsync('ps', ['axww', '-o', 'pid=,command=']);
    const candidates = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = /^(\d+)\s+(.+)$/.exec(line);
        return match ? { pid: Number(match[1]), command: match[2] } : null;
      })
      .filter(
        (candidate) =>
          candidate &&
          candidate.command.startsWith(`${executable} `) &&
          candidate.command.split(' ').includes(expectedArgument)
      );

    if (candidates.length === 1) return candidates[0].pid;
    if (candidates.length > 1) {
      throw new Error(`Found multiple VS Code processes for profile ${userDataDir}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Could not find the VS Code process for profile ${userDataDir}`);
}

async function readProcessBirthIdentity(pid) {
  if (process.platform === 'win32') return `win32:${String(pid)}`;
  const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=']);
  const startedAt = stdout.trim();
  if (!startedAt) throw new Error(`Could not read start time for VS Code process ${String(pid)}`);
  return `${process.platform}:${startedAt}`;
}
