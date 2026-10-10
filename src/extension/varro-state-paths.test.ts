/* oxlint-disable anti-slop/no-module-mocking -- Keep platform path tests away from the user's home while using real filesystem fixtures. */
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as os from 'os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeV2SessionState } from './opencode-v2-session-state';
import {
  getLegacyVarroStateDirectory,
  getVarroStateDirectory,
  getVarroStateReadDirectory,
  prepareVarroStateDirectory,
  prepareVarroScratchDirectory,
} from './varro-state-paths';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  const homedir = vi.fn(actual.homedir);
  return { ...actual, default: { ...actual, homedir }, homedir };
});

const platform = process.platform;
const kinds = ['servers', 'opencode-v2', 'provider-quota-v2', 'scratch'] as const;
let root: string;

beforeEach(async () => {
  const parent = resolve('artifacts/ai-test-data');
  await mkdir(parent, { recursive: true });
  root = await mkdtemp(join(parent, 'state-paths-'));
  vi.mocked(os.homedir).mockReturnValue(join(root, 'home'));
  vi.stubEnv('VARRO_TEST_STATE_ROOT', undefined);
  vi.stubEnv('VARRO_TEST_SERVER_URL', undefined);
  vi.stubEnv('XDG_STATE_HOME', join(root, 'xdg-state'));
  vi.stubEnv('LOCALAPPDATA', join(root, 'local-appdata'));
  for (const kind of kinds) expect(getVarroStateDirectory(kind).startsWith(root)).toBe(true);
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('Varro state directories', () => {
  it.each(['darwin', 'linux', 'win32'])(
    'uses one native root for all state on %s',
    (osPlatform) => {
      Object.defineProperty(process, 'platform', { value: osPlatform, configurable: true });
      const nativeRoot =
        osPlatform === 'darwin'
          ? join(root, 'home', 'Library', 'Application Support', 'Varro')
          : osPlatform === 'win32'
            ? join(root, 'local-appdata', 'Varro')
            : join(root, 'xdg-state', 'varro');
      for (const kind of kinds) expect(getVarroStateDirectory(kind)).toBe(join(nativeRoot, kind));
    }
  );

  it.each(['', 'relative/state'])('ignores non-absolute environment paths %j', (value) => {
    vi.stubEnv('XDG_STATE_HOME', value);
    vi.stubEnv('LOCALAPPDATA', value);
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(getVarroStateDirectory('servers')).toBe(
      join(root, 'home', '.local', 'state', 'varro', 'servers')
    );
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(getVarroStateDirectory('servers')).toBe(
      join(root, 'home', 'AppData', 'Local', 'Varro', 'servers')
    );
  });

  it.each(['darwin', 'linux', 'win32'])(
    'isolates all state and disables legacy discovery on %s',
    (osPlatform) => {
      Object.defineProperty(process, 'platform', { value: osPlatform, configurable: true });
      vi.stubEnv('VARRO_TEST_STATE_ROOT', join(root, 'profile'));
      for (const kind of kinds)
        expect(getVarroStateDirectory(kind)).toBe(join(root, 'profile', kind));
      expect(getLegacyVarroStateDirectory('opencode-v2')).toBeUndefined();
      expect(getLegacyVarroStateDirectory('provider-quota-v2')).toBeUndefined();
    }
  );

  it('fails closed for every state kind when test isolation is missing or invalid', () => {
    vi.stubEnv('VARRO_TEST_SERVER_URL', 'http://127.0.0.1:49999');
    for (const kind of kinds)
      expect(() => getVarroStateDirectory(kind)).toThrow('isolation is missing');
    vi.stubEnv('VARRO_TEST_STATE_ROOT', 'relative/profile');
    for (const kind of kinds)
      expect(() => getVarroStateDirectory(kind)).toThrow('absolute isolated directory');
    expect(() => getLegacyVarroStateDirectory('opencode-v2')).toThrow(
      'absolute isolated directory'
    );
  });

  it('does not treat Linux annotations already at the native path as legacy', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(getLegacyVarroStateDirectory('opencode-v2')).toBeUndefined();
    expect(getLegacyVarroStateDirectory('provider-quota-v2')).toBe(
      join(root, 'home', '.varro-provider-quota-v2')
    );
  });

  it('creates private native directories on a fresh installation', async () => {
    const directory = join(root, 'native', 'opencode-v2');
    await expect(prepareVarroStateDirectory(directory, join(root, 'absent'))).resolves.toBe(
      directory
    );
    expect((await stat(directory)).isDirectory()).toBe(true);
    if (platform !== 'win32') expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it('creates and reuses an isolated private scratch folder without discarding files', async () => {
    vi.stubEnv('VARRO_TEST_STATE_ROOT', join(root, 'profile'));
    const directory = getVarroStateDirectory('scratch');
    await prepareVarroScratchDirectory();
    await writeFile(join(directory, 'notes.txt'), 'keep me');
    await prepareVarroScratchDirectory();
    expect(await readFile(join(directory, 'notes.txt'), 'utf8')).toBe('keep me');
    if (platform !== 'win32') expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it('refuses a scratch folder redirected to another directory', async () => {
    vi.stubEnv('VARRO_TEST_STATE_ROOT', root);
    const unrelated = join(root, 'unrelated');
    await mkdir(unrelated);
    await symlink(
      unrelated,
      getVarroStateDirectory('scratch'),
      platform === 'win32' ? 'junction' : 'dir'
    );
    await expect(prepareVarroScratchDirectory()).rejects.toThrow(
      'Expected a real Varro scratch directory'
    );
  });

  it('reads legacy annotations without creating directories or compatibility links', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const directory = getVarroStateDirectory('opencode-v2');
    expect(getVarroStateReadDirectory('opencode-v2')).toBe(directory);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    const legacy = getLegacyVarroStateDirectory('opencode-v2')!;
    await mkdir(legacy, { recursive: true });
    expect(getVarroStateReadDirectory('opencode-v2')).toBe(legacy);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(directory, { recursive: true });
    expect(() => getVarroStateReadDirectory('opencode-v2')).toThrow(
      'Conflicting Varro state directories'
    );
  });

  it('keeps concurrent preparations and legacy atomic writers on the same directory', async () => {
    const legacy = join(root, 'legacy');
    const directory = join(root, 'native', 'opencode-v2');
    await mkdir(legacy, { mode: 0o700 });
    await writeFile(join(legacy, 'ses_fixture.json'), '{"old":true}');
    await Promise.all(
      Array.from({ length: 8 }, () => prepareVarroStateDirectory(directory, legacy))
    );
    expect(await realpath(directory)).toBe(await realpath(legacy));
    await writeFile(join(legacy, 'replacement.tmp'), '{"updated":true}');
    await rename(join(legacy, 'replacement.tmp'), join(legacy, 'ses_fixture.json'));
    expect(await readFile(join(directory, 'ses_fixture.json'), 'utf8')).toBe('{"updated":true}');
  });

  it('preserves metadata and generation timing across native and legacy annotation writers', async () => {
    // Keep distinct native/legacy paths, but use junctions on the real Windows filesystem.
    Object.defineProperty(process, 'platform', {
      value: platform === 'win32' ? 'win32' : 'darwin',
      configurable: true,
    });
    const legacy = getLegacyVarroStateDirectory('opencode-v2')!;
    const oldStore = new OpenCodeV2SessionState(legacy);
    const timing = { 'msg_one:text:0': { start: 100, end: 200, textHash: 'a'.repeat(64) } };
    await oldStore.update('ses_fixture', { metadata: { label: 'kept' }, generationTiming: timing });
    const nativeStore = new OpenCodeV2SessionState();
    expect(await nativeStore.read('ses_fixture')).toEqual({
      metadata: { label: 'kept' },
      generationTiming: timing,
      time: {},
    });
    await Promise.all([
      oldStore.update('ses_fixture', { oldEditor: true }),
      nativeStore.update('ses_fixture', { newEditor: true }),
    ]);
    expect(await oldStore.read('ses_fixture')).toEqual(await nativeStore.read('ses_fixture'));
    expect(await nativeStore.read('ses_fixture')).toMatchObject({
      oldEditor: true,
      newEditor: true,
      generationTiming: timing,
    });
    await nativeStore.remove('ses_fixture');
    expect(await oldStore.read('ses_fixture')).toEqual({});
  });

  it('does not merge, overwrite, or delete conflicting native and legacy directories', async () => {
    const legacy = join(root, 'legacy');
    const directory = join(root, 'native');
    await mkdir(legacy);
    await mkdir(directory);
    await writeFile(join(legacy, 'ses_fixture.json'), '{"old":true}');
    await writeFile(join(directory, 'ses_fixture.json'), '{"new":true}');
    await expect(prepareVarroStateDirectory(directory, legacy)).rejects.toThrow(
      'Conflicting Varro state directories'
    );
    expect(await readFile(join(legacy, 'ses_fixture.json'), 'utf8')).toBe('{"old":true}');
    expect(await readFile(join(directory, 'ses_fixture.json'), 'utf8')).toBe('{"new":true}');
  });

  it('preserves a live legacy lock while exposing the native annotation path', async () => {
    // Keep distinct native/legacy paths, but use junctions on the real Windows filesystem.
    Object.defineProperty(process, 'platform', {
      value: platform === 'win32' ? 'win32' : 'darwin',
      configurable: true,
    });
    const legacy = getLegacyVarroStateDirectory('opencode-v2')!;
    const oldStore = new OpenCodeV2SessionState(legacy);
    await oldStore.update('ses_fixture', { existing: true });
    let entered!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolveAcquired) => {
      entered = resolveAcquired;
    });
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const read = oldStore.read.bind(oldStore);
    vi.spyOn(oldStore, 'read').mockImplementationOnce(async (id) => {
      entered();
      await gate;
      return read(id);
    });
    const pending = oldStore.update('ses_fixture', { oldEditor: true });
    try {
      await acquired;
      const nativeStore = new OpenCodeV2SessionState();
      await nativeStore.read('ses_fixture');
      const legacyLock = join(legacy, 'ses_fixture.json.lock');
      const nativeLock = join(nativeStore.directory, 'ses_fixture.json.lock');
      expect(await realpath(nativeLock)).toBe(await realpath(legacyLock));
      const controller = new AbortController();
      const cancelled = nativeStore.update('ses_fixture', { cancelled: true }, controller.signal);
      controller.abort(new Error('Cancelled contender'));
      await expect(cancelled).rejects.toThrow('Cancelled contender');
      expect((await stat(legacyLock)).isDirectory()).toBe(true);
    } finally {
      release();
      await pending;
    }
    expect(await oldStore.read('ses_fixture')).toEqual({
      existing: true,
      oldEditor: true,
      time: {},
    });
  });

  it('accepts the reverse compatibility link after an offline physical relocation', async () => {
    const directory = join(root, 'native');
    const legacy = join(root, 'legacy');
    await mkdir(directory);
    await symlink(directory, legacy, platform === 'win32' ? 'junction' : 'dir');
    await expect(prepareVarroStateDirectory(directory, legacy)).resolves.toBe(
      await realpath(directory)
    );
  });

  it('does not redirect a new native root through an unexpected legacy symlink', async () => {
    const directory = join(root, 'native');
    const legacy = join(root, 'legacy');
    const unrelated = join(root, 'unrelated');
    await mkdir(unrelated);
    await symlink(unrelated, legacy, platform === 'win32' ? 'junction' : 'dir');
    await expect(prepareVarroStateDirectory(directory, legacy)).rejects.toThrow(
      'Expected a real Varro state directory'
    );
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
