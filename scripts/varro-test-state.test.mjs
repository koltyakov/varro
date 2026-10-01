import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { isolateVarroTestState } from './varro-test-state.mjs';

test('isolates current and legacy editor state for independent AI profiles', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varro-state-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = {
    HOME: '/host/home',
    USERPROFILE: '/host/home',
    LOCALAPPDATA: '/host/appdata',
    XDG_STATE_HOME: '/host/state',
    TMPDIR: '/host/tmp',
    TMP: '/host/tmp',
    TEMP: '/host/tmp',
    OPENCODE_DB: '/verified/fixture/opencode.db',
    VARRO_TEST_SERVER_URL: 'http://127.0.0.1:49999',
  };
  const profiles = ['first', 'second'].map((name) => path.join(root, name));
  const environments = await Promise.all(
    profiles.map(async (profile) => {
      const environment = { ...original };
      await isolateVarroTestState(environment, profile);
      return environment;
    })
  );
  for (let index = 0; index < profiles.length; index += 1) {
    const environment = environments[index];
    const profile = profiles[index];
    for (const key of [
      'HOME',
      'USERPROFILE',
      'LOCALAPPDATA',
      'XDG_STATE_HOME',
      'TMPDIR',
      'TMP',
      'TEMP',
    ]) {
      assert.ok(environment[key].startsWith(`${profile}${path.sep}`), key);
      assert.ok((await stat(environment[key])).isDirectory());
    }
    assert.equal(environment.VARRO_TEST_STATE_ROOT, path.join(profile, 'state/varro-test'));
    assert.equal(environment.OPENCODE_DB, original.OPENCODE_DB);
    assert.equal(environment.VARRO_TEST_SERVER_URL, original.VARRO_TEST_SERVER_URL);
    await mkdir(environment.VARRO_TEST_STATE_ROOT, { recursive: true });
    assert.deepEqual(await readdir(environment.VARRO_TEST_STATE_ROOT), []);
  }
  assert.notEqual(environments[0].VARRO_TEST_STATE_ROOT, environments[1].VARRO_TEST_STATE_ROOT);
  assert.equal(original.HOME, '/host/home');
});

test('rejects relative profile roots before changing the environment', async () => {
  const environment = { HOME: '/host/home' };
  await assert.rejects(isolateVarroTestState(environment, 'relative'), /must be absolute/);
  assert.deepEqual(environment, { HOME: '/host/home' });
});

test('older Node hosts resolve home and temporary paths inside the test profile', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varro-legacy-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { ...process.env };
  await isolateVarroTestState(environment, root);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { homedir, tmpdir } from 'node:os';
    console.log(JSON.stringify({ home: homedir(), temporary: tmpdir() }));
  `,
    ],
    { env: environment, timeout: 5_000 }
  );
  assert.deepEqual(JSON.parse(stdout), {
    home: path.join(root, 'home'),
    temporary: path.join(root, 'tmp'),
  });
});
