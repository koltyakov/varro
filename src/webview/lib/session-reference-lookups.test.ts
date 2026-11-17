import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionLookup } from '../../shared/protocol';
import { client } from './client';
import { lookupSessionReference, lookupSessionReferences } from './session-reference-lookups';
import { resetDefaultAppState, setState, state } from './state';

function reference(id: string): SessionLookup {
  return { id, title: `Title ${id}`, directory: '/other', external: true };
}

let testScope = 0;

beforeEach(() => {
  resetDefaultAppState();
  setState('serverStatus', { state: 'running', url: `http://localhost/${++testScope}` });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetDefaultAppState();
});

describe('session reference lookups', () => {
  it('coalesces repeated IDs and caches metadata separately from the session list', async () => {
    const fetch = vi
      .spyOn(client.varro.session, 'reference')
      .mockImplementation(async (id) => reference(id));
    lookupSessionReferences('See ses_other and session:ses_other');
    await expect(lookupSessionReference('ses_other')).resolves.toEqual(reference('ses_other'));
    await lookupSessionReference('ses_other');
    expect(fetch).toHaveBeenCalledExactlyOnceWith('ses_other');
    expect(state.sessionLookups.ses_other).toEqual(reference('ses_other'));
    expect(state.sessions).toEqual([]);
  });

  it('caches misses and leaves unknown IDs as ordinary text', async () => {
    const fetch = vi.spyOn(client.varro.session, 'reference').mockRejectedValue(new Error('404'));
    await expect(lookupSessionReference('ses_missing')).resolves.toBeNull();
    await expect(lookupSessionReference('ses_missing')).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.sessionLookups).toEqual({});
  });

  it('limits concurrent requests and drains queued IDs', async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    vi.spyOn(client.varro.session, 'reference').mockImplementation(async (id) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return reference(id);
    });
    const requests = Array.from({ length: 12 }, (_, i) => lookupSessionReference(`ses_${i}`));
    for (let round = 0; round < 3; round++) {
      await vi.waitFor(() => expect(releases).toHaveLength(4));
      releases.splice(0).forEach((release) => release());
    }
    await Promise.all(requests);
    expect(maximum).toBe(4);
    expect(Object.keys(state.sessionLookups)).toHaveLength(12);
  });

  it('does not publish metadata from a replaced server generation', async () => {
    let release!: (value: SessionLookup) => void;
    vi.spyOn(client.varro.session, 'reference')
      .mockImplementationOnce(
        () =>
          new Promise<SessionLookup>((resolve) => {
            release = resolve;
          })
      )
      .mockResolvedValue(reference('ses_new'));
    const old = lookupSessionReference('ses_old');
    await Promise.resolve();
    setState('serverStatus', { state: 'running', url: 'http://localhost/replaced' });
    await lookupSessionReference('ses_new');
    release(reference('ses_old'));
    await expect(old).resolves.toBeNull();
    expect(state.sessionLookups.ses_old).toBeUndefined();
    expect(state.sessionLookups.ses_new).toEqual(reference('ses_new'));
  });

  it('bounds the metadata cache', async () => {
    vi.spyOn(client.varro.session, 'reference').mockImplementation(async (id) => reference(id));
    for (let i = 0; i < 260; i++) await lookupSessionReference(`ses_${i}`);
    expect(Object.keys(state.sessionLookups)).toHaveLength(256);
    expect(state.sessionLookups.ses_0).toBeUndefined();
    await lookupSessionReference('ses_0');
    expect(state.sessionLookups.ses_0).toEqual(reference('ses_0'));
  });
});
