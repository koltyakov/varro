import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createCdpRequestClient,
  getVscodeSidebarGeometry,
  hasRecreatedVarroTarget,
  reserveLoopbackPort,
  vscodeLaunchCommandMatches,
  waitForVscodeProcess,
  writeVscodeLaunchMetadata,
} from './vscode-launch-process.mjs';

class FakeSocket {
  listeners = new Map();
  sent = [];

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(value) {
    this.sent.push(value);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function fakeElement(rect, { src = '', title = '' } = {}) {
  return {
    src,
    title,
    getBoundingClientRect: () => ({
      ...rect,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
    }),
  };
}

function fakeWorkbenchDocument({ iframes, sidebars, sashes }) {
  return {
    querySelectorAll(selector) {
      if (selector === 'iframe.webview') return iframes;
      if (selector === '.part.auxiliarybar, .part.sidebar') return sidebars;
      if (selector === '.monaco-sash.vertical:not(.disabled)') return sashes;
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };
}

test('accepts a changed Varro target without requiring an unavailable polling frame', () => {
  assert.equal(hasRecreatedVarroTarget('old', 'new', false), true);
  assert.equal(hasRecreatedVarroTarget('same', 'same', true), false);
  assert.equal(hasRecreatedVarroTarget(undefined, 'new', false), false);
  assert.equal(hasRecreatedVarroTarget(undefined, 'new', true), true);
});

test('locates a detached Varro webview overlay by its sidebar geometry', () => {
  const geometry = getVscodeSidebarGeometry(
    fakeWorkbenchDocument({
      iframes: [
        fakeElement(
          { x: 1141, y: 68, width: 289, height: 790 },
          { src: 'vscode-webview://varro/?extensionId=koltyakov.varro' }
        ),
      ],
      sidebars: [
        fakeElement({ x: 48, y: 35, width: 296, height: 829 }),
        fakeElement({ x: 1140, y: 35, width: 292, height: 829 }),
      ],
      sashes: [
        fakeElement({ x: 344, y: 35, width: 4, height: 833 }),
        fakeElement({ x: 1136, y: 35, width: 4, height: 833 }),
      ],
    }),
    1440
  );

  assert.deepEqual(geometry, {
    frame: [1141, 68, 289, 790],
    sashX: 1136,
    viewportWidth: 1440,
  });
});

test('does not treat a detached Varro webview outside the sidebars as visible there', () => {
  const geometry = getVscodeSidebarGeometry(
    fakeWorkbenchDocument({
      iframes: [
        fakeElement(
          { x: 400, y: 68, width: 600, height: 790 },
          { src: 'vscode-webview://varro/?extensionId=koltyakov.varro' }
        ),
      ],
      sidebars: [fakeElement({ x: 1140, y: 35, width: 292, height: 829 })],
      sashes: [fakeElement({ x: 1136, y: 35, width: 4, height: 833 })],
    }),
    1440
  );

  assert.deepEqual(geometry, {
    error: 'expected one visible Varro sidebar iframe, found 0',
  });
});

test('writes atomic launch metadata for the tracked process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vscode-launch-test-'));
  const metadataPath = path.join(root, 'launch.json');

  try {
    const metadata = await writeVscodeLaunchMetadata(metadataPath, {
      pid: process.pid,
      executable: process.execPath,
      profileRoot: root,
      userDataDir: path.join(root, 'u'),
      extensionsDir: path.join(root, 'e'),
      workspace: process.cwd(),
      remoteDebuggingPort: 9222,
      sidebarWidth: 486,
    });
    const saved = JSON.parse(await readFile(metadataPath, 'utf8'));

    assert.equal(saved.pid, process.pid);
    assert.equal(saved.executable, process.execPath);
    assert.equal(saved.userDataDir, path.join(root, 'u'));
    assert.equal(saved.remoteDebuggingPort, 9222);
    assert.equal(saved.sidebarWidth, 486);
    assert.match(saved.birthIdentity, new RegExp(`^${process.platform}:`));
    assert.deepEqual(saved, metadata);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('matches all identity-bearing launch arguments', () => {
  const launch = {
    executable: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    profileRoot: '/tmp/vfz-safe',
    userDataDir: '/tmp/vfz-safe/u',
    extensionsDir: '/tmp/vfz-safe/e',
    workspace: '/repo/tmp/opencode',
    remoteDebuggingPort: 9222,
  };
  const command = `${launch.executable} --remote-debugging-port=9222 --user-data-dir=/tmp/vfz-safe/u --extensions-dir=/tmp/vfz-safe/e /repo/tmp/opencode`;

  assert.equal(vscodeLaunchCommandMatches(command, launch), true);
  assert.equal(
    vscodeLaunchCommandMatches(command, { ...launch, remoteDebuggingPort: 9333 }),
    false
  );
  assert.equal(vscodeLaunchCommandMatches(command, { ...launch, workspace: '/repo' }), false);
});

test('reserves an available loopback port', async () => {
  const port = await reserveLoopbackPort();
  assert.equal(Number.isInteger(port), true);
  assert.equal(port > 0, true);
});

test('does not match an unrelated process profile', async () => {
  await assert.rejects(
    waitForVscodeProcess(process.execPath, '/tmp/varro-profile-that-does-not-exist', 1),
    /Could not find the VS Code process/
  );
});

test('rejects pending CDP requests and removes listeners when the socket closes', async () => {
  const socket = new FakeSocket();
  const client = createCdpRequestClient(socket, 1_000);
  const pending = client.call('Runtime.evaluate', { expression: '1' });

  assert.equal(client.pendingCount(), 1);
  assert.equal(socket.listenerCount('message'), 1);
  socket.emit('close');

  await assert.rejects(pending, /socket closed/);
  assert.equal(client.pendingCount(), 0);
  assert.equal(socket.listenerCount('message'), 0);
  assert.equal(socket.listenerCount('close'), 0);
  assert.equal(socket.listenerCount('error'), 0);
});

test('times out a CDP request without retaining its pending entry', async () => {
  const socket = new FakeSocket();
  const client = createCdpRequestClient(socket, 1);

  await assert.rejects(client.call('Runtime.evaluate'), /timed out/);
  assert.equal(client.pendingCount(), 0);
  client.dispose();
  assert.equal(socket.listenerCount('message'), 0);
});
