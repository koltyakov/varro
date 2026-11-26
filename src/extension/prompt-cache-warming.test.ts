/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters -- SAFETY: Fixtures build minimal server events and an in-memory Persistence whose values the service validates. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PromptCacheWarmingMode,
  PromptCacheWarmingState,
  ServerEvent,
} from '../shared/protocol';
import type { Provider } from '../shared/opencode-types';
import { PromptCacheLearner } from './prompt-cache-learning';
import {
  KEEP_ALIVE_PROMPT,
  PromptCacheWarming,
  type PromptCacheWarmingDeps,
  type PromptCacheWarmingUsage,
} from './prompt-cache-warming';

const MINUTE = 60_000;
/** The keep-alive interval for the 5 min fallback lifetime. */
const PROMPT_CACHE_PING_INTERVAL_MS = 4 * MINUTE;

function status(sessionID: string, type: 'busy' | 'idle' | 'retry'): ServerEvent {
  return { type: 'session.status', properties: { sessionID, status: { type } } } as ServerEvent;
}

function stepEnded(sessionID: string, read: number, input = 200): ServerEvent {
  return {
    type: 'session.next.step.ended',
    properties: {
      sessionID,
      tokens: { input, output: 10, reasoning: 0, cache: { read, write: 0 } },
    },
  } as ServerEvent;
}

function stepStarted(
  sessionID: string,
  timestamp: number,
  model: { providerID: string; id: string }
): ServerEvent {
  return {
    type: 'session.next.step.started',
    properties: { sessionID, timestamp, model: { ...model, modelID: model.id } },
  } as ServerEvent;
}

