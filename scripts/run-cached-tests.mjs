// @ts-check
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listProjectFiles, TestCache } from './test-cache.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITES = ['unit', 'scripts', 'browser', 'coverage'];

/** @param {string[]} args @returns {Promise<void>} */
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            signal
              ? `test process exited with ${signal}`
              : `test process exited with code ${String(code)}`
          )
        );
    });
  });
}

/** @param {string} suite @param {string[]} files */
export function testsForSuite(suite, files) {
  if (suite === 'unit' || suite === 'coverage') {
    return files.filter((file) => /^src\/.*\.test\.tsx?$/.test(file));
  }
  if (suite === 'scripts') return files.filter((file) => /^scripts\/[^/]+\.test\.mjs$/.test(file));
  if (suite === 'browser')
    return files.filter((file) => /^scripts\/browser\/[^/]+\.test\.mjs$/.test(file));
  throw new Error(`Unknown cached test suite: ${suite}`);
}

/** @param {string} suite @param {string[]} files */
async function runSuite(suite, files) {
  const tests = testsForSuite(suite, files);
  if (tests.length === 0) throw new Error(`No tests found for cached suite: ${suite}`);
  const vitest = suite === 'unit' || suite === 'coverage';
  const environment = Object.fromEntries(
    Object.entries(process.env)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .filter(([key]) =>
        /^(?:VARRO_|OPENCODE_|PLAYWRIGHT_|NODE_OPTIONS$|NODE_ENV$|CI$|TZ$|LANG$|LC_)/.test(key)
      )
  );
  const context = JSON.stringify([
    suite,
    process.platform,
    process.arch,
    process.version,
    environment,
  ]);
  const cache = new TestCache(
    projectRoot,
    path.join(projectRoot, 'tmp/test-cache', `${suite}.json`),
    files,
    context
  );
  await cache.load();
  const vitestCli = path.join(projectRoot, 'node_modules/vitest/vitest.mjs');
  if (suite === 'coverage') {
    // Partial coverage cannot enforce whole-project thresholds. Reuse only a full successful run.
    const fingerprint = await cache.hashFiles([...files, ...cache.globalFiles]);
    const externalIntegration = Boolean(process.env.VARRO_OPENCODE_TEST_BINARY);
    if (!externalIntegration && cache.entries.coverage === fingerprint) {
      process.stdout.write(
        '[test-cache] coverage: reused successful full-suite coverage and threshold checks\n'
      );
      return;
    }
    delete cache.entries.coverage;
    await cache.save();
    process.stdout.write('[test-cache] coverage: running full suite\n');
    await run([vitestCli, 'run', '--coverage']);
    if (!externalIntegration) cache.entries.coverage = fingerprint;
    await cache.save();
    return;
  }

  /** @type {Map<string, string>} */
  const selected = new Map();
  for (const test of tests) {
    const fingerprint = await cache.fingerprint([test], vitest);
    if (test.includes('.integration.test.') || cache.entries[test] !== fingerprint)
      selected.set(test, fingerprint);
  }
  process.stdout.write(
    `[test-cache] ${suite}: ${selected.size} to run, ${tests.length - selected.size} unchanged passing tests\n`
  );
  // Remove stale and selected entries before launching, including when interrupted or failing.
  cache.entries = Object.fromEntries(
    Object.entries(cache.entries).filter(([test]) => tests.includes(test) && !selected.has(test))
  );
  await cache.save();
  if (selected.size === 0) return;
  const testFiles = [...selected.keys()];
  await run(
    vitest ? [vitestCli, 'run', ...testFiles] : ['--test', '--test-timeout=60000', ...testFiles]
  );
  for (const [test, fingerprint] of selected) {
    if (!test.includes('.integration.test.')) cache.entries[test] = fingerprint;
  }
  await cache.save();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !arg.startsWith('--suite=') || !SUITES.includes(arg.slice(8)))) {
    throw new Error(
      'Usage: node scripts/run-cached-tests.mjs [--suite=unit|scripts|browser|coverage]'
    );
  }
  const suites =
    args.length === 0 ? ['unit', 'scripts'] : [...new Set(args.map((arg) => arg.slice(8)))];
  const files = listProjectFiles(projectRoot);
  for (const suite of suites) await runSuite(suite, files);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
