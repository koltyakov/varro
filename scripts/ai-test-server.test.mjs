import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { createWindowsProcessInspector } from './ai-streaming-selection.mjs';
import { stopTestServerChild, WindowsTestServerOwner } from './ai-test-server-lifecycle.mjs';

function fixture() {
  const state = {
    listeners: [202],
    birthIdentity: 'win32:100',
    executable: 'native.exe',
    alive: true,
  };
  const signals = [];
  const shim = {
    pid: 101,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      signals.push([this.pid, signal]);
      this.signalCode = signal;
    },
  };
  const inspector = {
    async prepare() {},
    async readListeners() {
      return state.listeners;
    },
    async read(pid, ancestorPid) {
      assert.equal(pid, 202);
      if (ancestorPid !== undefined) assert.equal(ancestorPid, shim.pid);
      return state;
    },
    dispose() {},
  };
  const owner = new WindowsTestServerOwner(inspector, 50000, shim, {
    isAlive: () => state.alive,
    terminate: ({ pid }) => {
      signals.push([pid, 'terminate']);
      state.alive = false;
      state.listeners = [];
    },
  });
  return { state, signals, shim, owner };
}

test('native listener exit precedes shim cleanup, including partial startup', async () => {
  for (const verified of [false, true]) {
    const { owner, signals, state } = fixture();
    if (verified) {
      await owner.capture();
      await owner.verify(202);
    }
    await owner.stop();
    assert.equal(state.alive, false);
    assert.deepEqual(signals, [
      [202, 'terminate'],
      [101, 'SIGTERM'],
    ]);
  }
});

test('shim exit and an empty port do not imply that the database owner exited', async () => {
  const { owner, shim, signals, state } = fixture();
  await owner.capture();
  shim.exitCode = 0;
  state.listeners = [];
  await owner.stop();
  assert.deepEqual(signals, [[202, 'terminate']]);
});

test('changed native identities and unexpected listeners cannot receive a signal', async () => {
  for (const change of [
    { birthIdentity: 'win32:200' },
    { executable: 'other.exe' },
    { listeners: [203] },
    { listeners: [202, 203] },
  ]) {
    const { owner, signals, state } = fixture();
    await owner.capture();
    Object.assign(state, change);
    await assert.rejects(owner.stop(), /identity changed|Unexpected native/);
    assert.deepEqual(signals, [[101, 'SIGTERM']]);
  }
});

test('isolation requires the captured database owner and a new native birth on PID reuse', async () => {
  const { owner } = fixture();
  await owner.capture();
  await assert.rejects(owner.verify(203), /database owner/);
  await assert.rejects(owner.verify(202, owner.identity), /previous native process/);
  await owner.verify(202, { pid: 202, birthIdentity: 'win32:90' });
});

test('a replacement endpoint during teardown blocks successful stop', async () => {
  const { owner, state } = fixture();
  await owner.capture();
  owner.terminate = () => {
    state.alive = false;
    state.listeners = [303];
  };
  await assert.rejects(owner.stop(), /still listening after cleanup/);
});

test(
  'Windows terminates the real native listener behind a launcher shim',
  {
    skip: process.platform !== 'win32',
    timeout: 90_000,
  },
  async (t) => {
    const inspector = await createWindowsProcessInspector();
    t.after(() => inspector.dispose());
    await inspector.prepare();
    const server = `const s = require('node:net').createServer();
      process.once('disconnect', () => s.close());
      s.listen(0, '127.0.0.1', () => process.send(s.address().port));`;
    const shim = spawn(
      process.execPath,
      [
        '-e',
        `
    const native = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(server)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    native.once('message', port => process.send({ pid: native.pid, port }));
    process.once('disconnect', () => native.kill());
  `,
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
    );
    t.after(async () => {
      if (shim.connected) shim.disconnect();
      await stopTestServerChild(shim);
    });
    const [{ port, pid }] = await once(shim, 'message', { signal: AbortSignal.timeout(10_000) });
    assert.notEqual(pid, shim.pid);
    const owner = new WindowsTestServerOwner(inspector, port, shim);
    await owner.capture();
    await owner.verify(pid);
    await owner.stop();
  }
);