function createHarness(overrides: Partial<PromptCacheWarmingDeps> = {}) {
  const stored = new Map<string, unknown>();
  const posted: PromptCacheWarmingState[] = [];
  const busy = new Set<string>();
  let mode: PromptCacheWarmingMode = 'chosen';
  let durationMs = 30 * MINUTE;
  const generate = vi.fn<PromptCacheWarmingDeps['generate']>(
    async (): Promise<PromptCacheWarmingUsage> => ({ cacheRead: 100_000, cacheWrite: 20 })
  );
  const writeOpenCodeWarming = vi.fn<PromptCacheWarmingDeps['writeOpenCodeWarming']>(
    async () => {}
  );
  const persistence = {
    get: <T>(key: string) => stored.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      stored.set(key, value);
    },
    remove: async (key: string) => {
      stored.delete(key);
    },
  };
  const deps: PromptCacheWarmingDeps = {
    readMode: () => mode,
    readDurationMs: () => durationMs,
    isAvailable: () => true,
    isWarmable: (sessionID) => !sessionID.startsWith('child'),
    isBusy: (sessionID) => busy.has(sessionID),
    directoryFor: () => '/workspace',
    generate,
    readProviders: async () => [],
    readOpenCodeWarming: async () => false,
    writeOpenCodeWarming,
    persistence,
    learner: new PromptCacheLearner(persistence),
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
    setDuration: (next: number) => {
      durationMs = next;
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
      ttlMs: null,
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
    await vi.advanceTimersByTimeAsync(0);
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

  it("counts Claude's lifetime from the last request's dispatch, not the turn's end", async () => {
    const harness = createHarness();
    harness.warming.setSessionWarm('session-1', true);
    const claude = { providerID: 'anthropic', id: 'claude-sonnet-5-5' };
    harness.warming.handleServerEvent(stepStarted('session-1', Date.now(), claude));
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    harness.warming.handleServerEvent(status('session-1', 'idle'));
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.latest().sessions['session-1']).toMatchObject({
      sentAt: 1_000_000,
      ttlMs: 5 * MINUTE,
      warmUntil: 1_000_000 + 33 * MINUTE,
    });
    // Due 4 min after the dispatch, one minute after the turn ended.
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(harness.generate).toHaveBeenCalledOnce();
  });

  it("counts Claude Code's lifetime from the turn's end, since one step holds its own loop", async () => {
    const harness = createHarness();
    harness.warming.setSessionWarm('session-1', true);
    harness.warming.handleServerEvent(
      stepStarted('session-1', Date.now(), { providerID: 'claude-agent', id: 'sonnet' })
    );
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    harness.warming.handleServerEvent(status('session-1', 'idle'));
    await vi.advanceTimersByTimeAsync(0);
    // An unpriced Claude Agent model is a subscription, whose 1 h cache outlives the window.
    expect(harness.latest().sessions['session-1']).toMatchObject({
      sentAt: 1_000_000 + 10 * MINUTE,
      ttlMs: 60 * MINUTE,
      stopped: null,
    });
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(harness.generate).not.toHaveBeenCalled();
    expect(harness.latest().sessions['session-1']?.stopped).toBe('expired');
  });

  it("still pings after OpenAI's minimum while its cache is probably warm", async () => {
    const harness = createHarness();
    harness.setDuration(60 * MINUTE);
    harness.warming.setSessionWarm('session-1', true);
    harness.warming.handleServerEvent(
      stepStarted('session-1', Date.now(), { providerID: 'openai', id: 'gpt-6.2-sol' })
    );
    harness.warming.handleServerEvent(status('session-1', 'idle'));
    await vi.advanceTimersByTimeAsync(0);
    // The computer sleeps past the 30 min minimum but well within the usual 3 h.
    vi.setSystemTime(Date.now() + 20 * MINUTE);
    await vi.advanceTimersByTimeAsync(27 * MINUTE);
    expect(harness.generate).toHaveBeenCalledOnce();
  });

  it('skips the keep-alive when the last response outlasted the cache', async () => {
    const harness = createHarness();
    harness.warming.setSessionWarm('session-1', true);
    harness.warming.handleServerEvent(
      stepStarted('session-1', Date.now(), { providerID: 'anthropic', id: 'claude-opus-5-5' })
    );
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    harness.warming.handleServerEvent(status('session-1', 'idle'));
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(harness.generate).not.toHaveBeenCalled();
    expect(harness.latest().sessions['session-1']?.stopped).toBe('cache-miss');
  });

  it('skips a keep-alive that fires after the cache expired while the computer slept', async () => {
    const harness = createHarness();
    harness.warming.setSessionWarm('session-1', true);
    harness.warming.handleServerEvent(status('session-1', 'idle'));
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 10 * MINUTE);
    await vi.advanceTimersByTimeAsync(PROMPT_CACHE_PING_INTERVAL_MS);
    expect(harness.generate).not.toHaveBeenCalled();
    expect(harness.latest().sessions['session-1']?.stopped).toBe('cache-miss');
  });

  it("does not ping when OpenAI's 30 min cache already covers the window", async () => {
    const harness = createHarness();
    const gpt = { providerID: 'openai', id: 'gpt-6.2-sol' };
    harness.warming.setSessionWarm('session-1', true);
    harness.warming.handleServerEvent(stepStarted('session-1', Date.now(), gpt));
    harness.warming.handleServerEvent(status('session-1', 'idle'));
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(harness.generate).not.toHaveBeenCalled();
    expect(harness.latest().sessions['session-1']?.stopped).toBe('expired');

    // A longer window pings 27 min after each request.
    harness.setDuration(60 * MINUTE);
    harness.warming.handleServerEvent(stepStarted('session-1', Date.now(), gpt));
    harness.warming.handleServerEvent(status('session-1', 'idle'));
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(harness.generate).toHaveBeenCalledTimes(2);
    expect(harness.latest().sessions['session-1']?.stopped).toBe('expired');
  });

  it("uses the model's configured cache.ttl from the provider catalog", async () => {
    const anthropic: Provider = {
      id: 'anthropic',
      name: 'Anthropic',
      source: 'api',
      options: { cache: { ttl: '1h' } },
      models: {
        'claude-opus-5-5': {
          id: 'claude-opus-5-5',
          name: 'Claude Opus 5.5',
          capabilities: {},
          cost: { input: 0, output: 0 },
        },
      },
    };
    const readProviders = vi.fn(async () => [anthropic]);
    const harness = createHarness({ readProviders });
    harness.warming.setSessionWarm('session-1', true);
    harness.warming.handleServerEvent(
      stepStarted('session-1', Date.now(), { providerID: 'anthropic', id: 'claude-opus-5-5' })
    );
    harness.warming.handleServerEvent(status('session-1', 'idle'));
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(readProviders).toHaveBeenCalledWith('/workspace');
    expect(harness.latest().sessions['session-1']?.ttlMs).toBe(60 * MINUTE);
    expect(harness.generate).not.toHaveBeenCalled();
  });

  describe('learning cache lifetimes', () => {
    const claude = { providerID: 'anthropic', id: 'claude-opus-5-5' };

    async function idleRequest(
      harness: ReturnType<typeof createHarness>,
      sessionID: string,
      gapMinutes: number,
      read: number
    ) {
      await vi.advanceTimersByTimeAsync(gapMinutes * MINUTE);
      harness.warming.handleServerEvent(stepStarted(sessionID, Date.now(), claude));
      harness.warming.handleServerEvent(stepEnded(sessionID, read, read ? 200 : 60_000));
    }

    it('learns a shorter lifetime from requests after idle gaps and keeps warming by it', async () => {
      const harness = createHarness();
      await idleRequest(harness, 'session-1', 0, 60_000);
      // Three requests 7 min after the previous one all miss: this account keeps 5 min.
      for (let i = 0; i < 3; i += 1) await idleRequest(harness, 'session-1', 7, 0);
      expect(harness.latest().learned['anthropic/claude-opus-5-5']).toEqual({
        ms: 5 * MINUTE,
        bounded: true,
      });
      expect(harness.latest().learned['anthropic/*']).toEqual({ ms: 5 * MINUTE, bounded: true });
    });

    it('measures gaps from the latest keep-alive and skips compactions', async () => {
      const harness = createHarness();
      harness.warming.setSessionWarm('session-1', true);
      await idleRequest(harness, 'session-1', 0, 60_000);
      harness.warming.handleServerEvent(status('session-1', 'idle'));
      // Keep-alives at 4 and 8 min, then a hit at 10 min: a 2 min gap, which proves nothing.
      await idleRequest(harness, 'session-1', 10, 60_000);
      expect(harness.generate).toHaveBeenCalledTimes(2);
      harness.warming.handleServerEvent({
        type: 'session.next.compaction.ended',
        properties: { sessionID: 'session-1' },
      } as ServerEvent);
      // The first request after a compaction misses because its prompt changed.
      await idleRequest(harness, 'session-1', 0, 0);
      expect(harness.latest().learned).toEqual({});
    });

    it('learns nothing while OpenCode sends keep-alives Varro cannot see', async () => {
      const harness = createHarness();
      harness.setMode('all');
      await idleRequest(harness, 'session-1', 0, 60_000);
      for (let i = 0; i < 3; i += 1) await idleRequest(harness, 'session-1', 20, 60_000);
      harness.warming.recordHistory('session-2', [
        { providerID: 'openai', modelID: 'gpt-6.2-sol', at: 1, gapMs: 20 * MINUTE, hit: true },
      ]);
      expect(harness.warming.snapshot().learned).toEqual({});
    });

    it('learns from history except where keep-alives may have renewed the cache', () => {
      const harness = createHarness();
      const samples = [1, 2, 3].map((at) => ({
        providerID: 'openai',
        modelID: 'gpt-6.2-sol',
        at,
        gapMs: 100 * MINUTE,
        hit: true,
      }));
      harness.warming.setSessionWarm('chosen-1', true);
      harness.warming.recordHistory('chosen-1', samples);
      expect(harness.latest().learned).toEqual({});
      harness.warming.recordHistory('session-1', samples);
      harness.warming.recordHistory('session-1', samples);
      expect(harness.latest().learned['openai/gpt-6.2-sol']).toEqual({
        ms: 120 * MINUTE,
        bounded: false,
      });
    });
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
