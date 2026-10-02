import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { testsForSuite } from './run-cached-tests.mjs';
import { listProjectFiles, TestCache } from './test-cache.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(context, contents = {}) {
  const parent = path.join(projectRoot, 'tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'test-cache-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  };
  await put('.gitignore', 'node_modules/\ntmp/\n');
  await put('package.json', '{"type":"module"}\n');
  await put('vitest.setup.ts', '');
  for (const [file, text] of Object.entries(contents)) await put(file, text);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const cache = (contextKey = 'unit') =>
    new TestCache(
      root,
      path.join(root, 'tmp/test-cache/unit.json'),
      listProjectFiles(root),
      contextKey
    );
  return { root, put, cache };
}

const graph = {
  'src/example.test.ts': "import { value } from './example';\n",
  'src/example.ts': "export { value } from './nested/index.js';\n",
  'src/nested/index.ts': 'export const value = 1;\n',
  'src/unrelated.ts': 'export const unrelated = 1;\n',
};

test('hashes transitive imports, re-exports, and JS-to-TS resolution without unrelated source', async (context) => {
  const f = await fixture(context, graph);
  const original = await f.cache().fingerprint(['src/example.test.ts'], true);
  await f.put('src/unrelated.ts', 'export const unrelated = 2;\n');
  assert.equal(await f.cache().fingerprint(['src/example.test.ts'], true), original);
  await f.put('src/nested/index.ts', 'export const value = 2;\n');
  assert.notEqual(await f.cache().fingerprint(['src/example.test.ts'], true), original);
});

test('invalidates when the test itself, setup, lockfile, or shared configuration changes', async (context) => {
  const f = await fixture(context, graph);
  for (const file of [
    'src/example.test.ts',
    'vitest.setup.ts',
    'package-lock.json',
    'vitest.config.mts',
    'tsconfig.json',
  ]) {
    const before = await f.cache().fingerprint(['src/example.test.ts'], true);
    await f.put(
      file,
      file.endsWith('.json') ? '{"changed":true}' : 'export const changed = true;\n'
    );
    assert.notEqual(await f.cache().fingerprint(['src/example.test.ts'], true), before, file);
  }
});

test('traverses literal dynamic imports, mocks, CommonJS requires, and circular imports', async (context) => {
  const f = await fixture(context, {
    'src/example.test.ts':
      "vi.mock('./mocked'); await import('./dynamic'); require('./required');\n",
    'src/mocked.ts': "import './dynamic'; export const mocked = 1;\n",
    'src/dynamic.ts': "import './mocked'; export const dynamic = 1;\n",
    'src/required.ts': 'export const required = 1;\n',
  });
  for (const file of ['src/mocked.ts', 'src/dynamic.ts', 'src/required.ts']) {
    const before = await f.cache().fingerprint(['src/example.test.ts'], true);
    await f.put(file, 'export const changed = true;\n');
    assert.notEqual(await f.cache().fingerprint(['src/example.test.ts'], true), before, file);
  }
});

test('includes the vscode alias, setup dependencies, and snapshots', async (context) => {
  const f = await fixture(context, {
    'src/example.test.ts': "import 'vscode';\n",
    'src/test/vscode.ts': 'export const vscode = 1;\n',
    'vitest.setup.ts': "import './src/setup-helper';\n",
    'src/setup-helper.ts': 'export const setup = 1;\n',
    'src/__snapshots__/example.test.ts.snap': 'snapshot\n',
  });
  for (const file of [
    'src/test/vscode.ts',
    'src/setup-helper.ts',
    'src/__snapshots__/example.test.ts.snap',
  ]) {
    const before = await f.cache().fingerprint(['src/example.test.ts'], true);
    await f.put(file, 'export const changed = true;\n');
    assert.notEqual(await f.cache().fingerprint(['src/example.test.ts'], true), before, file);
  }
});

