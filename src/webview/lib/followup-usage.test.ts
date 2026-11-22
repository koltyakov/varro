import { flush as flushSolid } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SessionFollowupUsage,
  SessionFollowupUsageInterval,
  SessionUsageTotals,
} from '../../shared/protocol';
import { client } from './client';
import { followupUsage, resolveFollowupUsage, type FollowupUsageEntry } from './followup-usage';

function totals(overrides: Partial<SessionUsageTotals> = {}): SessionUsageTotals {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    steps: 1,
    missing: 0,
    active: 0,
    ...overrides,
  };
}

function interval(
  promptIDs: string[],
  overrides: Partial<SessionFollowupUsageInterval> = {}
): SessionFollowupUsageInterval {
  return { promptIDs, usage: totals(), final: true, ...overrides };
}

function usage(overrides: Partial<SessionFollowupUsage> = {}): SessionFollowupUsage {
  return { supported: true, complete: true, intervals: [], pendingPromptIDs: [], ...overrides };
}

function ready(data: SessionFollowupUsage | null, status: FollowupUsageEntry['status'] = 'ready') {
  return { status, revision: 'r', data, checked: new Set<string>() } satisfies FollowupUsageEntry;
}

async function settle() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
  flushSolid();
}

describe('resolveFollowupUsage', () => {
  it('never falls back to session totals for an undelivered or unread prompt', () => {
    expect(resolveFollowupUsage(undefined, 'p')).toEqual({ kind: 'loading' });
    expect(resolveFollowupUsage(ready(null, 'error'), 'p')).toMatchObject({ kind: 'unavailable' });
    expect(resolveFollowupUsage(ready(usage({ pendingPromptIDs: ['p'] })), 'p')).toEqual({
      kind: 'pending',
    });
    expect(resolveFollowupUsage(ready(usage({ complete: false })), 'p')).toEqual({
      kind: 'unavailable',
      reason: 'This prompt is older than the subagent history that was read.',
    });
    expect(resolveFollowupUsage(ready(usage()), 'p')).toEqual({
      kind: 'unavailable',
      reason: 'This prompt was not found in the subagent history.',
    });
    expect(resolveFollowupUsage(ready(usage({ supported: false })), 'p')).toMatchObject({
      kind: 'unavailable',
    });
  });

  it('labels shared, partial, and running intervals', () => {
    const shared = resolveFollowupUsage(
      ready(usage({ intervals: [interval(['a', 'p'], { boundaryUnknown: true })] })),
      'p'
    );
    expect(shared).toMatchObject({ kind: 'interval', shared: true, partial: true });

    const missing = resolveFollowupUsage(
      ready(usage({ intervals: [interval(['p'], { usage: totals({ missing: 2 }) })] })),
      'p'
    );
    expect(missing).toMatchObject({
      shared: false,
      partial: true,
      reasons: ['2 model steps have no recorded usage.'],
    });

    const running = resolveFollowupUsage(
      ready(
        usage({ intervals: [interval(['p'], { final: false, usage: totals({ active: 1 }) })] })
      ),
      'p'
    );
    expect(running).toMatchObject({ running: true, partial: false });

    const abandoned = resolveFollowupUsage(
      ready(usage({ intervals: [interval(['p'], { usage: totals({ active: 1 }) })] })),
      'p'
    );
    expect(abandoned).toMatchObject({ running: false, partial: true });
  });
});

describe('resolveFollowupUsage with stale reads', () => {
  const open = usage({
    intervals: [interval(['p'], { final: false, usage: totals({ input: 5, active: 1 }) })],
  });

  it('does not present an open interval from an earlier read as current', () => {
    expect(resolveFollowupUsage(ready(open, 'error'), 'p')).toEqual({
      kind: 'unavailable',
      reason: 'The latest usage refresh failed, and the earlier read may be out of date.',
    });
    expect(resolveFollowupUsage(ready(open, 'loading'), 'p')).toMatchObject({
      kind: 'interval',
      partial: true,
      reasons: ['Refreshing usage; these values come from an earlier read.'],
    });
  });

  it('reports any earlier interval or pending prompt unavailable after a failed refresh', () => {
    const closed = usage({ intervals: [interval(['p'], { usage: totals({ input: 5 }) })] });

    expect(resolveFollowupUsage(ready(closed, 'error'), 'p')).toMatchObject({
      kind: 'unavailable',
    });
    expect(resolveFollowupUsage(ready(usage({ pendingPromptIDs: ['p'] }), 'error'), 'p')).toEqual({
      kind: 'unavailable',
      reason: 'The latest usage refresh failed, and the earlier read may be out of date.',
    });
  });

  it('keeps only settled closed intervals exact while refreshing', () => {
    const closed = usage({ intervals: [interval(['p'], { usage: totals({ input: 5 }) })] });

    expect(resolveFollowupUsage(ready(closed, 'loading'), 'p')).toMatchObject({
      kind: 'interval',
      partial: false,
      recorded: true,
    });
    // A prompt pending in an earlier read may have been delivered since.
    expect(resolveFollowupUsage(ready(usage({ pendingPromptIDs: ['p'] }), 'loading'), 'p')).toEqual(
      { kind: 'loading' }
    );
  });

  it('marks intervals without a recorded step as unrecorded rather than zero', () => {
    const view = resolveFollowupUsage(
      ready(usage({ intervals: [interval(['p'], { usage: totals({ steps: 0, active: 1 }) })] })),
      'p'
    );

    expect(view).toMatchObject({ kind: 'interval', recorded: false });
  });
});

