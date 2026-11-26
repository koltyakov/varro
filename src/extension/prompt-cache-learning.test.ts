import { describe, expect, it } from 'vitest';
import type { Persistence } from '../shared/persistence';
import { PromptCacheLearner, type PromptCacheObservation } from './prompt-cache-learning';

const MINUTE = 60_000;

function memoryPersistence(initial?: { key: string; value: unknown }) {
  const stored = new Map<string, unknown>(initial ? [[initial.key, initial.value]] : []);
  const persistence: Persistence = {
    // SAFETY: Tests read back only what they stored; the learner validates every value it loads.
    get: <T>(key: string) => stored.get(key) as T | undefined,
    set: (key, value) => {
      stored.set(key, value);
    },
    remove: (key) => {
      stored.delete(key);
    },
  };
  return { persistence, stored };
}

function observations(
  modelID: string,
  gapMinutes: number,
  results: boolean[],
  firstAt = 1
): PromptCacheObservation[] {
  return results.map((hit, index) => ({
    providerID: 'claude-agent',
    modelID,
    at: firstAt + index,
    gapMs: gapMinutes * MINUTE,
    hit,
  }));
}

describe('PromptCacheLearner', () => {
  it('learns per model and per provider, and keeps it across restarts', () => {
    const { persistence } = memoryPersistence();
    const learner = new PromptCacheLearner(persistence);
    expect(learner.record('ses_1', observations('opus', 40, [true, true, true]))).toBe(true);
    expect(learner.record('ses_2', observations('fable', 70, [false, false, false]))).toBe(true);
    expect(learner.snapshot()).toEqual({
      'claude-agent/opus': { ms: 45 * MINUTE, bounded: false },
      'claude-agent/fable': { ms: 60 * MINUTE, bounded: true },
      'claude-agent/*': { ms: 45 * MINUTE, bounded: true },
    });
    expect(new PromptCacheLearner(persistence).snapshot()).toEqual(learner.snapshot());
  });

  it('counts each session observation once, even when its history is sent again', () => {
    const { persistence } = memoryPersistence();
    const learner = new PromptCacheLearner(persistence);
    learner.record('ses_1', observations('opus', 40, [true, true], 10));
    expect(learner.record('ses_1', observations('opus', 40, [true, true], 10))).toBe(false);
    expect(learner.snapshot()).toEqual({});
    // A later request in the same session still counts.
    expect(learner.record('ses_1', observations('opus', 40, [true], 20))).toBe(true);
    expect(learner.snapshot()['claude-agent/opus']).toEqual({ ms: 45 * MINUTE, bounded: false });
  });

  it('ignores malformed stored state', () => {
    const { persistence } = memoryPersistence({
      key: 'varro.promptCache.learned',
      value: { histograms: { 'claude-agent/opus': [[1, 2]] }, watermarks: { ses_1: 'late' } },
    });
    const learner = new PromptCacheLearner(persistence);
    expect(learner.snapshot()).toEqual({});
    expect(learner.record('ses_1', observations('opus', 40, [true]))).toBe(true);
  });
});
