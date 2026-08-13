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
    sidebarWidth: details.sidebarWidth ?? null,
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

export async function resizeVscodeSidebar(remoteDebuggingPort, targetWidth, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastWidth = null;

  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${String(remoteDebuggingPort)}/json/list`).then(
        (response) => response.json()
      );
      const workbench = targets.find(
        (target) => target.type === 'page' && target.title.includes('[Extension Development Host]')
      );
      if (!workbench?.webSocketDebuggerUrl) throw new Error('VS Code workbench target is not ready');

      const socket = new WebSocket(workbench.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      let requestId = 0;
      const call = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++requestId;
          const handleMessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.id !== id) return;
            socket.removeEventListener('message', handleMessage);
            if (message.error) reject(new Error(message.error.message));
            else resolve(message.result);
          };
          socket.addEventListener('message', handleMessage);
          socket.send(JSON.stringify({ id, method, params }));
        });
      const geometry = await call('Runtime.evaluate', {
        expression: `(() => {
          const iframe = document.querySelector('iframe.webview');
          if (!iframe) return null;
          const frame = iframe.getBoundingClientRect();
          const sashes = [...document.querySelectorAll('.monaco-sash.vertical:not(.disabled)')]
            .map((element) => element.getBoundingClientRect())
            .filter((rect) => Math.abs(rect.x - frame.x) < 12 || Math.abs(rect.x - frame.right) < 12);
          const sash = sashes.sort((left, right) =>
            Math.min(Math.abs(left.x - frame.x), Math.abs(left.x - frame.right)) -
            Math.min(Math.abs(right.x - frame.x), Math.abs(right.x - frame.right))
          )[0];
          return sash ? {
            frame: [frame.x, frame.y, frame.width, frame.height],
            sashX: sash.x,
            viewportWidth: window.innerWidth,
          } : null;
        })()`,
        returnByValue: true,
      });
      const value = geometry.result.value;
      if (!value) {
        socket.close();
        throw new Error('Varro iframe or secondary-sidebar sash is not ready');
      }

      lastWidth = value.frame[2];
      if (Math.abs(lastWidth - targetWidth) <= 1) {
        socket.close();
        return Math.round(lastWidth);
      }
      const sidebarOnRight = value.frame[0] + lastWidth / 2 > value.viewportWidth / 2;
      const targetX = value.sashX + (sidebarOnRight ? lastWidth - targetWidth : targetWidth - lastWidth);
      const y = value.frame[1] + value.frame[3] / 2;
      for (const [type, x, buttons] of [
        ['mousePressed', value.sashX, 1],
        ['mouseMoved', targetX, 1],
        ['mouseReleased', targetX, 0],
      ]) {
        await call('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: 'left',
          buttons,
          clickCount: 1,
        });
      }
      const measured = await call('Runtime.evaluate', {
        expression: `document.querySelector('iframe.webview')?.getBoundingClientRect().width ?? null`,
        returnByValue: true,
      });
      socket.close();
      lastWidth = measured.result.value;
      if (typeof lastWidth === 'number' && Math.abs(lastWidth - targetWidth) <= 1) {
        return Math.round(lastWidth);
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(
    `Could not resize the Varro sidebar to ${String(targetWidth)}px${lastWidth === null ? '' : ` (last measured ${String(lastWidth)}px)`}`
  );
}

async function readProcessBirthIdentity(pid) {
  if (process.platform === 'win32') return `win32:${String(pid)}`;
  const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=']);
  const startedAt = stdout.trim();
  if (!startedAt) throw new Error(`Could not read start time for VS Code process ${String(pid)}`);
  return `${process.platform}:${startedAt}`;
}