describe('followupUsage cache', () => {
  beforeEach(() => followupUsage.resetForTests());
  afterEach(() => {
    followupUsage.resetForTests();
    vi.restoreAllMocks();
  });

  it('shares one request across subscribers and does not retry a settled failure', async () => {
    const read = vi.spyOn(client.varro.session, 'followupUsage').mockRejectedValue(new Error('x'));
    const stopA = followupUsage.subscribe('k', 'child');
    const stopB = followupUsage.subscribe('k', 'child');
    followupUsage.request({ key: 'k', sessionID: 'child', revision: '1', promptID: 'a' });
    followupUsage.request({ key: 'k', sessionID: 'child', revision: '1', promptID: 'a' });
    await settle();
    followupUsage.request({ key: 'k', sessionID: 'child', revision: '1', promptID: 'a' });
    await settle();

    expect(read).toHaveBeenCalledTimes(1);
    expect(followupUsage.cache()['k']?.status).toBe('error');
    stopA();
    stopB();
  });

  it('checks a missing prompt once per revision so cards cannot loop requests', async () => {
    const read = vi
      .spyOn(client.varro.session, 'followupUsage')
      .mockResolvedValue(usage({ intervals: [interval(['a'])] }));
    const stop = followupUsage.subscribe('k', 'child');
    followupUsage.request({ key: 'k', sessionID: 'child', revision: '1', promptID: 'a' });
    await settle();
    followupUsage.request({ key: 'k', sessionID: 'child', revision: '1', promptID: 'b' });
    await settle();
    followupUsage.request({ key: 'k', sessionID: 'child', revision: '1', promptID: 'a' });
    followupUsage.request({ key: 'k', sessionID: 'child', revision: '1', promptID: 'b' });
    await settle();

    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });

  it('runs a newer revision after the in-flight read without letting the old one win', async () => {
    const resolvers: Array<(value: SessionFollowupUsage) => void> = [];
    const read = vi.spyOn(client.varro.session, 'followupUsage').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );
    const stop = followupUsage.subscribe('k', 'child');
    followupUsage.request({ key: 'k', sessionID: 'child', revision: '1', promptID: 'a' });
    followupUsage.request({ key: 'k', sessionID: 'child', revision: '2', promptID: 'a' });
    expect(read).toHaveBeenCalledTimes(1);

    resolvers[0]!(usage({ intervals: [interval(['a'], { usage: totals({ input: 1 }) })] }));
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(followupUsage.cache()['k']).toMatchObject({ status: 'loading', revision: '2' });

    resolvers[1]!(usage({ intervals: [interval(['a'], { usage: totals({ input: 2 }) })] }));
    await settle();
    expect(followupUsage.cache()['k']).toMatchObject({ status: 'ready', revision: '2' });
    expect(followupUsage.cache()['k']?.data?.intervals[0]?.usage.input).toBe(2);
    stop();
  });

  it('drops queued work once the last subscriber unmounts', async () => {
    const read = vi.spyOn(client.varro.session, 'followupUsage').mockResolvedValue(usage());
    const stop = followupUsage.subscribe('k', 'child');
    stop();
    followupUsage.request({ key: 'k', sessionID: 'child', revision: '1', promptID: 'a' });
    await settle();

    expect(read).not.toHaveBeenCalled();
  });

  it('aborts an in-flight read on the last unmount and frees its slot', async () => {
    const signals: AbortSignal[] = [];
    const read = vi
      .spyOn(client.varro.session, 'followupUsage')
      .mockImplementation((_sessionID, options) => {
        signals.push(options!.signal!);
        return new Promise(() => {});
      });
    const stops = ['a', 'b', 'c', 'd', 'e'].map((key) => followupUsage.subscribe(key, key));
    for (const key of ['a', 'b', 'c', 'd', 'e'])
      followupUsage.request({ key, sessionID: key, revision: '1', promptID: 'p' });
    expect(read).toHaveBeenCalledTimes(4);

    stops[0]!();

    expect(signals[0]?.aborted).toBe(true);
    expect(read).toHaveBeenCalledTimes(5);
    expect(read.mock.calls[4]?.[0]).toBe('e');
    for (const stop of stops.slice(1)) stop();
  });

  it('marks a retained result stale as soon as a newer read queues behind full slots', async () => {
    const read = vi
      .spyOn(client.varro.session, 'followupUsage')
      .mockResolvedValueOnce(usage({ pendingPromptIDs: ['p'] }));
    const stop = followupUsage.subscribe('k', 'child');
    followupUsage.request({ key: 'k', sessionID: 'child', revision: '1', promptID: 'p' });
    await settle();
    expect(resolveFollowupUsage(followupUsage.cache()['k'], 'p')).toEqual({ kind: 'pending' });

    read.mockImplementation(() => new Promise(() => {}));
    const stops = ['a', 'b', 'c', 'd'].map((key) => followupUsage.subscribe(key, key));
    for (const key of ['a', 'b', 'c', 'd'])
      followupUsage.request({ key, sessionID: key, revision: '1', promptID: 'x' });
    followupUsage.request({ key: 'k', sessionID: 'child', revision: '2', promptID: 'p' });
    flushSolid();

    expect(read).toHaveBeenCalledTimes(5);
    expect(followupUsage.cache()['k']).toMatchObject({ status: 'loading', revision: '2' });
    expect(resolveFollowupUsage(followupUsage.cache()['k'], 'p')).toEqual({ kind: 'loading' });
    for (const stopKey of stops) stopKey();
    stop();
  });

  it('drops retained reads for a reverted child and ignores its late completion', async () => {
    const resolvers: Array<(value: SessionFollowupUsage) => void> = [];
    const read = vi.spyOn(client.varro.session, 'followupUsage').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );
    const stop = followupUsage.subscribe('k', 'child');
    followupUsage.request({ key: 'k', sessionID: 'child', revision: '1', promptID: 'p' });
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'server/event',
          payload: { type: 'session.next.revert.committed', properties: { sessionID: 'child' } },
        },
      })
    );
    flushSolid();

    expect(read.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(followupUsage.cache()['k']).toBeUndefined();
    resolvers[0]!(usage({ intervals: [interval(['p'])] }));
    await settle();
    expect(followupUsage.cache()['k']).toBeUndefined();
    stop();
  });

  it('forwards the child directory with the read', async () => {
    const read = vi.spyOn(client.varro.session, 'followupUsage').mockResolvedValue(usage());
    const stop = followupUsage.subscribe('k', 'child');
    followupUsage.request({
      key: 'k',
      sessionID: 'child',
      directory: '/repo/sub',
      revision: '1',
      promptID: 'a',
    });
    await settle();

    expect(read).toHaveBeenCalledWith('child', {
      directory: '/repo/sub',
      signal: expect.any(AbortSignal),
    });
    stop();
  });

  it('advances only the matching child on delivery, step, and revert events', () => {
    const stop = followupUsage.subscribe('k', 'child');
    const emit = (type: string, sessionID: string) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'server/event', payload: { type, properties: { sessionID } } },
        })
      );
    const before = followupUsage.eventRevision('child');
    emit('session.next.prompted', 'other');
    flushSolid();
    expect(followupUsage.eventRevision('child')).toBe(before);

    emit('session.next.prompted', 'child');
    emit('session.next.step.ended', 'child');
    emit('session.next.revert.committed', 'child');
    flushSolid();

    expect(followupUsage.eventRevision('child')).toBe(before + 3);
    stop();
  });

  it('advances the shared connection revision on reconnect', () => {
    const stop = followupUsage.subscribe('k', 'child');
    const before = followupUsage.connection();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'server/event', payload: { type: 'server.connected' } },
      })
    );
    flushSolid();

    expect(followupUsage.connection()).toBe(before + 1);
    stop();
  });
});
