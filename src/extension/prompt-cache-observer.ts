/* oxlint-disable anti-slop/no-runtime-typeof -- Raw server event fields are validated at this boundary. */
import type { PromptCacheLearningState, ServerEvent } from '../shared/protocol';
import {
  promptCacheSample,
  promptCacheUsedAt,
  resolvePromptCacheLifetime,
  type PromptCacheModel,
} from '../shared/prompt-cache-lifetime';
import { asRecord, isNumber, isString } from '../shared/type-utils';
import type { PromptCacheLearner, PromptCacheObservation } from './prompt-cache-learning';

const MAX_TRACKED_SESSIONS = 200;
const OPENCODE_WARMING_CACHE_MS = 60_000;

/** The latest model request of a session: providers count the cache lifetime from its dispatch. */
type SessionRequest = { sentAt: number; model: PromptCacheModel | null };

export interface PromptCacheObserverDeps {
  /** OpenCode's effective config is readable only from a running server. */
  isAvailable(): boolean;
  /** Whether OpenCode's own `warming` config sends keep-alives Varro cannot see. */
  readOpenCodeWarming(): Promise<boolean>;
  /** Learns each model's real cache lifetime from requests after idle gaps. */
  learner: PromptCacheLearner;
  post(state: PromptCacheLearningState): void;
  now?: () => number;
}

function boundedSet<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Learns how long prompt caches actually last from live requests after idle gaps and from loaded
 * session histories, and publishes the learned lifetimes for the prompt-cache estimate and the
 * expiry warning. It never sends requests of its own.
 */
export class PromptCacheObserver {
  private readonly requests = new Map<string, SessionRequest>();
  /** When each session's cache was last read or written by a request. */
  private readonly cacheUses = new Map<string, { at: number; model: PromptCacheModel }>();
  private openCodeWarming: { value: boolean; readAt: number } | null = null;
  private disposed = false;

  constructor(private readonly deps: PromptCacheObserverDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  snapshot(): PromptCacheLearningState {
    return { learned: this.deps.learner.snapshot() };
  }

  /**
   * OpenCode's own warming renews caches with keep-alives that leave no messages or events here,
   * which would make caches look longer lived, so nothing is learned while it is on.
   */
  private hiddenKeepAlives() {
    return this.openCodeWarming?.value === true;
  }

  /** Records a loaded session's history from the webview. */
  recordHistory(sessionID: string, observations: readonly PromptCacheObservation[]): void {
    if (this.hiddenKeepAlives()) return;
    if (this.deps.learner.record(sessionID, observations)) this.publish();
  }

  private publish() {
    if (!this.disposed) this.deps.post(this.snapshot());
  }

  sync(): void {
    void this.refreshOpenCodeWarming().finally(() => this.publish());
  }

  handleServerEvent(event: ServerEvent): void {
    if (this.disposed) return;
    const properties = asRecord(event.properties);
    const sessionID = typeof properties?.sessionID === 'string' ? properties.sessionID : null;
    if (!sessionID) return;
    if (event.type === 'session.next.step.started') {
      // Each step is one model request, and its dispatch starts the cache lifetime. A remote
      // server's clock can run ahead of this one, so a later timestamp counts as now.
      const now = this.now();
      const model = asRecord(properties?.model);
      const providerID = model?.providerID;
      const modelID = model?.modelID ?? model?.id;
      boundedSet(this.requests, sessionID, {
        sentAt: isNumber(properties?.timestamp) ? Math.min(properties.timestamp, now) : now,
        model: isString(providerID) && isString(modelID) ? { providerID, modelID } : null,
      });
      return;
    }
    if (event.type === 'session.next.step.ended') {
      this.learnFromStep(sessionID, asRecord(properties?.tokens));
      return;
    }
    // A compacted context is a new prompt, so the next request misses for reasons unrelated to expiry.
    if (event.type.startsWith('session.next.compaction.')) this.cacheUses.delete(sessionID);
  }

  /**
   * A finished step is evidence when it followed an idle gap on the same model: whether it read
   * the cache shows whether the cache outlived that gap.
   */
  private learnFromStep(sessionID: string, tokens: ReturnType<typeof asRecord>) {
    const request = this.requests.get(sessionID);
    const cache = asRecord(tokens?.cache);
    const input = tokens?.input;
    const read = cache?.read;
    const write = cache?.write;
    if (!request?.model || !isNumber(input) || !isNumber(read) || !isNumber(write)) return;
    const model = request.model;
    const previous = this.cacheUses.get(sessionID);
    if (
      previous &&
      previous.model.providerID === model.providerID &&
      previous.model.modelID === model.modelID &&
      !this.hiddenKeepAlives()
    ) {
      const sample = promptCacheSample(previous.at, request.sentAt, {
        input,
        cache: { read, write },
      });
      if (
        sample &&
        this.deps.learner.record(sessionID, [{ ...model, ...sample, at: request.sentAt }])
      )
        this.publish();
    }
    const usedAt = promptCacheUsedAt(
      { created: request.sentAt, completed: this.now() },
      1,
      resolvePromptCacheLifetime(model)
    );
    boundedSet(this.cacheUses, sessionID, { at: usedAt, model });
  }

  private async refreshOpenCodeWarming(): Promise<boolean> {
    const now = this.now();
    if (this.openCodeWarming && now - this.openCodeWarming.readAt < OPENCODE_WARMING_CACHE_MS) {
      return this.openCodeWarming.value;
    }
    if (!this.deps.isAvailable()) return false;
    try {
      const value = await this.deps.readOpenCodeWarming();
      this.openCodeWarming = { value, readAt: now };
      return value;
    } catch {
      // An unreadable config keeps the last known state; OpenCode warms only when configured.
      return this.openCodeWarming?.value ?? false;
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}
