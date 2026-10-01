/* oxlint-disable anti-slop/no-module-mocking -- Translate native filesystem contention errors to their Windows equivalents while retaining real locking operations. */
import { mkdir, mkdtemp, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeV2SessionState } from './opencode-v2-session-state';
import { asRecord } from '../shared/type-utils';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const renameMock = vi.fn(actual.rename);
  const rmdirMock = vi.fn(actual.rmdir);
  const filesystem = { ...actual, rename: renameMock, rmdir: rmdirMock };
  return { ...filesystem, default: filesystem };
});

async function simulateWindowsContention(): Promise<void> {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  vi.mocked(rename).mockImplementation(async (source, destination) => {
    try {
      await actual.rename(source, destination);
    } catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes(String(asRecord(error)?.code)))
        throw Object.assign(new Error('Windows directory rename contention'), { code: 'EPERM' });
      throw error;
    }
  });
  vi.mocked(rmdir).mockImplementation(async (path) => {
    try {
      await actual.rmdir(path);
    } catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes(String(asRecord(error)?.code)))
        throw Object.assign(new Error('Windows nonempty directory removal'), { code: 'EPERM' });
      throw error;
    }
  });
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, resolve: release };
}

describe('OpenCodeV2SessionState', () => {
  let directory: string;

  beforeEach(async () => {
    vi.mocked(rename).mockReset();
    vi.mocked(rmdir).mockReset();
    const parent = resolve('artifacts/ai-test-data');
    await mkdir(parent, { recursive: true });
    directory = await mkdtemp(join(parent, 'annotation-order-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('does not contend with a normal editor lock when an AI fixture uses the same session ID', async () => {
    vi.stubEnv('VARRO_TEST_STATE_ROOT', undefined);
    vi.stubEnv('VARRO_TEST_SERVER_URL', undefined);
    vi.stubEnv('XDG_STATE_HOME', join(directory, 'normal-editor'));
    const normal = new OpenCodeV2SessionState();
    const entered = deferred();
    const resume = deferred();
    const read = normal.read.bind(normal);
    vi.spyOn(normal, 'read').mockImplementationOnce(async (id) => {
      entered.resolve();
      await resume.promise;
      return read(id);
    });
    const pending = normal.update('ses_shared', { normalEditor: true });
    try {
      await entered.promise;
      vi.stubEnv('VARRO_TEST_SERVER_URL', 'http://127.0.0.1:49999');
      vi.stubEnv('VARRO_TEST_STATE_ROOT', join(directory, 'ai-profile'));
      const fixture = new OpenCodeV2SessionState();
      await fixture.update('ses_shared', { aiFixture: true });
      expect(await fixture.read('ses_shared')).toEqual({ aiFixture: true, time: {} });
      expect(existsSync(join(normal.directory, 'ses_shared.json.lock'))).toBe(true);
      expect(fixture.directory).not.toBe(normal.directory);
    } finally {
      resume.resolve();
      await pending;
    }
    expect(await normal.read('ses_shared')).toEqual({ normalEditor: true, time: {} });
  });

  it('serializes independent editor processes using the shared version-independent lock format', async () => {
    const module = join(directory, 'session-store.mjs');
    // Compile outside jsdom: esbuild requires the native Node Uint8Array realm.
    const compilation = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { build } from 'esbuild';
      await build({ entryPoints: [process.argv[1]], outfile: process.argv[2],
        bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    `,
        resolve('src/extension/opencode-v2-session-state.ts'),
        module,
      ],
      {
        encoding: 'utf8',
        timeout: 10_000,
      }
    );
    expect(compilation.status, compilation.stderr).toBe(0);
    const editors = ['VSCode', 'VSCode-Nightly', 'VSCodium', 'Varro-OpenJet'];
    const children = editors.map((editor) => {
      const script = `
        const { pathToFileURL } = await import('node:url');
        const { OpenCodeV2SessionState } = await import(pathToFileURL(process.argv[1]).href);
        const store = new OpenCodeV2SessionState(process.argv[2]);
        for (let index = 0; index < 10; index++)
          await store.update('ses_shared', { [process.argv[3] + index]: index });
      `;
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', script, module, directory, editor],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
        }
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exited = new Promise<void>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code === 0) resolveExit();
          else reject(new Error(`${editor} fixture exited with ${String(code)}: ${stderr}`));
        });
      });
      return { child, exited };
    });
    try {
      await Promise.all(children.map(({ exited }) => exited));
      const expected = Object.fromEntries(
        editors.flatMap((editor) =>
          Array.from({ length: 10 }, (_, index) => [`${editor}${index}`, index])
        )
      );
      expect(await new OpenCodeV2SessionState(directory).read('ses_shared')).toEqual({
        ...expected,
        time: {},
      });
      expect(existsSync(join(directory, 'ses_shared.json.lock'))).toBe(false);
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      await Promise.allSettled(children.map(({ exited }) => exited));
    }
  });

  it('finishes a queued deletion before reading state for a later update', async () => {
    const store = new OpenCodeV2SessionState(directory);
    await store.update('ses_fixture', { time: { archived: 100 } });
    const entered = deferred();
    const resume = deferred();
    const read = store.read.bind(store);
    let existedBeforeRead = true;
    vi.spyOn(store, 'read')
      .mockImplementationOnce(async (id) => {
        entered.resolve();
        await resume.promise;
        return read(id);
      })
      .mockImplementationOnce(async (id) => {
        existedBeforeRead = existsSync(join(directory, `${id}.json`));
        return read(id);
      });

    const first = store.update('ses_fixture', { metadata: { old: true } });
    await entered.promise;
    const removal = store.remove('ses_fixture');
    const last = store.update('ses_fixture', { metadata: { current: true } });
    resume.resolve();
    await Promise.all([first, removal, last]);

    expect(existedBeforeRead).toBe(false);
    expect(await store.read('ses_fixture')).toEqual({ metadata: { current: true }, time: {} });
  });

  it('can delete corrupt annotations after a queued update fails to read them', async () => {
    await writeFile(join(directory, 'ses_fixture.json'), '{invalid json');
    const store = new OpenCodeV2SessionState(directory);
    const update = store.update('ses_fixture', { time: { archived: 100 } });
    const removal = store.remove('ses_fixture');
    const results = await Promise.allSettled([update, removal]);

    expect(results[0]).toMatchObject({ status: 'rejected', reason: expect.any(Error) });
    expect(results[1]).toEqual({ status: 'fulfilled', value: undefined });
    expect(await store.read('ses_fixture')).toEqual({});
  });

  it.each(['native', 'Windows'])(
    'preserves concurrent updates with %s contention errors',
    async (platform) => {
      if (platform === 'Windows') await simulateWindowsContention();
      const stores = [new OpenCodeV2SessionState(directory), new OpenCodeV2SessionState(directory)];
      const patches = Array.from({ length: 20 }, (_, index) => ({ [`field${index}`]: index }));
      const results = await Promise.allSettled(
        patches.map((patch, index) => stores[index % 2]!.update('ses_fixture', patch))
      );
      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
      expect(await stores[0]!.read('ses_fixture')).toEqual(Object.assign({ time: {} }, ...patches));
      expect(existsSync(join(directory, 'ses_fixture.json.lock'))).toBe(false);
    }
  );

  it.each(['native', 'Windows'])(
    'recovers an abandoned lock with %s contention errors',
    async (platform) => {
      if (platform === 'Windows') await simulateWindowsContention();
      const lock = join(directory, 'ses_fixture.json.lock');
      await mkdir(lock);
      await writeFile(join(lock, '2147483647-00000000-0000-0000-0000-000000000000'), '');
      const store = new OpenCodeV2SessionState(directory);
      await store.update('ses_fixture', { time: { archived: 100 } });
      expect(await store.read('ses_fixture')).toEqual({ time: { archived: 100 } });
      expect(existsSync(lock)).toBe(false);
    }
  );

  it('does not remove a replacement owner when Windows refuses to remove its directory', async () => {
    const lock = join(directory, 'ses_fixture.json.lock');
    const owner = `${process.pid}-00000000-0000-0000-0000-000000000000`;
    vi.mocked(rmdir).mockImplementationOnce(async (path) => {
      expect(path).toBe(lock);
      await writeFile(join(lock, owner), '');
      throw Object.assign(new Error('Windows nonempty directory removal'), { code: 'EPERM' });
    });

    const store = new OpenCodeV2SessionState(directory);
    await store.update('ses_fixture', { preserved: true });

    expect(existsSync(join(lock, owner))).toBe(true);
    expect(await store.read('ses_fixture')).toEqual({ preserved: true, time: {} });
  });

  it('reports an actual permission failure when removing an empty lock', async () => {
    const error = Object.assign(new Error('Access denied'), { code: 'EPERM' });
    vi.mocked(rmdir).mockRejectedValueOnce(error);
    const store = new OpenCodeV2SessionState(directory);

    await expect(store.update('ses_fixture', { preserved: true })).rejects.toBe(error);
  });

  it('bounds rename retries when the lock disappears and preserves the permission error', async () => {
    const error = Object.assign(new Error('Access denied'), { code: 'EPERM' });
    vi.mocked(rename).mockRejectedValue(error);
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(10_000);
    const store = new OpenCodeV2SessionState(directory);

    await expect(store.update('ses_fixture', { preserved: true })).rejects.toMatchObject({
      message: 'Timed out waiting to update Varro session annotations',
      cause: error,
    });
  });

  it('cancels a contender while another store holds the lock', async () => {
    const first = new OpenCodeV2SessionState(directory);
    const second = new OpenCodeV2SessionState(directory);
    const entered = deferred();
    const resume = deferred();
    const read = first.read.bind(first);
    vi.spyOn(first, 'read').mockImplementationOnce(async (id) => {
      entered.resolve();
      await resume.promise;
      return read(id);
    });
    const update = first.update('ses_fixture', { metadata: { original: true } });
    await entered.promise;
    const controller = new AbortController();
    const cancelled = second.update('ses_fixture', { time: { archived: 100 } }, controller.signal);
    const rejection = expect(cancelled).rejects.toThrow();
    controller.abort(new Error('Cancelled contender'));
    await rejection;
    expect(existsSync(join(directory, 'ses_fixture.json.lock'))).toBe(true);
    resume.resolve();
    await update;
    expect(await second.read('ses_fixture')).toEqual({ metadata: { original: true }, time: {} });
  });

  it('does not persist an update cancelled while waiting for an earlier write', async () => {
    const store = new OpenCodeV2SessionState(directory);
    const entered = deferred();
    const resume = deferred();
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementationOnce(async (id) => {
      entered.resolve();
      await resume.promise;
      return read(id);
    });
    const first = store.update('ses_fixture', { metadata: { label: 'original' } });
    await entered.promise;
    const controller = new AbortController();
    const cancelled = store.update(
      'ses_fixture',
      { metadata: { label: 'cancelled' } },
      controller.signal
    );
    controller.abort(new Error('Cancelled fixture update'));
    resume.resolve();
    const results = await Promise.allSettled([first, cancelled]);

    expect(results[0]).toEqual({ status: 'fulfilled', value: undefined });
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'Cancelled fixture update' }),
    });
    expect(await store.read('ses_fixture')).toEqual({ metadata: { label: 'original' }, time: {} });
  });
});
