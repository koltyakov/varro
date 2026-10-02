import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCachedE2e } from './run-cached-e2e.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(context) {
  const parent = path.join(projectRoot, 'tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'e2e-cache-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file, contents) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  };
  await put('.gitignore', 'tmp/\n.env*\n');
  await put('e2e/tests/example.spec.ts', 'test fixture');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  let runs = 0;
  const options = {
    root,
    args: [],
    environment: {},
    browserVersion: async () => 'chromium-fixture-1',
    run: async () => {
      runs++;
    },
  };
  return {
    root,
    put,
    options,
    runs: () => runs,
    run: (overrides = {}) => runCachedE2e({ ...options, ...overrides }),
    cache: async () =>
      JSON.parse(await readFile(path.join(root, 'tmp/test-cache/e2e.json'), 'utf8')),
  };
}

test('reuses a full pass and invalidates source, assets, config, lockfile, and ignored Vite env files', async (context) => {
  const f = await fixture(context);
  await f.run();
  await f.run();
  assert.equal(f.runs(), 1);
  for (const file of [
    'src/webview/component.tsx',
    'src/webview/styles.css',
    'e2e/harness/index.html',
    'e2e/tests/example.spec.ts',
    'playwright.config.ts',
    'vite.config.mts',
    'package-lock.json',
    '.env',
    '.env.local',
    '.env.e2e',
    '.env.e2e.local',
  ]) {
    const before = f.runs();
    await f.put(file, 'changed');
    await f.run();
    assert.equal(f.runs(), before + 1, file);
    await f.run();
    assert.equal(f.runs(), before + 1, file);
  }
  await rm(path.join(f.root, 'e2e/tests/example.spec.ts'));
  const before = f.runs();
  await f.run();
  assert.equal(f.runs(), before + 1);
});

test('invalidates the browser and test environment without persisting environment secrets', async (context) => {
  const f = await fixture(context);
  await f.run();
  await f.run({ browserVersion: async () => 'chromium-fixture-2' });
  assert.equal(f.runs(), 2);
  for (const key of [
    'CI',
    'TZ',
    'NODE_OPTIONS',
    'VARRO_E2E_PORT',
    'PLAYWRIGHT_BROWSERS_PATH',
    'VITE_TOKEN',
  ]) {
    const overrides = { environment: { [key]: 'secret-fixture-value' } };
    const before = f.runs();
    await f.run(overrides);
    await f.run(overrides);
    assert.equal(f.runs(), before + 1, key);
    assert.ok(!JSON.stringify(await f.cache()).includes('secret-fixture-value'));
  }
});

test('filtered, list-only, sharded, and custom-mode runs neither reuse nor update the full-suite cache', async (context) => {
  const f = await fixture(context);
  await f.run();
  const original = await f.cache();
  for (const overrides of [
    { args: ['e2e/tests/example.spec.ts'] },
    { args: ['--grep', 'composer'] },
    { args: ['--last-failed'] },
    { args: ['--list'] },
    { args: ['--shard=1/4'] },
    { environment: { VARRO_E2E_MODE: 'raster' } },
    { environment: { VARRO_E2E_MODE: 'playback' } },
  ]) {
    const before = f.runs();
    await f.run({
      ...overrides,
      browserVersion: async () => {
        throw new Error('Bypassed runs must not probe the browser');
      },
    });
    assert.equal(f.runs(), before + 1);
    assert.deepEqual(await f.cache(), original);
  }
  const before = f.runs();
  await f.run();
  assert.equal(f.runs(), before);
});

test('failures and interruptions clear successes before launch and never create cached passes', async (context) => {
  const f = await fixture(context);
  await f.run();
  await f.put('src/changed.ts', 'changed');
  for (const message of ['exit code 1', 'SIGTERM']) {
    await assert.rejects(
      f.run({
        run: async () => {
          assert.deepEqual((await f.cache()).entries, {});
          throw new Error(message);
        },
      }),
      new RegExp(message)
    );
    assert.deepEqual((await f.cache()).entries, {});
  }
  await f.run();
  await f.run();
  assert.equal(f.runs(), 2);
});

test('a malformed cache reruns tests and a missing browser cannot produce a cache hit', async (context) => {
  const f = await fixture(context);
  await f.run();
  await assert.rejects(
    f.run({
      browserVersion: async () => {
        throw new Error('Browser is missing');
      },
    }),
    /Browser is missing/
  );
  assert.equal(f.runs(), 1);
  await f.put('tmp/test-cache/e2e.json', '{');
  await f.run();
  assert.equal(f.runs(), 2);
});