test('fails closed for filesystem reads, subprocesses, nonliteral imports, and unresolved local imports', async (context) => {
  const f = await fixture(context, { 'fixture.txt': 'first' });
  for (const source of [
    "import fs from 'node:fs/promises';",
    "import './helper';",
    'await import(computedPath);',
    "import './missing';",
  ]) {
    await f.put('src/example.test.ts', source);
    await f.put('src/helper.ts', "import { spawn } from 'node:child_process';");
    const before = await f.cache().fingerprint(['src/example.test.ts'], true);
    await f.put('fixture.txt', `${source} changed`);
    assert.notEqual(await f.cache().fingerprint(['src/example.test.ts'], true), before, source);
  }
});

test('detects new and deleted dependencies and excludes ignored files', async (context) => {
  const f = await fixture(context, graph);
  const before = await f.cache().fingerprint(['src/example.test.ts'], true);
  await f.put('tmp/generated.txt', 'ignored');
  assert.equal(await f.cache().fingerprint(['src/example.test.ts'], true), before);
  execFileSync('git', ['add', 'src/nested/index.ts'], { cwd: f.root });
  await rm(path.join(f.root, 'src/nested/index.ts'));
  assert.ok(!listProjectFiles(f.root).includes('src/nested/index.ts'));
  assert.notEqual(await f.cache().fingerprint(['src/example.test.ts'], true), before);
});

test('persists passing fingerprints and isolates execution contexts and cache schema versions', async (context) => {
  const f = await fixture(context, graph);
  const cache = f.cache();
  cache.entries['src/example.test.ts'] = await cache.fingerprint(['src/example.test.ts'], true);
  await cache.save();
  const restored = f.cache();
  await restored.load();
  assert.deepEqual(restored.entries, cache.entries);
  const otherContext = f.cache('windows-node-other');
  await otherContext.load();
  assert.deepEqual(otherContext.entries, {});
  assert.notEqual(
    await otherContext.fingerprint(['src/example.test.ts'], true),
    cache.entries['src/example.test.ts']
  );
  const data = JSON.parse(await readFile(cache.filename, 'utf8'));
  await writeFile(cache.filename, JSON.stringify({ ...data, version: 999 }));
  const otherSchema = f.cache();
  await otherSchema.load();
  assert.deepEqual(otherSchema.entries, {});
});

test('treats missing, malformed, and invalid cache files as misses', async (context) => {
  const f = await fixture(context);
  const cache = f.cache();
  await cache.load();
  assert.deepEqual(cache.entries, {});
  for (const contents of ['{', 'null', '[]', '{"version":1,"context":"unit","entries":[]}']) {
    await f.put('tmp/test-cache/unit.json', contents);
    await cache.load();
    assert.deepEqual(cache.entries, {});
  }
});

test('discovers exactly the existing unit and Node suites', () => {
  const files = [
    'src/a.test.ts',
    'src/b.test.tsx',
    'src/a.ts',
    'scripts/a.test.mjs',
    'scripts/browser/a.test.mjs',
    'e2e/a.spec.ts',
  ];
  assert.deepEqual(testsForSuite('unit', files), files.slice(0, 2));
  assert.deepEqual(testsForSuite('coverage', files), files.slice(0, 2));
  assert.deepEqual(testsForSuite('scripts', files), ['scripts/a.test.mjs']);
  assert.deepEqual(testsForSuite('browser', files), ['scripts/browser/a.test.mjs']);
  assert.throws(() => testsForSuite('unknown', files), /Unknown cached test suite/);
});

