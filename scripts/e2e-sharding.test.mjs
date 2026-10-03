import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  balanceTests,
  mergeTimings,
  prepareShard,
  readTimings,
  reportTests,
} from './e2e-sharding.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

async function temporaryDirectory(prefix) {
  await mkdir(path.join(tmpdir(), 'opencode'), { recursive: true });
  const parent = await realpath(path.join(tmpdir(), 'opencode'));
  return mkdtemp(path.join(parent, prefix));
}

function timing(key) {
  return { key, description: key, duration: 0 };
}

function report(title = 'test', results = [], projectName = 'chromium') {
  return {
    suites: [
      {
        title: 'example.spec.ts',
        specs: [],
        suites: [
          {
            title: 'group',
            suites: [],
            specs: [
              {
                title,
                file: 'example.spec.ts',
                line: 42,
                tests: [{ projectName, results }],
              },
            ],
          },
        ],
      },
    ],
  };
}

test('balances longest tests first by historical duration', () => {
  const tests = ['a', 'b', 'c', 'd', 'e'].map(timing);
  const history = new Map([
    ['a', 9],
    ['b', 8],
    ['c', 7],
    ['d', 6],
    ['e', 5],
  ]);
  const shards = balanceTests(tests, history, 2);
  assert.deepEqual(
    shards.map((shard) => shard.duration),
    [20, 15]
  );
  assert.deepEqual(
    shards.map((shard) => shard.tests.map((entry) => entry.key)),
    [
      ['a', 'd', 'e'],
      ['b', 'c'],
    ]
  );
  assert.deepEqual(balanceTests(tests.toReversed(), history, 2), shards);
});

test('missing history gives count-balanced shards with no duplicates or omissions', () => {
  const tests = Array.from({ length: 11 }, (_, index) => timing(String(index)));
  const shards = balanceTests(tests, new Map(), 4);
  assert.deepEqual(
    shards.map((shard) => shard.tests.length),
    [3, 3, 3, 2]
  );
  assert.deepEqual(
    shards.flatMap((shard) => shard.tests.map((entry) => entry.key)).toSorted(),
    tests.map((entry) => entry.key).toSorted()
  );
  assert.deepEqual(
    balanceTests([], new Map(), 4).map((shard) => shard.tests),
    [[], [], [], []]
  );
  assert.deepEqual(
    balanceTests([timing('one')], new Map(), 4).map((shard) => shard.tests.length),
    [1, 0, 0, 0]
  );
  assert.throws(() => balanceTests([], new Map(), 0), /positive integer/);
  assert.throws(() => balanceTests([], new Map(), 1.5), /positive integer/);
});

test('new tests use the average duration of current known tests, ignoring removed tests', () => {
  const shards = balanceTests(
    ['a', 'b', 'new'].map(timing),
    new Map([
      ['a', 10],
      ['b', 30],
      ['removed', 900],
    ]),
    2
  );
  assert.deepEqual(
    shards.map((shard) => shard.duration),
    [30, 30]
  );
});

test('identities include project, relative file and nested titles but not line numbers', () => {
  const source = report('test > comparison', [{ status: 'passed', duration: 5 }]);
  const [entry] = reportTests(source);
  assert.equal(
    entry.key,
    JSON.stringify(['chromium', 'example.spec.ts', 'group', 'test > comparison'])
  );
  assert.equal(entry.description, '[chromium] › example.spec.ts › group › test > comparison');
  source.suites[0].suites[0].specs[0].line = 100;
  assert.deepEqual(reportTests(source), [entry]);
  assert.notEqual(reportTests(report('test > comparison', [], 'firefox'))[0].key, entry.key);
  assert.throws(() => reportTests(report('unrepresentable › title')), /cannot be represented/);
});

test('timings sum retry attempts and exclude skipped or interrupted attempts', () => {
  const [entry] = reportTests(
    report('test', [
      { status: 'failed', duration: 10 },
      { status: 'timedOut', duration: 20 },
      { status: 'passed', duration: 5 },
      { status: 'skipped', duration: 99 },
      { status: 'interrupted', duration: 99 },
    ])
  );
  assert.equal(entry.duration, 35);
});

test('missing or malformed history falls back, while other I/O failures remain actionable', async () => {
  const directory = await temporaryDirectory('varro-e2e-timings-');
  const file = path.join(directory, 'timings.json');
  assert.equal((await readTimings(file)).size, 0);
  for (const contents of [
    'bad json',
    'null',
    '{"version":2}',
    '{"version":1,"durations":[]}',
    '{"version":1,"durations":3}',
    '{"version":1,"durations":{"a":0}}',
    '{"version":1,"durations":{"a":"5"}}',
  ]) {
    await writeFile(file, contents);
    assert.equal((await readTimings(file)).size, 0);
  }
  await writeFile(file, JSON.stringify({ version: 1, durations: { a: 5 } }));
  assert.deepEqual(await readTimings(file), new Map([['a', 5]]));
  await assert.rejects(readTimings(directory));
});

