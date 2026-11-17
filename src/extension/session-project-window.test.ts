// @vitest-environment node
import { link, lstat, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionProjectWindow } from './session-project-window';

describe('session project window handoff', () => {
  let root: string;
  let handoff: SessionProjectWindow;
  const server = 'http://127.0.0.1:12345';
  const reference = () => ({
    id: 'ses_other',
    title: 'Other',
    directory: join(root, 'project'),
    external: true,
  });
  const queue = () => handoff.queue(reference(), server);
  const read = (path: string) => handoff.read(path, [reference().directory]);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'varro-session-lookup-'));
    handoff = new SessionProjectWindow(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns the path of a bounded private request in the storage directory', async () => {
    const path = await queue();
    expect(dirname(path)).toBe(join(root, 'session-lookups'));
    expect(basename(path)).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\.varro-session$/
    );
    const directory = await lstat(dirname(path));
    const file = await lstat(path);
    expect(directory.isDirectory()).toBe(true);
    expect(file.isFile()).toBe(true);
    expect(file.size).toBeLessThanOrEqual(16_384);
    if (process.platform !== 'win32') {
      expect(directory.mode & 0o777).toBe(0o700);
      expect(file.mode & 0o777).toBe(0o600);
    }
    await expect(read(path)).resolves.toMatchObject({
      id: reference().id,
      directory: reference().directory,
      serverUrl: server,
    });
  });

  it('rejects an outside path before opening it, even with a valid marker name', async () => {
    const outside = join(root, basename(await queue()));
    await expect(read(outside)).rejects.toThrow('Invalid session lookup request');
    await writeFile(outside, 'not JSON');
    await expect(read(outside)).rejects.toThrow('Invalid session lookup request');
  });

  it('rejects a request in a different project window', async () => {
    const path = await queue();
    await expect(handoff.read(path, [root])).rejects.toThrow('does not belong');
  });

  it.each([
    ['expired', '0'],
    ['non-finite', '1e999'],
  ] as const)('rejects a valid JSON request with a %s timestamp', async (_, timestamp) => {
    const path = await queue();
    const request = await read(path);
    await writeFile(path, JSON.stringify(request).replace(String(request.createdAt), timestamp));
    await expect(read(path)).rejects.toThrow('expired');
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink to a valid marker', async () => {
    const target = await queue();
    const path = await queue();
    await rm(path);
    await symlink(target, path);
    await expect(read(path)).rejects.toThrow();
  });

  it('rejects a marker with another hard link', async () => {
    const path = await queue();
    await link(path, join(root, 'linked-marker'));
    await expect(read(path)).rejects.toThrow('private regular file');
  });

  it('rejects oversized requests even when the JSON is valid', async () => {
    const path = await queue();
    await writeFile(path, JSON.stringify(await read(path)).padEnd(16_385, ' '));
    await expect(read(path)).rejects.toThrow();
  });

  it('keeps the request for its own server and allows only one consumer', async () => {
    const path = await queue();
    const expected = await read(path);
    await expect(handoff.consume(path, expected, 'other-server')).rejects.toThrow('server');
    const outcomes = await Promise.allSettled([
      handoff.consume(path, expected, server),
      new SessionProjectWindow(root).consume(path, expected, server),
    ]);
    expect(outcomes).toContainEqual({ status: 'fulfilled', value: expected });
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prunes stale markers on queue but leaves fresh markers and unrelated files', async () => {
    const stale = await queue();
    const fresh = await queue();
    const staleClaim = `${stale}.claim`;
    await writeFile(staleClaim, '', { flag: 'wx', mode: 0o600 });
    const unrelated = join(dirname(stale), 'notes.varro-session');
    await writeFile(unrelated, 'keep');
    const expired = new Date(Date.now() - 121_000);
    await utimes(stale, expired, expired);
    await utimes(staleClaim, expired, expired);
    await utimes(unrelated, expired, expired);
    await queue();
    await expect(lstat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(staleClaim)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(read(fresh)).resolves.toMatchObject({ id: reference().id });
    await expect(readFile(unrelated, 'utf8')).resolves.toBe('keep');
  });

  it('rejects invalid session references and unavailable storage', async () => {
    await expect(
      handoff.queue({ ...reference(), directory: 'relative' }, server)
    ).rejects.toThrow();
    await expect(handoff.queue({ ...reference(), id: '' }, server)).rejects.toThrow();
    await expect(handoff.queue(reference(), '')).rejects.toThrow();
    for (const directory of [undefined, 'relative']) {
      await expect(new SessionProjectWindow(directory).queue(reference(), server)).rejects.toThrow(
        'storage is unavailable'
      );
    }
  });
});
