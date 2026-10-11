import assert from 'node:assert/strict';
import { glob } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const { default: config } = await import(new URL('../vitest.config.mts', import.meta.url).href);

async function projectFiles(project) {
  const files = await Array.fromAsync(
    glob(project.test.include, { cwd: projectRoot, exclude: project.test.exclude })
  );
  return files.map((file) => file.replaceAll('\\', '/'));
}

test('assigns every source test to exactly one Vitest project', async () => {
  const files = (await Array.fromAsync(glob('src/**/*.test.{ts,tsx}', { cwd: projectRoot }))).map(
    (file) => file.replaceAll('\\', '/')
  );
  const assigned = (await Promise.all(config.test.projects.map(projectFiles))).flat();
  assert.equal(new Set(assigned).size, assigned.length, 'a test belongs to multiple projects');
  assert.deepEqual(assigned.toSorted(), files.toSorted(), 'a source test was dropped');
});

test('runs backend tests without browser setup and retains browser contracts in jsdom', async () => {
  const backend = config.test.projects.find((project) => project.test.name === 'backend');
  const browser = config.test.projects.find((project) => project.test.name === 'unit');
  assert.equal(backend.test.environment, 'node');
  assert.equal(backend.test.setupFiles, undefined);
  assert.equal(browser.test.environment, 'jsdom');
  assert.deepEqual(browser.test.setupFiles, ['./vitest.setup.ts']);
  const backendFiles = await projectFiles(backend);
  const browserFiles = await projectFiles(browser);
  for (const file of [
    'src/extension/about-view.test.ts',
    'src/extension/commands.test.ts',
    'src/extension/opencode-v2.integration.test.ts',
    'src/extension/server.test.ts',
    'src/extension/sidebar-provider.export.test.ts',
    'src/shared/attention-contract.test.ts',
  ]) {
    assert.ok(browserFiles.includes(file), `${file} requires the existing jsdom environment`);
    assert.ok(!backendFiles.includes(file));
  }
  assert.ok(backendFiles.includes('src/extension/open-code-transport.test.ts'));
  assert.ok(backendFiles.includes('src/shared/protocol.test.ts'));
});

test('bounds worker concurrency without relaxing test timeouts', () => {
  assert.equal(
    config.test.maxWorkers,
    Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)))
  );
  assert.equal(config.test.testTimeout, undefined);
  assert.equal(config.test.hookTimeout, undefined);
});

test('runs native Windows inspection after all other projects without relaxing coverage', async () => {
  const native = config.test.projects.find((project) => project.test.name === 'windows-native');
  assert.equal(native.test.environment, 'node');
  assert.equal(native.test.setupFiles, undefined);
  assert.deepEqual(await projectFiles(native), [
    'src/extension/windows-process-inspector.integration.test.ts',
  ]);
  for (const project of config.test.projects.filter((candidate) => candidate !== native)) {
    assert.ok((project.test.sequence?.groupOrder ?? 0) < native.test.sequence.groupOrder);
  }
  assert.deepEqual(config.test.coverage.thresholds, {
    statements: 86,
    branches: 78,
    functions: 89,
    lines: 89,
  });
});