test('merges shard reports into reusable history and rejects overlapping shards', async () => {
  const directory = await temporaryDirectory('varro-e2e-merge-');
  const files = ['first', 'second'].map((name) => path.join(directory, `${name}.json`));
  await writeFile(files[0], JSON.stringify(report('first', [{ status: 'passed', duration: 10 }])));
  await writeFile(files[1], JSON.stringify(report('second', [{ status: 'skipped', duration: 0 }])));
  const output = path.join(directory, 'history/timings.json');
  await mergeTimings(files, output);
  assert.deepEqual(await readTimings(output), new Map([[reportTests(report('first'))[0].key, 10]]));
  await assert.rejects(mergeTimings([files[0], files[0]], output), /multiple E2E shards/);
  await assert.rejects(mergeTimings([files[1], files[1]], output), /multiple E2E shards/);
});

test('preserves unsharded arguments and rejects invalid shard options', async () => {
  assert.deepEqual(await prepareShard(['--list']), ['--list']);
  await assert.rejects(prepareShard(['--shard=1/4', '--shard=2/4']), /only one E2E shard/);
  for (const shard of ['0/4', '5/4', '1/0', 'bad', '1/1.5']) {
    await assert.rejects(prepareShard([`--shard=${shard}`]), /shard/i);
  }
  for (const argument of [
    '--test-list=tests.txt',
    '--test-list-invert=tests.txt',
    '--repeat-each=2',
    '--last-failed',
    '--only-changed',
  ]) {
    await assert.rejects(prepareShard(['--shard=1/4', argument]), /cannot be combined/);
  }
});

test('generated lists round-trip through Playwright and partition every discovered test once', async () => {
  const cli = path.join(root, 'scripts/run-e2e.mjs');
  const directory = await temporaryDirectory('varro-e2e-lists-');
  const env = { ...process.env, VARRO_E2E_PORT: '4184' };
  const module = new URL('../node_modules/@playwright/test/index.mjs', import.meta.url).href;
  const config = path.join(directory, 'playwright.config.mjs');
  await writeFile(
    config,
    `export default { testDir: '.', fullyParallel: true, projects: [{ name: 'chromium' }] };`
  );
  await writeFile(
    path.join(directory, 'example.spec.mjs'),
    `import { test } from ${JSON.stringify(module)};
    test('top level', () => {});
    test.describe('nested', () => {
      test('comparison > value', () => {});
      test('second', () => {});
      test('third', () => {});
      test('fourth', () => {});
    });`
  );
  const collected = [];
  for (let shard = 1; shard <= 4; shard++) {
    const { stdout } = await exec(
      process.execPath,
      [cli, '--config', config, '--list', '--reporter', 'json', '--shard', `${shard}/4`],
      {
        cwd: directory,
        env,
        timeout: 30_000,
      }
    );
    const entries = reportTests(JSON.parse(stdout));
    assert.equal(entries.length, shard === 1 ? 2 : 1);
    collected.push(...entries.map((entry) => entry.key));
  }
  assert.equal(new Set(collected).size, 5);
  // A real run also writes a JSON timing report outside Playwright's output cleanup.
  await exec(process.execPath, [cli, '--config', config, '--shard=1/4'], {
    cwd: directory,
    env,
    timeout: 30_000,
  });
  const results = JSON.parse(
    await readFile(path.join(directory, 'tmp/e2e-sharding/results-1.json'), 'utf8')
  );
  assert.equal(reportTests(results).length, 2);
  assert.equal(results.stats.unexpected, 0);

  const history = path.join(directory, 'tmp/e2e-sharding/history');
  await mkdir(history, { recursive: true });
  const durations = new Map(collected.map((key) => [key, key.includes('top level') ? 10_000 : 5]));
  await writeFile(
    path.join(history, 'timings.json'),
    JSON.stringify({ version: 1, durations: Object.fromEntries(durations) })
  );
  const weighted = [];
  for (let shard = 1; shard <= 4; shard++) {
    const { stdout, stderr } = await exec(
      process.execPath,
      [cli, '--config', config, '--list', '--reporter=json', `--shard=${shard}/4`],
      { cwd: directory, env, timeout: 30_000 }
    );
    const entries = reportTests(JSON.parse(stdout));
    assert.equal(entries.length, shard === 2 ? 2 : 1);
    if (shard === 1) assert.ok(entries[0].key.includes('top level'));
    assert.match(stderr, /ms estimated/);
    weighted.push(...entries.map((entry) => entry.key));
  }
  assert.deepEqual(weighted.toSorted(), collected.toSorted());
  const { stdout: empty } = await exec(
    process.execPath,
    [cli, '--config', config, '--list', '--reporter=json', '--grep=top level', '--shard=4/4'],
    { cwd: directory, env, timeout: 30_000 }
  );
  assert.equal(reportTests(JSON.parse(empty)).length, 0);
  await assert.rejects(
    exec(
      process.execPath,
      [cli, '--config', config, '--list', '--grep=nonexistent', '--shard=1/4'],
      { cwd: directory, env, timeout: 30_000 }
    ),
    /No tests found|No E2E tests discovered/
  );
});
