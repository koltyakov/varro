import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await test('script promise rules work without Vite and exempt only Node test registrations', async (t) => {
  const parent = path.join(os.tmpdir(), 'opencode');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'varro-lint-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'scripts'));
  for (const file of [
    'oxlint.config.mts',
    'tsconfig.json',
    'tsconfig.scripts.json',
    'scripts/tsconfig.json',
  ]) {
    await copyFile(path.join(root, file), path.join(directory, file));
  }
  await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
  await writeFile(
    path.join(directory, 'scripts/safe.test.mjs'),
    `import test from 'node:test';
import { createServer } from 'node:http';
test('registration', async (t) => { t.test('child', async () => {}); });
const ownershipTest = process.platform === 'win32' ? test.skip : test;
ownershipTest('platform registration', async () => {});
createServer(async (_request, response) => { response.end(); });
`
  );
  const lint = () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'node_modules/oxlint/bin/oxlint'),
        '-c',
        'oxlint.config.mts',
        '--type-aware',
        '--format=json',
        'scripts',
      ],
      { cwd: directory, encoding: 'utf8', timeout: 30_000 }
    );
    assert.ifError(result.error);
    assert.ok(result.stdout, result.stderr);
    return { status: result.status, diagnostics: JSON.parse(result.stdout).diagnostics };
  };
  assert.deepEqual(lint(), { status: 0, diagnostics: [] });

  await writeFile(
    path.join(directory, 'scripts/unsafe.mjs'),
    `async function work() {}
work();
process.once('exit', async () => {});
`
  );
  await writeFile(
    path.join(directory, 'scripts/unsafe.test.mjs'),
    `async function test() {}
test();
`
  );
  const result = lint();
  assert.equal(result.status, 1);
  assert.deepEqual(result.diagnostics.map(({ filename, code }) => [filename, code]).toSorted(), [
    ['scripts/unsafe.mjs', 'typescript(no-floating-promises)'],
    ['scripts/unsafe.mjs', 'typescript(no-misused-promises)'],
    ['scripts/unsafe.test.mjs', 'typescript(no-floating-promises)'],
  ]);
});
