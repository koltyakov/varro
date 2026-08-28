import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import crossSpawn from 'cross-spawn';

test(
  'cross-spawn preserves Windows cmd paths and arguments with metacharacters',
  { skip: process.platform !== 'win32' },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'varro-cross-spawn-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'OpenCode %VARRO_LITERAL% !^&()');
    await mkdir(directory);
    const runner = path.join(directory, 'runner.cjs');
    const launcher = path.join(directory, 'opencode.cmd');
    await writeFile(runner, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    await writeFile(launcher, `@"${process.execPath}" "%~dp0runner.cjs" %*\r\n`);

    const expected = ['serve', '--label', 'hello & %VARRO_LITERAL% !^()', 'trailing\\'];
    const output = await new Promise((resolve, reject) => {
      const child = crossSpawn(launcher, expected, {
        env: { ...process.env, VARRO_LITERAL: 'expanded' },
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (data) => {
        stdout += String(data);
      });
      child.stderr?.on('data', (data) => {
        stderr += String(data);
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || `cross-spawn fixture exited with code ${String(code)}`));
      });
    });

    assert.deepEqual(JSON.parse(output), expected);
  }
);
