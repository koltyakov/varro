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

function timing(key, file = `${key}.spec.ts`) {
  return { key, file, description: key, duration: 0 };
}

function report(title = 'test', results = [], projectName = 'chromium', file = 'example.spec.ts') {
  return {
    suites: [
      {
        title: file,
        specs: [],
        suites: [
          {
            title: 'group',
            suites: [],
            specs: [
              {
                title,
                file,
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

await test('balances longest spec files first by historical duration', () => {
  const tests = ['a', 'b', 'c', 'd', 'e'].map((key) => timing(key));
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

await test('missing history gives count-balanced shards with no duplicates or omissions', () => {
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

await test('keeps parameterized cases and projects from one file together in every plan', () => {
  const tests = [
    timing('large-first', 'large.spec.ts'),
    timing('large-second', 'large.spec.ts'),
    timing('large-firefox', 'large.spec.ts'),
    timing('medium-first', 'medium.spec.ts'),
    timing('medium-second', 'medium.spec.ts'),
    timing('single', 'single.spec.ts'),
  ];
  for (const history of [new Map(), new Map(tests.map((entry, index) => [entry.key, index + 1]))]) {
    const shards = balanceTests(tests, history, 4);
    assert.deepEqual(balanceTests(tests.toReversed(), history, 4), shards);
    const owners = new Map();
    for (const [index, shard] of shards.entries()) {
      for (const spec of shard.files) {
        assert.ok(!owners.has(spec.file), `${spec.file} belongs to multiple shards`);
        owners.set(spec.file, index);
        assert.ok(spec.tests.every((entry) => entry.file === spec.file));
      }
      assert.deepEqual(
        shard.tests,
        shard.files.flatMap((spec) => spec.tests)
      );
    }
    assert.equal(owners.size, 3);
    assert.deepEqual(
      shards.flatMap((shard) => shard.tests.map((entry) => entry.key)).toSorted(),
      tests.map((entry) => entry.key).toSorted()
    );
  }
});

await test('without history, whole-file weights use test counts rather than equal file weights', () => {
  const tests = [
    ...Array.from({ length: 7 }, (_, index) => timing(`large-${index}`, 'large.spec.ts')),
    ...Array.from({ length: 3 }, (_, index) => timing(`medium-${index}`, 'medium.spec.ts')),
    timing('small', 'small.spec.ts'),
    timing('tiny', 'tiny.spec.ts'),
  ];
  const shards = balanceTests(tests, new Map(), 2);
  assert.deepEqual(
    shards.map((shard) => shard.duration),
    [7, 5]
  );
  assert.deepEqual(
    shards.map((shard) => shard.files.map((spec) => spec.file)),
    [['large.spec.ts'], ['medium.spec.ts', 'small.spec.ts', 'tiny.spec.ts']]
  );
});

await test('new tests use the average duration of current known tests, ignoring removed tests', () => {
  const shards = balanceTests(
    ['a', 'b', 'new'].map((key) => timing(key)),
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

await test('identities include project, relative file and nested titles but not line numbers', () => {
  const source = report('test > comparison', [{ status: 'passed', duration: 5 }]);
  const [entry] = reportTests(source);
  assert.equal(
    entry.key,
    JSON.stringify(['chromium', 'example.spec.ts', 'group', 'test > comparison'])
  );
  assert.equal(entry.description, '[chromium] › example.spec.ts › group › test > comparison');
  assert.equal(entry.file, 'example.spec.ts');
  source.suites[0].suites[0].specs[0].line = 100;
  assert.deepEqual(reportTests(source), [entry]);
  assert.notEqual(reportTests(report('test > comparison', [], 'firefox'))[0].key, entry.key);
  assert.throws(() => reportTests(report('unrepresentable › title')), /cannot be represented/);
});

await test('timings sum retry attempts and exclude skipped or interrupted attempts', () => {
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

await test('missing or malformed history falls back, while other I/O failures remain actionable', async () => {
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

await test('merges shard reports into reusable history and rejects overlapping shards', async () => {
  const directory = await temporaryDirectory('varro-e2e-merge-');
  const files = ['first', 'second'].map((name) => path.join(directory, `${name}.json`));
  const first = report('first', [{ status: 'passed', duration: 10 }], 'chromium', 'first.spec.ts');
  await writeFile(files[0], JSON.stringify(first));
  await writeFile(
    files[1],
    JSON.stringify(
      report('second', [{ status: 'skipped', duration: 0 }], 'chromium', 'second.spec.ts')
    )
  );
  const output = path.join(directory, 'history/timings.json');
  await mergeTimings(files, output);
  assert.deepEqual(await readTimings(output), new Map([[reportTests(first)[0].key, 10]]));
  await assert.rejects(mergeTimings([files[0], files[0]], output), /multiple E2E shards/);
  await assert.rejects(mergeTimings([files[1], files[1]], output), /multiple E2E shards/);
  await writeFile(
    files[1],
    JSON.stringify(report('different case', [], 'firefox', 'first.spec.ts'))
  );
  await assert.rejects(mergeTimings(files, output), /Spec file appeared in multiple E2E shards/);
});

await test('preserves unsharded arguments and rejects invalid shard options', async () => {
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

await test('generated lists round-trip through Playwright with exclusive spec-file ownership', async () => {
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
  for (const [file, titles] of [
    ['paired.spec.mjs', ['variant 0', 'variant 1']],
    ['priority.spec.mjs', ['priority']],
    ['single.spec.mjs', ['single']],
  ]) {
    await writeFile(
      path.join(directory, file),
      `import { test } from ${JSON.stringify(module)};
      for (const title of ${JSON.stringify(titles)}) test(title, () => {});`
    );
  }
  const collected = [];
  const fileOwners = new Set();
  for (let shard = 1; shard <= 4; shard++) {
    const { stdout, stderr } = await exec(
      process.execPath,
      [cli, '--config', config, '--list', '--reporter', 'json', '--shard', `${shard}/4`],
      {
        cwd: directory,
        env,
        timeout: 30_000,
      }
    );
    const entries = reportTests(JSON.parse(stdout));
    assert.equal(entries.length, [5, 2, 1, 1][shard - 1]);
    const files = new Set(entries.map((entry) => entry.file));
    assert.equal(files.size, 1);
    for (const file of files) {
      assert.ok(!fileOwners.has(file), `${file} belongs to multiple shards`);
      fileOwners.add(file);
      assert.ok(stderr.includes(`${file}: ${entries.length} tests`));
    }
    const assignment = JSON.parse(
      await readFile(path.join(directory, `tmp/e2e-sharding/assignment-${shard}.json`), 'utf8')
    );
    assert.equal(assignment.totalFiles, 4);
    assert.equal(assignment.totalTests, 9);
    assert.equal(assignment.estimate, 'test-count');
    assert.deepEqual(
      assignment.files.map((spec) => spec.file),
      [...files]
    );
    collected.push(...entries.map((entry) => entry.key));
  }
  assert.equal(fileOwners.size, 4);
  assert.equal(new Set(collected).size, 9);
  // A real run also writes a JSON timing report outside Playwright's output cleanup.
  await exec(process.execPath, [cli, '--config', config, '--shard=1/4'], {
    cwd: directory,
    env,
    timeout: 30_000,
  });
  const results = JSON.parse(
    await readFile(path.join(directory, 'tmp/e2e-sharding/results-1.json'), 'utf8')
  );
  assert.equal(reportTests(results).length, 5);
  assert.equal(results.stats.unexpected, 0);

  const history = path.join(directory, 'tmp/e2e-sharding/history');
  await mkdir(history, { recursive: true });
  const durations = new Map(
    collected.map((key) => [key, key.includes('priority.spec') ? 10_000 : 5])
  );
  await writeFile(
    path.join(history, 'timings.json'),
    JSON.stringify({ version: 1, durations: Object.fromEntries(durations) })
  );
  const weighted = [];
  const weightedOwners = new Set();
  for (let shard = 1; shard <= 4; shard++) {
    const { stdout, stderr } = await exec(
      process.execPath,
      [cli, '--config', config, '--list', '--reporter=json', `--shard=${shard}/4`],
      { cwd: directory, env, timeout: 30_000 }
    );
    const entries = reportTests(JSON.parse(stdout));
    assert.equal(entries.length, [1, 5, 2, 1][shard - 1]);
    if (shard === 1) assert.ok(entries[0].key.includes('priority.spec'));
    for (const file of new Set(entries.map((entry) => entry.file))) {
      assert.ok(!weightedOwners.has(file), `${file} belongs to multiple weighted shards`);
      weightedOwners.add(file);
    }
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
