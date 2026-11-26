/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters -- SAFETY: Fixtures build minimal server events and an in-memory Persistence whose values the service validates. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PromptCacheWarmingMode,
  PromptCacheWarmingState,
  ServerEvent,
} from '../shared/protocol';
import {
  KEEP_ALIVE_PROMPT,
  PROMPT_CACHE_PING_INTERVAL_MS,
  PromptCacheWarming,
  type PromptCacheWarmingDeps,
  type PromptCacheWarmingUsage,
} from './prompt-cache-warming';

const MINUTE = 60_000;

function status(sessionID: string, type: 'busy' | 'idle' | 'retry'): ServerEvent {
  return { type: 'session.status', properties: { sessionID, status: { type } } } as ServerEvent;
}

function createHarness(overrides: Partial<PromptCacheWarmingDeps> = {}) {
  const stored = new Map<string, unknown>();
  const posted: PromptCacheWarmingState[] = [];
  const busy = new Set<string>();
  let mode: PromptCacheWarmingMode = 'chosen';
  const generate = vi.fn<PromptCacheWarmingDeps['generate']>(
    async (): Promise<PromptCacheWarmingUsage> => ({ cacheRead: 100_000, cacheWrite: 20 })
  );
  const writeOpenCodeWarming = vi.fn<PromptCacheWarmingDeps['writeOpenCodeWarming']>(
    async () => {}
  );
  const deps: PromptCacheWarmingDeps = {
    readMode: () => mode,
    readDurationMs: () => 30 * MINUTE,
    isAvailable: () => true,
    isWarmable: (sessionID) => !sessionID.startsWith('child'),
    isBusy: (sessionID) => busy.has(sessionID),
    directoryFor: () => '/workspace',
    generate,
    readOpenCodeWarming: async () => false,
    writeOpenCodeWarming,
    persistence: {
      get: <T>(key: string) => stored.get(key) as T | undefined,
      set: async (key: string, value: unknown) => {
        stored.set(key, value);
      },
      remove: async (key: string) => {
        stored.delete(key);
      },
    },
    post: (state) => posted.push(state),
    logWarning: () => {},
    ...overrides,
  };
  const warming = new PromptCacheWarming(deps);
  return {
    warming,
    generate,
    writeOpenCodeWarming,
    posted,
    busy,
    stored,
    setMode: (next: PromptCacheWarmingMode) => {
      mode = next;
    },
    latest: () => posted.at(-1)!,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PromptCacheWarming', () => {
  it('pings a chosen session before its cache expires until the window ends', async () => {
    const harness = createHarness();
    harness.warming.setSessionWarm('session-1', true);
    expect(harness.latest().sessions['session-1']).toEqual({
      warmUntil: null,
      sentAt: null,
      stopped: null,
    });

    harness.warming.handleServerEvent(status('session-1', 'idle'));
    expect(harness.latest().sessions['session-1']?.warmUntil).toBe(1_000_000 + 30 * MINUTE);

    await vi.advanceTimersByTimeAsync(PROMPT_CACHE_PING_INTERVAL_MS);
    expect(harness.generate).toHaveBeenCalledOnce();
    expect(harness.generate).toHaveBeenCalledWith(
      'session-1',
      '/workspace',
      KEEP_ALIVE_PROMPT,
      expect.any(AbortSignal)
    );

    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    // Pings at 4, 8, ..., 28 minutes; the window closes at 30 without another request.
    expect(harness.generate).toHaveBeenCalledTimes(7);
    expect(harness.latest().sessions['session-1']?.stopped).toBe('expired');
    expect(harness.stored.get('varro.promptCacheWarming.sessions')).toEqual(['session-1']);
  });

  it('never pings unchosen sessions, child sessions, or a session that is running', async () => {
    const harness = createHarness();
    harness.warming.setSessionWarm('child-1', true);
    harness.warming.handleServerEvent(status('other', 'idle'));
    harness.warming.handleServerEvent(status('child-1', 'idle'));
    expect(harness.latest().sessions).toEqual({});

    harness.warming.setSessionWarm('session-1', true);
    harness.warming.handleServerEvent(status('session-1', 'idle'));
    harness.busy.add('session-1');
    await vi.advanceTimersByTimeAsync(PROMPT_CACHE_PING_INTERVAL_MS);
    expect(harness.generate).not.toHaveBeenCalled();

    // A new turn replaces the window; its end starts the next one.
    harness.warming.handleServerEvent(status('session-1', 'busy'));
    expect(harness.latest().sessions['session-1']?.warmUntil).toBeNull();
    harness.busy.delete('session-1');
    harness.warming.handleServerEvent(status('session-1', 'idle'));
    await vi.advanceTimersByTimeAsync(PROMPT_CACHE_PING_INTERVAL_MS);
    expect(harness.generate).toHaveBeenCalledOnce();
  });

  it('starts at once for a recent reply and waits for the next reply otherwise', async () => {
    const harness = createHarness();
    harness.warming.handleServerEvent(status('recent', 'idle'));
    harness.warming.handleServerEvent(status('stale', 'idle'));
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    harness.warming.setSessionWarm('recent', true);
    expect(harness.latest().sessions.recent?.sentAt).toBe(1_000_000);

    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    harness.warming.setSessionWarm('stale', true);
    expect(harness.latest().sessions.stale?.warmUntil).toBeNull();
    expect(harness.generate).toHaveBeenCalledOnce();
    expect(harness.generate.mock.calls[0]?.[0]).toBe('recent');
  });

  it('stops after a keep-alive rebuilt the cache instead of reading it', async () => {
    const harness = createHarness();
    harness.generate.mockResolvedValueOnce({ cacheRead: 0, cacheWrite: 90_000 });
    harness.warming.setSessionWarm('session-1', true);
    harness.warming.handleServerEvent(status('session-1', 'idle'));
    await vi.advanceTimersByTimeAsync(PROMPT_CACHE_PING_INTERVAL_MS * 3);
    expect(harness.generate).toHaveBeenCalledOnce();
    expect(harness.latest().sessions['session-1']?.stopped).toBe('cache-miss');
  });

  it('defers to OpenCode warming and writes it for all sessions', async () => {
    const harness = createHarness({ readOpenCodeWarming: async () => true });
    harness.warming.setSessionWarm('session-1', true);
    harness.warming.handleServerEvent(status('session-1', 'idle'));
    await vi.advanceTimersByTimeAsync(PROMPT_CACHE_PING_INTERVAL_MS);
    expect(harness.generate).not.toHaveBeenCalled();
    expect(harness.latest().openCodeWarming).toBe(true);

    harness.setMode('all');
    await harness.warming.applySettings('chosen');
    expect(harness.writeOpenCodeWarming).toHaveBeenLastCalledWith(true);
    harness.setMode('off');
    await harness.warming.applySettings('all');
    expect(harness.writeOpenCodeWarming).toHaveBeenLastCalledWith(null);
    harness.setMode('chosen');
    await harness.warming.applySettings('off');
    expect(harness.writeOpenCodeWarming).toHaveBeenCalledTimes(2);
  });

  it('forgets a deleted session', () => {
    const harness = createHarness();
    harness.warming.setSessionWarm('session-1', true);
    harness.warming.handleServerEvent({
      type: 'session.deleted',
      properties: { info: { id: 'session-1' } },
    } as ServerEvent);
    expect(harness.warming.isChosen('session-1')).toBe(false);
    expect(harness.stored.get('varro.promptCacheWarming.sessions')).toEqual([]);
  });
});
