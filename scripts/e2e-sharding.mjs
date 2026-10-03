// @ts-check
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/** @typedef {import('@playwright/test/reporter').JSONReport} JSONReport */
/** @typedef {{ key: string, description: string, duration: number }} TestTiming */

const exec = promisify(execFile);
const directory = path.resolve('tmp/e2e-sharding');

/** @param {JSONReport} report @returns {TestTiming[]} */
export function reportTests(report) {
  /** @type {TestTiming[]} */
  const tests = [];
  /** @param {import('@playwright/test/reporter').JSONReportSuite} suite @param {string[]} titles */
  function visit(suite, titles) {
    for (const spec of suite.specs) {
      for (const test of spec.tests) {
        const titlePath = [...titles, spec.title];
        const file = spec.file.replaceAll('\\', '/');
        const project = test.projectName;
        if (
          [project, file, ...titlePath].some((part) => /[\r\n›]/.test(part) || part.trim() !== part)
        ) {
          throw new Error(`Test cannot be represented in a Playwright test list: ${spec.title}`);
        }
        tests.push({
          // File, project and title survive line-number changes and checkout relocation.
          key: JSON.stringify([project, file, ...titlePath]),
          description: `[${project}] › ${file} › ${titlePath.join(' › ')}`,
          duration: test.results
            .filter((result) => result.status !== 'skipped' && result.status !== 'interrupted')
            .reduce((sum, result) => sum + result.duration, 0),
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, [...titles, child.title]);
  }
  for (const suite of report.suites) visit(suite, []);
  return tests;
}

/** @param {string} file @returns {Promise<Map<string, number>>} */
export async function readTimings(file) {
  try {
    const history = JSON.parse(await readFile(file, 'utf8'));
    if (
      history.version !== 1 ||
      !history.durations ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate the artifact's untrusted JSON object before reading durations.
      typeof history.durations !== 'object' ||
      Array.isArray(history.durations)
    ) {
      throw new SyntaxError('Unsupported E2E timing history');
    }
    /** @type {[string, number][]} */
    const entries = Object.entries(history.durations);
    if (entries.some(([, duration]) => !Number.isFinite(duration) || duration <= 0)) {
      throw new SyntaxError('Invalid E2E test duration');
    }
    return new Map(entries);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return new Map();
    if (error instanceof SyntaxError || error instanceof TypeError) {
      process.stderr.write(`Ignoring invalid E2E timing history at ${file}: ${error.message}\n`);
      return new Map();
    }
    throw error;
  }
}

/** @param {TestTiming[]} tests @param {Map<string, number>} timings @param {number} count */
export function balanceTests(tests, timings, count) {
  if (!Number.isInteger(count) || count < 1)
    throw new Error('E2E shard count must be a positive integer');
  const known = tests.flatMap((test) =>
    timings.has(test.key) ? [timings.get(test.key) ?? 1] : []
  );
  const fallback = known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : 1;
  const weighted = tests.map((test) => ({ test, weight: timings.get(test.key) ?? fallback }));
  // Stable tie-breaking makes independently planned shards use the same partition.
  weighted.sort(
    (a, b) =>
      b.weight - a.weight || (a.test.key < b.test.key ? -1 : a.test.key > b.test.key ? 1 : 0)
  );
  /** @type {{ tests: TestTiming[], duration: number }[]} */
  const shards = Array.from({ length: count }, () => ({
    tests: [],
    duration: 0,
  }));
  for (const { test, weight } of weighted) {
    const shard = shards.reduce((best, candidate) =>
      candidate.duration < best.duration ||
      (candidate.duration === best.duration && candidate.tests.length < best.tests.length)
        ? candidate
        : best
    );
    shard.tests.push(test);
    shard.duration += weight;
  }
  return shards;
}

/** @param {string[]} args @returns {Promise<string[]>} */
export async function prepareShard(args) {
  const index = args.findIndex((arg) => arg === '--shard' || arg.startsWith('--shard='));
  if (index === -1) return args;
  const value = args[index] === '--shard' ? args[index + 1] : args[index].slice('--shard='.length);
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match) throw new Error('E2E shard must use current/total, for example 1/4');
  const current = Number(match[1]);
  const count = Number(match[2]);
  if (current < 1 || current > count || !Number.isSafeInteger(count))
    throw new Error(`Invalid E2E shard: ${value}`);
  const remaining = args.toSpliced(index, args[index] === '--shard' ? 2 : 1);
  if (remaining.some((arg) => arg === '--shard' || arg.startsWith('--shard='))) {
    throw new Error('Specify only one E2E shard');
  }
  if (
    remaining.some((arg) =>
      /^--(?:test-list(?:-invert)?|repeat-each|last-failed|only-changed)(?:=|$)/.test(arg)
    )
  ) {
    throw new Error(
      'Duration sharding cannot be combined with test lists, repeats, or previous-run filters'
    );
  }
  // CLI reporter selection must not leak into discovery's machine-readable stdout.
  const discovery = remaining.filter(
    (arg, i) =>
      arg !== '--list' &&
      arg !== '--reporter' &&
      !arg.startsWith('--reporter=') &&
      remaining[i - 1] !== '--reporter'
  );
  const env = { ...process.env };
  delete env.PLAYWRIGHT_JSON_OUTPUT_NAME;
  delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  delete env.PLAYWRIGHT_JSON_OUTPUT_DIR;
  const { stdout } = await exec(
    process.execPath,
    [
      fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url)),
      'test',
      ...discovery,
      '--list',
      '--reporter=json',
    ],
    { env, maxBuffer: 32 * 1024 * 1024, timeout: 120_000 }
  );
  /** @type {JSONReport} */
  const report = JSON.parse(stdout);
  const tests = reportTests(report);
  if (tests.length === 0 && !remaining.includes('--pass-with-no-tests')) {
    throw new Error('No E2E tests discovered for duration sharding');
  }
  const timings = await readTimings(path.join(directory, 'history/timings.json'));
  const hasHistory = tests.some((test) => timings.has(test.key));
  const shards = balanceTests(tests, timings, count);
  const selected = shards[current - 1];
  await mkdir(directory, { recursive: true });
  const list = path.join(directory, `shard-${current}.txt`);
  await writeFile(list, selected.tests.map((test) => test.description).join('\n') + '\n');
  process.stderr.write(
    `E2E shard ${current}/${count}: ${selected.tests.length}/${tests.length} tests, ${hasHistory ? `${Math.round(selected.duration)}ms estimated` : 'equal-weight fallback'}.\n`
  );
  if (!remaining.includes('--list')) {
    process.env.PLAYWRIGHT_JSON_OUTPUT_NAME = path.join(directory, `results-${current}.json`);
    if (!remaining.some((arg) => arg === '--reporter' || arg.startsWith('--reporter='))) {
      remaining.push('--reporter=list,json');
    }
  }
  return [...remaining, `--test-list=${list}`, '--pass-with-no-tests'];
}

/** @param {string[]} files @param {string} output */
export async function mergeTimings(files, output) {
  const durations = new Map();
  const seen = new Set();
  for (const file of files) {
    /** @type {JSONReport} */
    const report = JSON.parse(await readFile(file, 'utf8'));
    for (const test of reportTests(report)) {
      if (seen.has(test.key)) throw new Error(`Test appeared in multiple E2E shards: ${test.key}`);
      seen.add(test.key);
      if (Number.isFinite(test.duration) && test.duration > 0)
        durations.set(test.key, test.duration);
    }
  }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify({ version: 1, durations: Object.fromEntries(durations) }, null, 2) + '\n'
  );
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const [output, ...files] = process.argv.slice(2);
  if (!output || files.length === 0)
    throw new Error('Usage: node scripts/e2e-sharding.mjs <output> <shard reports...>');
  await mergeTimings(files, output);
}
