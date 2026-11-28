/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters -- SAFETY: Fixtures build minimal server events and an in-memory Persistence whose values the learner validates. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptCacheLearningState, ServerEvent } from '../shared/protocol';
import { PromptCacheLearner } from './prompt-cache-learning';
import { PromptCacheObserver, type PromptCacheObserverDeps } from './prompt-cache-observer';

const MINUTE = 60_000;
const claude = { providerID: 'anthropic', id: 'claude-opus-5-5' };

function stepStarted(sessionID: string, timestamp: number): ServerEvent {
  return {
    type: 'session.next.step.started',
    properties: { sessionID, timestamp, model: { ...claude, modelID: claude.id } },
  } as ServerEvent;
}

function stepEnded(sessionID: string, read: number): ServerEvent {
  return {
    type: 'session.next.step.ended',
    properties: {
      sessionID,
      tokens: { input: read ? 200 : 60_000, output: 10, reasoning: 0, cache: { read, write: 0 } },
    },
  } as ServerEvent;
}

function createHarness(overrides: Partial<PromptCacheObserverDeps> = {}) {
  const stored = new Map<string, unknown>();
  const posted: PromptCacheLearningState[] = [];
  const persistence = {
    get: <T>(key: string) => stored.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      stored.set(key, value);
    },
    remove: async (key: string) => {
      stored.delete(key);
    },
  };
  const observer = new PromptCacheObserver({
    isAvailable: () => true,
    readOpenCodeWarming: async () => false,
    learner: new PromptCacheLearner(persistence),
    post: (state) => posted.push(state),
    ...overrides,
  });
  const idleRequest = async (sessionID: string, gapMinutes: number, read: number) => {
    await vi.advanceTimersByTimeAsync(gapMinutes * MINUTE);
    observer.handleServerEvent(stepStarted(sessionID, Date.now()));
    observer.handleServerEvent(stepEnded(sessionID, read));
  };
  return { observer, posted, idleRequest };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PromptCacheObserver', () => {
  it('learns a shorter lifetime from requests after idle gaps', async () => {
    const harness = createHarness();
    await harness.idleRequest('session-1', 0, 60_000);
    // Three requests 7 min after the previous one all miss: this account keeps 5 min.
    for (let i = 0; i < 3; i += 1) await harness.idleRequest('session-1', 7, 0);
    expect(harness.posted.at(-1)?.learned['anthropic/claude-opus-5-5']).toEqual({
      ms: 5 * MINUTE,
      bounded: true,
    });
    expect(harness.posted.at(-1)?.learned['anthropic/*']).toEqual({
      ms: 5 * MINUTE,
      bounded: true,
    });
  });

  it('skips the first request after a compaction', async () => {
    const harness = createHarness();
    await harness.idleRequest('session-1', 0, 60_000);
    harness.observer.handleServerEvent({
      type: 'session.next.compaction.ended',
      properties: { sessionID: 'session-1' },
    } as ServerEvent);
    // The first request after a compaction misses because its prompt changed.
    await harness.idleRequest('session-1', 7, 0);
    expect(harness.observer.snapshot().learned).toEqual({});
  });

  it('learns from loaded history and counts each sample once', () => {
    const harness = createHarness();
    const samples = [1, 2, 3].map((at) => ({
      providerID: 'openai',
      modelID: 'gpt-6.2-sol',
      at,
      gapMs: 100 * MINUTE,
      hit: true,
    }));
    harness.observer.recordHistory('session-1', samples);
    harness.observer.recordHistory('session-1', samples);
    expect(harness.posted).toHaveLength(1);
    expect(harness.posted.at(-1)?.learned['openai/gpt-6.2-sol']).toEqual({
      ms: 120 * MINUTE,
      bounded: false,
    });
  });

  it("learns nothing while OpenCode's own warming sends keep-alives Varro cannot see", async () => {
    const harness = createHarness({ readOpenCodeWarming: async () => true });
    harness.observer.sync();
    await vi.advanceTimersByTimeAsync(0);
    await harness.idleRequest('session-1', 0, 60_000);
    for (let i = 0; i < 3; i += 1) await harness.idleRequest('session-1', 20, 60_000);
    harness.observer.recordHistory('session-2', [
      { providerID: 'openai', modelID: 'gpt-6.2-sol', at: 1, gapMs: 20 * MINUTE, hit: true },
    ]);
    expect(harness.observer.snapshot().learned).toEqual({});
  });

  it('publishes the learned lifetimes on sync and never sends requests of its own', async () => {
    const readOpenCodeWarming = vi.fn(async () => false);
    const harness = createHarness({ readOpenCodeWarming });
    harness.observer.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.posted).toEqual([{ learned: {} }]);
    expect(readOpenCodeWarming).toHaveBeenCalledOnce();
  });
});
