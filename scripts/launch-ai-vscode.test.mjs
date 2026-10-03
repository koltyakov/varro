import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('./launch-ai-vscode.mjs', import.meta.url), 'utf8');
const start = source.indexOf('let launchComplete = false;');
const end = source.indexOf('let isolation;', start);
assert.ok(start >= 0 && end > start);
// Evaluate only cleanup registration, never the editor launch or server provisioning.
const cleanupSource = source.slice(start, end);

await test('failed editor launch cleanup handles successful and rejected server stops', async () => {
  for (const event of ['beforeExit', 'uncaughtException']) {
    for (const rejection of [false, true]) {
      const process = new EventEmitter();
      let output = '';
      let exitCode;
      let stops = 0;
      process.stderr = {
        write: (text) => {
          output += text;
        },
      };
      process.exit = (code) => {
        exitCode = code;
      };
      const managedServer = {
        stop: async () => {
          stops += 1;
          if (rejection) throw new Error('cleanup failed');
        },
      };
      runInNewContext(cleanupSource, { process, managedServer });
      process.emit(event, new Error('launch failed'));
      await setImmediate();
      assert.equal(stops, 1);
      if (event === 'uncaughtException') {
        assert.equal(exitCode, 1);
        assert.match(output, /launch failed/);
      } else {
        assert.equal(process.exitCode, rejection ? 1 : undefined);
      }
      assert.equal(output.includes('cleanup failed'), rejection);
    }
  }
});

await test('cleanup leaves a successfully launched server running and handles absent servers', async () => {
  for (const managedServer of [
    undefined,
    { stop: async () => assert.fail('server must remain running') },
  ]) {
    const process = new EventEmitter();
    let output = '';
    let exitCode;
    process.stderr = {
      write: (text) => {
        output += text;
      },
    };
    process.exit = (code) => {
      exitCode = code;
    };
    runInNewContext(`${cleanupSource}\nlaunchComplete = true;`, { process, managedServer });
    process.emit('beforeExit');
    await setImmediate();
    assert.equal(output, '');
    assert.equal(exitCode, undefined);
  }
  const process = new EventEmitter();
  let exitCode;
  process.stderr = { write: () => {} };
  process.exit = (code) => {
    exitCode = code;
  };
  runInNewContext(cleanupSource, { process, managedServer: undefined });
  process.emit('uncaughtException', new Error('early launch failure'));
  await setImmediate();
  assert.equal(exitCode, 1);
});
