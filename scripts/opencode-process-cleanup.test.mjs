import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AdapterProcessCleanup } from './opencode-compatibility/process-cleanup.mjs';

test('adapter cleanup requires an absolute scope and an exact installation boundary', () => {
  assert.throws(() => new AdapterProcessCleanup('.'), /absolute/);
  const scope = join(tmpdir(), 'opencode', 'cleanup-unit');
  const cleanup = new AdapterProcessCleanup(scope);
  const identity = {
    pid: 12345,
    birth: 'fixture',
    command: join(scope, 'opencode') + ' serve --port 50000',
  };
  assert.equal(cleanup.owns(identity), true);
  assert.equal(cleanup.owns({ ...identity, pid: process.pid }), false);
  assert.equal(cleanup.owns({ ...identity, birth: '' }), false);
  assert.equal(cleanup.owns({ ...identity, command: scope + '-other/opencode serve' }), false);
  assert.equal(
    cleanup.owns({ ...identity, command: join(scope, 'opencode') + ' --version' }),
    false
  );
  assert.equal(cleanup.owns({ ...identity, command: '/usr/local/bin/opencode serve' }), false);
});

test(
  'adapter guard removes leaked servers, escalates, and leaves other runs alone',
  {
    skip: process.platform === 'win32',
    timeout: 20000,
  },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'adapter-cleanup-'));
    const executable = join(root, 'opencode');
    await symlink(process.execPath, executable);
    const cleanup = new AdapterProcessCleanup(root);
    const leaked = spawn(
      executable,
      [
        '-e',
        'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)',
        '--',
        'serve',
      ],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      }
    );
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    context.after(async () => {
      leaked.kill('SIGKILL');
      unrelated.kill('SIGKILL');
      await cleanup.cleanup();
    });
    await once(leaked.stdout, 'data');
    const exited = once(leaked, 'exit');
    assert.deepEqual(await cleanup.cleanup(), [leaked.pid]);
    await exited;
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
    assert.deepEqual(await cleanup.cleanup(), []);
  }
);

test(
  'adapter cleanup also stops tool descendants outside the installation directory',
  {
    skip: process.platform === 'win32',
    timeout: 20000,
  },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'adapter-descendants-'));
    const executable = join(root, 'opencode');
    await symlink(process.execPath, executable);
    const cleanup = new AdapterProcessCleanup(root);
    const server = spawn(
      executable,
      [
        '-e',
        `
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {});
    const tool = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], {
      detached: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    tool.stdout.once('data', () => process.send({ type: 'tool-ready', pid: tool.pid }));
    setInterval(() => {}, 1000);
  `,
        '--',
        'serve',
      ],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }
    );
    context.after(async () => {
      await cleanup.cleanup();
      server.kill('SIGKILL');
    });
    const [message] = await once(server, 'message');
    assert.equal(message.type, 'tool-ready');
    const descendant = message.pid;
    assert.ok(Number.isSafeInteger(descendant) && descendant > 0, 'Expected a valid tool PID');
    const recovered = await cleanup.cleanup();
    assert.deepEqual(
      recovered.toSorted((a, b) => a - b),
      [server.pid, descendant].toSorted((a, b) => a - b)
    );
    assert.equal(
      (await cleanup.inventory()).some((value) => value.pid === descendant),
      false
    );
  }
);

for (const mode of ['success', 'failure', 'timeout', 'interrupt', 'output-limit']) {
  test(
    `adapter runner cleans detached servers after ${mode}`,
    {
      skip: process.platform === 'win32',
      timeout: 20000,
    },
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'adapter-runner-'));
      const executable = join(root, 'opencode');
      await symlink(process.execPath, executable);
      const cleanup = new AdapterProcessCleanup(root);
      context.after(() => cleanup.cleanup());
      let source = `
      const { spawn } = require('node:child_process');
      const child = spawn(${JSON.stringify(executable)}, ['-e',
        'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)',
        '--', 'serve'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.once('data', () => {
        child.stdout.destroy();
        child.unref();
        ${mode === 'success' ? 'process.exit(0)' : mode === 'failure' ? 'process.exit(7)' : mode === 'output-limit' ? 'console.log("x".repeat(2048)); setInterval(() => {}, 1000)' : 'setInterval(() => {}, 1000)'};
      });
    `;
      if (mode === 'timeout' || mode === 'interrupt') {
        // Establish the owned server before starting the runner's timeout or abort deadline.
        const server = spawn(
          executable,
          [
            '-e',
            'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)',
            '--',
            'serve',
          ],
          { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
        );
        await once(server.stdout, 'data');
        server.stdout.destroy();
        server.unref();
        source = 'setInterval(() => {}, 1000)';
      }
      const result = await cleanup.run(process.execPath, ['-e', source], {
        timeout: mode === 'timeout' ? 500 : 10000,
        maxBuffer: mode === 'output-limit' ? 1024 : 1024 * 1024,
        signal: mode === 'interrupt' ? AbortSignal.timeout(500) : undefined,
      });
      assert.equal(result.recoveredProcesses.length, 1);
      if (mode === 'success') assert.equal(result.status, 0);
      else if (mode === 'failure') assert.equal(result.status, 7);
      else if (mode === 'timeout') {
        assert.match(result.error?.message ?? '', /Adapter runner exceeded its timeout/);
      } else if (mode === 'interrupt') {
        assert.equal(result.error?.name, 'TimeoutError');
      } else assert.ok(result.error);
      assert.deepEqual(await cleanup.cleanup(), []);
    }
  );
}