async function runnerFixture(context, contents) {
  const f = await fixture(context, contents);
  const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
  await mkdir(path.join(f.root, 'scripts'), { recursive: true });
  for (const file of ['test-cache.mjs', 'run-cached-tests.mjs']) {
    await copyFile(path.join(projectRoot, 'scripts', file), path.join(f.root, 'scripts', file));
  }
  await symlink(
    path.join(projectRoot, 'node_modules'),
    path.join(f.root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  return {
    ...f,
    run: (suite = 'scripts') =>
      spawnSync(process.execPath, ['scripts/run-cached-tests.mjs', `--suite=${suite}`], {
        cwd: f.root,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...environment, VARRO_OPENCODE_TEST_BINARY: '' },
      }),
  };
}

const passingScript =
  "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from './helper.mjs'; test('fixture', () => assert.equal(value, 1));\n";

test('runner reuses passes, reruns changed dependencies, and never caches failures', async (context) => {
  const f = await runnerFixture(context, {
    'scripts/example.test.mjs': passingScript,
    'scripts/helper.mjs': 'export const value = 1;\n',
    'scripts/other.test.mjs': "import test from 'node:test'; test('other', () => {});\n",
  });
  let result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /2 to run, 0 unchanged/);
  result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /0 to run, 2 unchanged/);
  await f.put('scripts/helper.mjs', 'export const value = 2;\n');
  for (let attempt = 0; attempt < 2; attempt++) {
    result = f.run();
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /1 to run, 1 unchanged/);
    const data = JSON.parse(
      await readFile(path.join(f.root, 'tmp/test-cache/scripts.json'), 'utf8')
    );
    assert.equal(data.entries['scripts/example.test.mjs'], undefined);
    assert.ok(data.entries['scripts/other.test.mjs']);
  }
  await f.put('scripts/helper.mjs', 'export const value = 1;\n');
  result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 to run, 1 unchanged/);
});

test('runner never reuses external integration tests and removes deleted test entries', async (context) => {
  const f = await runnerFixture(context, {
    'scripts/external.integration.test.mjs':
      "import test from 'node:test'; test('external', () => {});\n",
    'scripts/other.test.mjs': "import test from 'node:test'; test('other', () => {});\n",
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = f.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, attempt === 0 ? /2 to run, 0 unchanged/ : /1 to run, 1 unchanged/);
  }
  await rm(path.join(f.root, 'scripts/other.test.mjs'));
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const data = JSON.parse(await readFile(path.join(f.root, 'tmp/test-cache/scripts.json'), 'utf8'));
  assert.deepEqual(data.entries, {});
});

test('runner selects only affected Vitest files and propagates their failures', async (context) => {
  const f = await runnerFixture(context, {
    'vitest.config.mts':
      "export default { test: { environment: 'node', include: ['src/**/*.test.ts'] } };\n",
    'src/value.ts': 'export const value = 1;\n',
    'src/value.test.ts':
      "import { test, expect } from 'vitest'; import { value } from './value'; test('value', () => expect(value).toBe(1));\n",
    'src/other.test.ts': "import { test } from 'vitest'; test('other', () => {});\n",
  });
  let result = f.run('unit');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /2 to run, 0 unchanged/);
  result = f.run('unit');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /0 to run, 2 unchanged/);
  await f.put('src/value.ts', 'export const value = 2;\n');
  result = f.run('unit');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 to run, 1 unchanged/);
  const data = JSON.parse(await readFile(path.join(f.root, 'tmp/test-cache/unit.json'), 'utf8'));
  assert.equal(data.entries['src/value.test.ts'], undefined);
  assert.ok(data.entries['src/other.test.ts']);
});

test('runner caches coverage only after full-suite thresholds pass', async (context) => {
  const f = await runnerFixture(context, {
    'vitest.config.mts':
      "export default { test: { environment: 'node', include: ['src/**/*.test.ts'], coverage: { reportsDirectory: 'tmp/coverage', include: ['src/*.ts'], exclude: ['src/*.test.ts'], thresholds: { lines: 100 } } } };\n",
    'src/value.ts': 'export const value = 1;\n',
    'src/value.test.ts':
      "import { test, expect } from 'vitest'; import { value } from './value'; test('value', () => expect(value).toBe(1));\n",
  });
  let result = f.run('coverage');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /coverage: running full suite/);
  result = f.run('coverage');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /reused successful full-suite coverage/);
  // An unimported source file changes the full-project coverage denominator.
  await f.put('src/uncovered.ts', 'export function uncovered() { return 2; }\n');
  result = f.run('coverage');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /coverage: running full suite/);
  const data = JSON.parse(
    await readFile(path.join(f.root, 'tmp/test-cache/coverage.json'), 'utf8')
  );
  assert.equal(data.entries.coverage, undefined);
});
