import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeV2SessionState } from './opencode-v2-session-state';

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
    const parent = resolve('artifacts/ai-test-data');
    await mkdir(parent, { recursive: true });
    directory = await mkdtemp(join(parent, 'annotation-order-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
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
