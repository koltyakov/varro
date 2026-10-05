/* oxlint-disable anti-slop/no-module-mocking -- Simulate platform-specific rename errors while retaining real installation files. */
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacOSNotificationHelper } from './macos-notification-helper';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const directories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'varro-notifier-test-'));
  directories.push(directory);
  const archive = Buffer.from('fixture archive');
  const checksum = createHash('sha256').update(archive).digest('hex');
  await writeFile(join(directory, 'macos-notifier.zip'), archive);
  await writeFile(join(directory, 'macos-notifier.json'), JSON.stringify({ sha256: checksum }));
  const run = vi.fn<ConstructorParameters<typeof MacOSNotificationHelper>[2]>(
    async (file, args) => {
      if (file !== '/usr/bin/ditto') return;
      const staging = args.at(-1);
      if (!staging) throw new Error('Missing staging directory');
      const executable = join(staging, 'Varro.app/Contents/MacOS/varro-notifier');
      await mkdir(dirname(executable), { recursive: true });
      await writeFile(executable, 'fixture executable');
    }
  );
  const helper = () => new MacOSNotificationHelper(directory, directory, run);
  return { directory, checksum, run, helper };
}

describe('MacOSNotificationHelper', () => {
  afterEach(async () => {
    vi.mocked(rename).mockReset();
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it('reads window geometry through the installed helper and rejects an empty response', async () => {
    const test = await fixture();
    const helper = test.helper();
    const executable = await helper.executable();
    test.run.mockClear();
    test.run.mockResolvedValueOnce(
      JSON.stringify({
        screens: [{ x: 0, y: 0, width: 1000, height: 800 }],
        windows: [{ x: 100, y: 100, width: 400, height: 300, editor: true, opaque: true }],
      })
    );
    expect(await helper.isEditorVisible(1234)).toBe(true);
    expect(test.run).toHaveBeenCalledExactlyOnceWith(executable, ['--windows', '1234']);
    await expect(helper.isEditorVisible(1234)).rejects.toThrow('no editor visibility state');
  });

  it('installs once for concurrent requests and reuses the app across instances', async () => {
    const test = await fixture();
    const helper = test.helper();
    const [first, second] = await Promise.all([helper.executable(), helper.executable()]);
    expect(first).toBe(second);
    await access(first);
    expect(await test.helper().executable()).toBe(first);
    expect(test.run.mock.calls.filter(([file]) => file === '/usr/bin/ditto')).toHaveLength(1);
    expect(test.run.mock.calls.at(-1)?.[1]).toEqual([
      '-f',
      join(test.directory, 'notifications', test.checksum, 'Varro.app'),
    ]);
  });

  it('handles two editor windows installing the same archive concurrently', async () => {
    const test = await fixture();
    const paths = await Promise.all([test.helper().executable(), test.helper().executable()]);
    expect(paths[0]).toBe(paths[1]);
    await access(paths[0]);
  });

  it.each(['EEXIST', 'ENOTEMPTY', 'EPERM'])(
    'reuses the installed app after a %s rename collision',
    async (code) => {
      const test = await fixture();
      vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
        await cp(String(source), String(destination), { recursive: true });
        throw Object.assign(new Error('Destination already installed'), { code });
      });

      const executable = await test.helper().executable();

      await access(executable);
      expect(await readdir(join(test.directory, 'notifications'))).toEqual([test.checksum]);
      expect(test.run).toHaveBeenCalledWith('/usr/bin/codesign', [
        '--verify',
        '--deep',
        '--strict',
        join(test.directory, 'notifications', test.checksum, 'Varro.app'),
      ]);
    }
  );

  it('preserves a rename permission failure when no app was installed and allows retry', async () => {
    const test = await fixture();
    const error = Object.assign(new Error('Rename permission denied'), { code: 'EPERM' });
    vi.mocked(rename).mockRejectedValueOnce(error);
    const helper = test.helper();

    await expect(helper.executable()).rejects.toBe(error);
    expect(await readdir(join(test.directory, 'notifications'))).toEqual([]);
    await access(await helper.executable());
  });

  it('rejects a changed archive before running any commands', async () => {
    const test = await fixture();
    await writeFile(join(test.directory, 'macos-notifier.zip'), 'changed');
    await expect(test.helper().executable()).rejects.toThrow('checksum mismatch');
    expect(test.run).not.toHaveBeenCalled();
  });

  it('retries after an extraction failure without publishing a partial app', async () => {
    const test = await fixture();
    test.run.mockRejectedValueOnce(new Error('extraction failed'));
    const helper = test.helper();
    await expect(helper.executable()).rejects.toThrow('extraction failed');
    await expect(access(join(test.directory, 'notifications', test.checksum))).rejects.toThrow();
    await access(await helper.executable());
  });
});
