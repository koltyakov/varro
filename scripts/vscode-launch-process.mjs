import { execFile } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_CDP_REQUEST_TIMEOUT_MS = 15_000;

export function createCdpRequestClient(socket, timeoutMs = DEFAULT_CDP_REQUEST_TIMEOUT_MS) {
  let requestId = 0;
  let disposed = false;
  const pending = new Map();

  const removeListeners = () => {
    socket.removeEventListener('message', handleMessage);
    socket.removeEventListener('close', handleClose);
    socket.removeEventListener('error', handleError);
  };
  const rejectPending = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  const terminate = (error) => {
    if (disposed) return;
    disposed = true;
    removeListeners();
    rejectPending(error);
  };
  function handleMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  }
  function handleClose() {
    terminate(new Error('CDP socket closed before the request completed'));
  }
  function handleError() {
    terminate(new Error('CDP socket failed before the request completed'));
  }

  socket.addEventListener('message', handleMessage);
  socket.addEventListener('close', handleClose);
  socket.addEventListener('error', handleError);

  return {
    call(method, params = {}) {
      if (disposed) return Promise.reject(new Error('CDP request client is closed'));
      return new Promise((resolve, reject) => {
        const id = ++requestId;
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          reject(new Error(`CDP request ${method} timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs);
        pending.set(id, { reject, resolve, timer });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    dispose() {
      terminate(new Error('CDP request client was disposed'));
    },
    pendingCount() {
      return pending.size;
    },
  };
}

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

export function vscodeLaunchCommandMatches(command, launch) {
  const requiredArguments = [
    `--remote-debugging-port=${String(launch.remoteDebuggingPort)}`,
    `--user-data-dir=${launch.userDataDir}`,
    `--extensions-dir=${launch.extensionsDir}`,
  ];
  const hasArgument = (argument) =>
    command.includes(`${argument} `) || command.endsWith(argument);
  return (
    path.dirname(launch.userDataDir) === launch.profileRoot &&
    path.dirname(launch.extensionsDir) === launch.profileRoot &&
    command.startsWith(`${launch.executable} `) &&
    requiredArguments.every(hasArgument) &&
    command.endsWith(` ${launch.workspace}`)
  );
}

export async function verifyVscodeLaunchIdentity(launch) {
  if (!Number.isInteger(launch.pid) || launch.pid <= 0 || !launch.birthIdentity) {
    throw new Error('Launch metadata does not contain a valid process identity');
  }
  if (!Number.isInteger(launch.remoteDebuggingPort) || launch.remoteDebuggingPort <= 0) {
    throw new Error('Launch metadata does not contain a valid remote debugging port');
  }
  const [birthIdentity, commandResult] = await Promise.all([
    readProcessBirthIdentity(launch.pid),
    execFileAsync('ps', ['-p', String(launch.pid), '-o', 'command=']),
  ]);
  if (birthIdentity !== launch.birthIdentity) {
    throw new Error(`VS Code process ${String(launch.pid)} no longer matches its launch identity`);
  }
  const command = commandResult.stdout.trim();
  if (!vscodeLaunchCommandMatches(command, launch)) {
    throw new Error(`VS Code process ${String(launch.pid)} no longer matches its launch metadata`);
  }
  const targets = await fetch(
    `http://127.0.0.1:${String(launch.remoteDebuggingPort)}/json/list`
  ).then((response) => {
    if (!response.ok) throw new Error(`CDP endpoint returned HTTP ${String(response.status)}`);
    return response.json();
  });
  const workbenches = targets.filter(
    (target) => target.type === 'page' && target.title.includes('[Extension Development Host]')
  );
  if (workbenches.length !== 1) {
    throw new Error(
      `Launch CDP endpoint has ${String(workbenches.length)} Extension Development Host targets`
    );
  }
}

export function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's socket boundary returns either an address object or a pipe name.
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a VS Code debugging port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function bringTargetToFront(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const requests = createCdpRequestClient(socket);
  try {
    return await requests.call('Page.bringToFront');
  } finally {
    requests.dispose();
    socket.close();
  }
}

export function hasRecreatedVarroTarget(originalTargetId, currentTargetId, sawUnavailable) {
  if (!currentTargetId) return false;
  return originalTargetId ? currentTargetId !== originalTargetId : sawUnavailable;
}

export function getVscodeSidebarGeometry(documentValue, viewportWidth) {
  const sidebarRects = [
    ...documentValue.querySelectorAll('.part.auxiliarybar, .part.sidebar'),
  ].map((element) => element.getBoundingClientRect());
  const candidates = [...documentValue.querySelectorAll('iframe.webview')].filter((iframe) => {
    if (
      !iframe.src.includes('extensionId=koltyakov.varro') &&
      !iframe.title.includes('Varro')
    ) {
      return false;
    }
    const frame = iframe.getBoundingClientRect();
    const centerX = frame.x + frame.width / 2;
    const centerY = frame.y + frame.height / 2;
    return (
      frame.width > 0 &&
      frame.height > 0 &&
      sidebarRects.some(
        (sidebar) =>
          centerX >= sidebar.x &&
          centerX <= sidebar.right &&
          centerY >= sidebar.y &&
          centerY <= sidebar.bottom
      )
    );
  });
  if (candidates.length !== 1) {
    return {
      error: `expected one visible Varro sidebar iframe, found ${String(candidates.length)}`,
    };
  }

  const frame = candidates[0].getBoundingClientRect();
  const sash = [...documentValue.querySelectorAll('.monaco-sash.vertical:not(.disabled)')]
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => Math.abs(rect.x - frame.x) < 12 || Math.abs(rect.x - frame.right) < 12)
    .toSorted(
      (left, right) =>
        Math.min(Math.abs(left.x - frame.x), Math.abs(left.x - frame.right)) -
        Math.min(Math.abs(right.x - frame.x), Math.abs(right.x - frame.right))
    )[0];
  if (!sash) return { error: 'could not find a vertical sash beside the Varro sidebar iframe' };
  return {
    frame: [frame.x, frame.y, frame.width, frame.height],
    sashX: sash.x,
    viewportWidth,
  };
}

export async function executeVscodeCommand(remoteDebuggingPort, commandLabel) {
  const targets = await fetch(`http://127.0.0.1:${String(remoteDebuggingPort)}/json/list`).then(
    (response) => response.json()
  );
  const workbenches = targets.filter(
    (target) => target.type === 'page' && target.title.includes('[Extension Development Host]')
  );
  if (workbenches.length !== 1 || !workbenches[0]?.webSocketDebuggerUrl) {
    throw new Error(
      `Expected one VS Code workbench target, found ${String(workbenches.length)}`
    );
  }
  const socket = new WebSocket(workbenches[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const requests = createCdpRequestClient(socket);
  try {
    for (const type of ['keyDown', 'keyUp']) {
      await requests.call('Input.dispatchKeyEvent', {
        type,
        key: 'P',
        code: 'KeyP',
        modifiers: process.platform === 'darwin' ? 12 : 10,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    await requests.call('Input.insertText', { text: commandLabel });
    for (const type of ['keyDown', 'keyUp']) {
      await requests.call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter' });
    }
  } finally {
    requests.dispose();
    socket.close();
  }
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
  const geometryExpression = `(${getVscodeSidebarGeometry.toString()})(document, window.innerWidth)`;
  let lastError = null;
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
      const requests = createCdpRequestClient(socket, Math.max(1, deadline - Date.now()));
      try {
        const geometry = await requests.call('Runtime.evaluate', {
          expression: geometryExpression,
          returnByValue: true,
        });
        const value = geometry.result.value;
        if (!value || value.error) {
          throw new Error(value?.error || 'Varro iframe or secondary-sidebar sash is not ready');
        }

        lastWidth = value.frame[2];
        if (Math.abs(lastWidth - targetWidth) <= 1) return Math.round(lastWidth);
        const sidebarOnRight = value.frame[0] + lastWidth / 2 > value.viewportWidth / 2;
        const targetX =
          value.sashX + (sidebarOnRight ? lastWidth - targetWidth : targetWidth - lastWidth);
        const y = value.frame[1] + value.frame[3] / 2;
        for (const [type, x, buttons] of [
          ['mousePressed', value.sashX, 1],
          ['mouseMoved', targetX, 1],
          ['mouseReleased', targetX, 0],
        ]) {
          await requests.call('Input.dispatchMouseEvent', {
            type,
            x,
            y,
            button: 'left',
            buttons,
            clickCount: 1,
          });
        }
        const measured = await requests.call('Runtime.evaluate', {
          expression: geometryExpression,
          returnByValue: true,
        });
        const measuredValue = measured.result.value;
        if (!measuredValue || measuredValue.error) {
          throw new Error(
            measuredValue?.error || 'Varro iframe or secondary-sidebar sash is not ready'
          );
        }
        lastWidth = measuredValue.frame[2];
        if (Math.abs(lastWidth - targetWidth) <= 1) {
          return Math.round(lastWidth);
        }
      } finally {
        requests.dispose();
        socket.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = JSON.stringify(message.slice(0, 500));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(
    `Could not resize the Varro sidebar to ${String(targetWidth)}px${lastWidth === null ? '' : ` (last measured ${String(lastWidth)}px)`}${lastError === null ? '' : `; last error: ${lastError}`}`
  );
}

export async function reloadVscodeWindow(
  remoteDebuggingPort,
  timeoutMs = 20_000,
  expectedVarroTargetId = null
) {
  const targets = await fetch(`http://127.0.0.1:${String(remoteDebuggingPort)}/json/list`).then(
    (response) => response.json()
  );
  const workbench = targets.find(
    (target) => target.type === 'page' && target.title.includes('[Extension Development Host]')
  );
  if (!workbench?.webSocketDebuggerUrl) throw new Error('VS Code workbench target is not ready');
  const originalVarroTargetIds = new Set(
    targets
      .filter(
        (target) => target.type === 'iframe' && target.url.includes('extensionId=koltyakov.varro')
      )
      .map((target) => target.id)
  );
  if (expectedVarroTargetId && !originalVarroTargetIds.has(expectedVarroTargetId)) {
    throw new Error(`Requested Varro target ${expectedVarroTargetId} is not attached to the workbench`);
  }

  await executeVscodeCommand(remoteDebuggingPort, 'Developer: Reload Window');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const currentTargets = await fetch(
        `http://127.0.0.1:${String(remoteDebuggingPort)}/json/list`
      ).then((response) => response.json());
      const currentWorkbench = currentTargets.find(
        (target) => target.type === 'page' && target.title.includes('[Extension Development Host]')
      );
      const varroTargets = currentTargets.filter(
        (target) => target.type === 'iframe' && target.url.includes('extensionId=koltyakov.varro')
      );
      const hasRecreatedVarro = varroTargets.some(
        (target) => !originalVarroTargetIds.has(target.id)
      );
      if (currentWorkbench?.webSocketDebuggerUrl && hasRecreatedVarro) {
        await bringTargetToFront(currentWorkbench.webSocketDebuggerUrl);
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('VS Code did not finish reloading the Varro webview');
}

async function readProcessBirthIdentity(pid) {
  if (process.platform === 'win32') return `win32:${String(pid)}`;
  const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=']);
  const startedAt = stdout.trim();
  if (!startedAt) throw new Error(`Could not read start time for VS Code process ${String(pid)}`);
  return `${process.platform}:${startedAt}`;
}
