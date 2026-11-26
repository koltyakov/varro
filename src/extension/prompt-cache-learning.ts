import type { Persistence } from '../shared/persistence';
import {
  addPromptCacheSample,
  emptyPromptCacheHistogram,
  isPromptCacheHistogram,
  learnPromptCacheLifetime,
  promptCacheModelKey,
  promptCacheProviderKey,
  type LearnedPromptCacheLifetime,
  type LearnedPromptCacheLifetimes,
  type PromptCacheHistogram,
  type PromptCacheModel,
  type PromptCacheSample,
} from '../shared/prompt-cache-lifetime';
import { asRecord, isNumber } from '../shared/type-utils';

const LEARNED_KEY = 'varro.promptCache.learned';
const MAX_MODELS = 100;
const MAX_SESSIONS = 500;

/** One request after an idle gap, sent at `at`. */
export type PromptCacheObservation = PromptCacheModel & PromptCacheSample & { at: number };

type Stored = {
  histograms: Record<string, PromptCacheHistogram>;
  /** The latest observation recorded per session, so a reloaded history does not count twice. */
  watermarks: Record<string, number>;
};

function boundedEntries<V>(record: Record<string, V>, limit: number): Record<string, V> {
  const entries = Object.entries(record);
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - limit)));
}

/**
 * Learns how long each model's prompt cache actually lasts for this user, from whether requests
 * after idle gaps read it. Kept in global state, since accounts and plans span workspaces.
 */
export class PromptCacheLearner {
  private stored: Stored;
  private learned: LearnedPromptCacheLifetimes | null = null;

  constructor(private readonly persistence: Persistence) {
    const value = asRecord(persistence.get<unknown>(LEARNED_KEY));
    const histograms: Record<string, PromptCacheHistogram> = {};
    for (const [key, histogram] of Object.entries(asRecord(value?.histograms) ?? {}))
      if (isPromptCacheHistogram(histogram)) histograms[key] = histogram;
    const watermarks: Record<string, number> = {};
    for (const [sessionID, at] of Object.entries(asRecord(value?.watermarks) ?? {}))
      if (isNumber(at) && Number.isFinite(at)) watermarks[sessionID] = at;
    this.stored = { histograms, watermarks };
  }

  /**
   * Records a session's observations. Only those after the latest one already recorded for the
   * session count, so live events and a history sent again later are each counted once.
   * Returns whether anything was recorded.
   */
  record(sessionID: string, observations: readonly PromptCacheObservation[]): boolean {
    let watermark = this.stored.watermarks[sessionID] ?? -Infinity;
    const histograms = { ...this.stored.histograms };
    let changed = false;
    for (const observation of observations.toSorted((a, b) => a.at - b.at)) {
      if (observation.at <= watermark) continue;
      watermark = observation.at;
      const key = promptCacheModelKey(observation);
      const histogram = histograms[key] ?? emptyPromptCacheHistogram();
      // Re-inserting keeps the most recently used models when the map is trimmed.
      delete histograms[key];
      histograms[key] = addPromptCacheSample(histogram, observation);
      changed = true;
    }
    if (!changed) return false;
    const watermarks = { ...this.stored.watermarks };
    delete watermarks[sessionID];
    watermarks[sessionID] = watermark;
    this.stored = {
      histograms: boundedEntries(histograms, MAX_MODELS),
      watermarks: boundedEntries(watermarks, MAX_SESSIONS),
    };
    this.learned = null;
    void this.persistence.set(LEARNED_KEY, this.stored);
    return true;
  }

  /** Learned lifetimes per model, and per provider from all of its models together. */
  snapshot(): LearnedPromptCacheLifetimes {
    if (this.learned) return this.learned;
    const learned: Record<string, LearnedPromptCacheLifetime> = {};
    const providers = new Map<string, PromptCacheHistogram>();
    for (const [key, histogram] of Object.entries(this.stored.histograms)) {
      const lifetime = learnPromptCacheLifetime(histogram);
      if (lifetime) learned[key] = lifetime;
      const providerKey = promptCacheProviderKey(key.slice(0, key.indexOf('/')));
      const total = providers.get(providerKey) ?? emptyPromptCacheHistogram();
      providers.set(
        providerKey,
        total.map(([hits, misses], index) => [
          hits + (histogram[index]?.[0] ?? 0),
          misses + (histogram[index]?.[1] ?? 0),
        ])
      );
    }
    for (const [key, histogram] of providers) {
      const lifetime = learnPromptCacheLifetime(histogram);
      if (lifetime) learned[key] = lifetime;
    }
    this.learned = learned;
    return learned;
  }
}
