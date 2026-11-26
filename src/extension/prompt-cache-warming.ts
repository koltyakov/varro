/* oxlint-disable anti-slop/no-runtime-typeof -- Persisted IDs and raw server event fields are validated at this boundary. */
import type {
  PromptCacheWarmingMode,
  PromptCacheWarmingSession,
  PromptCacheWarmingState,
  ServerEvent,
} from '../shared/protocol';
import type { Provider } from '../shared/opencode-types';
import type { Persistence } from '../shared/persistence';
import {
  FALLBACK_PROMPT_CACHE_TTL_MS,
  promptCacheKeepAliveIntervalMs,
  promptCacheLifetimeFor,
  promptCacheSample,
  promptCacheUsedAt,
  resolvePromptCacheLifetime,
  type PromptCacheLifetime,
  type PromptCacheModel,
} from '../shared/prompt-cache-lifetime';
import { asRecord, isNumber, isString } from '../shared/type-utils';
import type { PromptCacheLearner, PromptCacheObservation } from './prompt-cache-learning';

/**
 * OpenCode's own keep-alive prompt. Its warming plugin ignores a request with exactly this text,
 * so a Varro ping never restarts OpenCode's schedule when both are configured.
 */
export const KEEP_ALIVE_PROMPT =
  'This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK';
const CHOSEN_SESSIONS_KEY = 'varro.promptCacheWarming.sessions';
const MAX_CHOSEN_SESSIONS = 50;
const MAX_TRACKED_SESSIONS = 200;
const OPENCODE_WARMING_CACHE_MS = 60_000;
const PROVIDER_CATALOG_CACHE_MS = 60_000;

export type PromptCacheWarmingUsage = { cacheRead: number; cacheWrite: number };

/** The latest model request of a session: providers count the cache lifetime from its dispatch. */
type SessionRequest = { sentAt: number; model: PromptCacheModel | null };
type TurnEnd = SessionRequest & { endedAt: number };
type Lifetime = { ttlMs: number; likelyMs: number };

export interface PromptCacheWarmingDeps {
  readMode(): PromptCacheWarmingMode;
  readDurationMs(): number;
  /** Warming needs OpenCode v2's transient `/generate` route on a running server. */
  isAvailable(): boolean;
  /** Root, user-visible sessions only: children and helper sessions are never warmed. */
  isWarmable(sessionID: string): boolean;
  isBusy(sessionID: string): boolean;
  directoryFor(sessionID: string): string | undefined;
  generate(
    sessionID: string,
    directory: string | undefined,
    prompt: string,
    signal: AbortSignal
  ): Promise<PromptCacheWarmingUsage>;
  /** The v1-shaped provider catalog, for each model's effective `cache.ttl`. */
  readProviders(directory: string | undefined): Promise<readonly Provider[]>;
  /** Whether OpenCode's effective config already warms every session. */
  readOpenCodeWarming(): Promise<boolean>;
  writeOpenCodeWarming(value: true | { duration: string } | null): Promise<void>;
  persistence: Persistence;
  /** Learns each model's real cache lifetime from requests after idle gaps. */
  learner: PromptCacheLearner;
  post(state: PromptCacheWarmingState): void;
  logWarning(message: string): void;
  now?: () => number;
}

type WarmEntry = {
  /** End of the warming window; `null` while waiting for a turn to finish. */
  warmUntil: number | null;
  /** When the latest request or ping sent the context, which is when its cache lifetime starts. */
  sentAt: number | null;
  /** The model's guaranteed cache lifetime; `null` until the provider catalog is read. */
  ttlMs: number | null;
  /** How long the cache usually lasts, at least `ttlMs`; `null` until the catalog is read. */
  likelyMs: number | null;
  stopped: PromptCacheWarmingSession['stopped'];
  timer?: ReturnType<typeof setTimeout>;
  request?: AbortController;
};

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
 * Keeps chosen sessions' provider prompt caches alive while they sit idle, by sending OpenCode's
 * transient `/generate` keep-alive just before the cache would expire. "All sessions" mode is
 * delegated to OpenCode's own `warming` config instead, so it also covers the TUI and closed windows.
 */
export class PromptCacheWarming {
  private readonly chosen: Set<string>;
  private readonly entries = new Map<string, WarmEntry>();
  private readonly requests = new Map<string, SessionRequest>();
  private readonly turnEnds = new Map<string, TurnEnd>();
  /** When each session's cache was last read or written, by a request or a keep-alive. */
  private readonly cacheUses = new Map<string, { at: number; model: PromptCacheModel }>();
  private openCodeWarming: { value: boolean; readAt: number } | null = null;
  private readonly catalogs = new Map<
    string,
    { providers: Promise<readonly Provider[]>; readAt: number }
  >();
  private disposed = false;

  constructor(private readonly deps: PromptCacheWarmingDeps) {
    const stored = deps.persistence.get<unknown>(CHOSEN_SESSIONS_KEY);
    this.chosen = new Set(
      Array.isArray(stored)
        ? stored
            .filter((value): value is string => typeof value === 'string')
            .slice(-MAX_CHOSEN_SESSIONS)
        : []
    );
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  snapshot(): PromptCacheWarmingState {
    const mode = this.deps.readMode();
    const sessions: Record<string, PromptCacheWarmingSession> = {};
    if (mode === 'chosen') {
      for (const sessionID of this.chosen) {
        const entry = this.entries.get(sessionID);
        sessions[sessionID] = {
          warmUntil: entry?.warmUntil ?? null,
          sentAt: entry?.sentAt ?? null,
          ttlMs: entry?.ttlMs ?? null,
          stopped: entry?.stopped ?? null,
        };
      }
    }
    return {
      available: this.deps.isAvailable(),
      mode,
      durationMs: this.deps.readDurationMs(),
      openCodeWarming: this.openCodeWarming?.value ?? false,
      sessions,
      learned: this.deps.learner.snapshot(),
    };
  }

  /**
   * Whether keep-alives Varro cannot see may renew caches, which would make them look longer
   * lived. OpenCode's own warming sends them for every session.
   */
  private hiddenKeepAlives() {
    return this.deps.readMode() === 'all' || this.openCodeWarming?.value === true;
  }

  /**
   * Records a session's history from the webview. A session chosen for warming may have been kept
   * alive by keep-alives that left no messages, so its history proves nothing about expiry.
   */
  recordHistory(sessionID: string, observations: readonly PromptCacheObservation[]): void {
    if (this.chosen.has(sessionID) || this.hiddenKeepAlives()) return;
    if (this.deps.learner.record(sessionID, observations)) this.publish();
  }

  private publish() {
    if (!this.disposed) this.deps.post(this.snapshot());
  }

  /** Applies a changed mode or duration. `all` is OpenCode's own config, so it is written there. */
  async applySettings(previousMode: PromptCacheWarmingMode | null): Promise<void> {
    const mode = this.deps.readMode();
    if (mode === 'all') {
      const minutes = Math.round(this.deps.readDurationMs() / 60_000);
      // OpenCode's default window is 30 minutes, which plain `true` expresses.
      await this.deps.writeOpenCodeWarming(
        minutes === 30 ? true : { duration: `${minutes} minutes` }
      );
    } else if (previousMode === 'all') {
      await this.deps.writeOpenCodeWarming(null);
    }
    this.openCodeWarming = null;
    if (mode !== 'chosen') this.stopAll();
    else await this.refreshOpenCodeWarming();
    this.publish();
  }

  sync(): void {
    void this.refreshOpenCodeWarming().finally(() => this.publish());
  }

  isChosen(sessionID: string): boolean {
    return this.chosen.has(sessionID);
  }

  setSessionWarm(sessionID: string, enabled: boolean): void {
    if (enabled === this.chosen.has(sessionID)) {
      this.publish();
      return;
    }
    if (enabled) {
      if (!this.deps.isWarmable(sessionID)) {
        this.publish();
        return;
      }
      this.chosen.add(sessionID);
      while (this.chosen.size > MAX_CHOSEN_SESSIONS) {
        const oldest = this.chosen.values().next().value;
        if (oldest === undefined) break;
        this.chosen.delete(oldest);
        this.stop(oldest);
      }
      this.startFromLastTurn(sessionID);
    } else {
      this.chosen.delete(sessionID);
      this.stop(sessionID);
    }
    void this.deps.persistence.set(CHOSEN_SESSIONS_KEY, [...this.chosen]);
    this.publish();
  }

  handleServerEvent(event: ServerEvent): void {
    if (this.disposed) return;
    const properties = asRecord(event.properties);
    const sessionID = typeof properties?.sessionID === 'string' ? properties.sessionID : null;
    if (event.type === 'session.deleted') {
      const info = asRecord(properties?.info);
      const id = sessionID ?? (typeof info?.id === 'string' ? info.id : null);
      if (id && this.chosen.delete(id)) {
        this.stop(id);
        void this.deps.persistence.set(CHOSEN_SESSIONS_KEY, [...this.chosen]);
        this.publish();
      }
      return;
    }
    if (!sessionID) return;
    if (event.type === 'session.next.step.started') {
      // Each step is one model request, and its dispatch starts the cache lifetime. Long responses
      // use up part of it, so the turn's end is too late to count from. A remote server's clock
      // can run ahead of this one, so a later timestamp counts as now.
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
    if (event.type.startsWith('session.next.compaction.')) {
      this.cacheUses.delete(sessionID);
      return;
    }
    if (event.type !== 'session.status' && event.type !== 'session.idle') return;
    const status = asRecord(properties?.status)?.type;
    if (event.type === 'session.status' && (status === 'busy' || status === 'retry')) {
      this.turnEnds.delete(sessionID);
      if (!this.chosen.has(sessionID)) return;
      // A real request replaces the warming window; the next turn end starts a new one.
      this.stop(sessionID);
      this.entries.set(sessionID, this.waiting());
      this.publish();
      return;
    }
    if (event.type === 'session.status' && status !== 'idle') return;
    const now = this.now();
    const request = this.requests.get(sessionID);
    const model = request?.model ?? null;
    // A step that holds several requests, such as Claude Code's own loop, sent its last one at an
    // unknown time; the turn's end is the closest known bound.
    const multiRequest = model !== null && resolvePromptCacheLifetime(model).multiRequestSteps;
    const turn = { endedAt: now, sentAt: request && !multiRequest ? request.sentAt : now, model };
    boundedSet(this.turnEnds, sessionID, turn);
    if (!this.chosen.has(sessionID)) return;
    this.startWindow(sessionID, turn);
    this.publish();
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

  private waiting(): WarmEntry {
    return { warmUntil: null, sentAt: null, ttlMs: null, likelyMs: null, stopped: null };
  }

  /** A newly chosen session is warmed at once only while its last request's cache is probably alive. */
  private startFromLastTurn(sessionID: string) {
    this.stop(sessionID);
    const entry = this.waiting();
    this.entries.set(sessionID, entry);
    const turn = this.turnEnds.get(sessionID);
    if (!turn || this.deps.isBusy(sessionID)) return;
    void this.lifetimeFor(sessionID, turn.model).then((lifetime) => {
      if (this.entries.get(sessionID) !== entry || this.deps.isBusy(sessionID)) return;
      if (this.now() - turn.sentAt >= lifetime.likelyMs) return;
      this.startWindow(sessionID, turn, lifetime);
      this.publish();
    });
  }

  private startWindow(sessionID: string, turn: TurnEnd, lifetime?: Lifetime) {
    this.stop(sessionID);
    if (this.deps.readMode() !== 'chosen') return;
    const entry: WarmEntry = {
      warmUntil: turn.endedAt + this.deps.readDurationMs(),
      sentAt: turn.sentAt,
      ttlMs: lifetime?.ttlMs ?? null,
      likelyMs: lifetime?.likelyMs ?? null,
      stopped: null,
    };
    this.entries.set(sessionID, entry);
    if (lifetime) {
      this.schedule(sessionID, entry);
      return;
    }
    void this.lifetimeFor(sessionID, turn.model).then((resolved) => {
      if (this.entries.get(sessionID) !== entry) return;
      entry.ttlMs = resolved.ttlMs;
      entry.likelyMs = resolved.likelyMs;
      this.schedule(sessionID, entry);
      this.publish();
    });
  }

  private schedule(sessionID: string, entry: WarmEntry) {
    if (entry.warmUntil === null || entry.sentAt === null || entry.ttlMs === null) return;
    // A cache that outlives the window needs no keep-alive; the timer only closes the window.
    const due =
      entry.sentAt + entry.ttlMs >= entry.warmUntil
        ? entry.warmUntil
        : entry.sentAt + promptCacheKeepAliveIntervalMs(entry.ttlMs);
    entry.timer = setTimeout(() => void this.ping(sessionID, entry), Math.max(0, due - this.now()));
  }

  /** The cache lifetime of a session's model, with its configured `cache.ttl` when readable. */
  private async lifetimeFor(sessionID: string, model: PromptCacheModel | null): Promise<Lifetime> {
    if (!model)
      return { ttlMs: FALLBACK_PROMPT_CACHE_TTL_MS, likelyMs: FALLBACK_PROMPT_CACHE_TTL_MS };
    let providers: readonly Provider[] | undefined;
    try {
      providers = await this.providers(this.deps.directoryFor(sessionID));
    } catch {
      // Without the catalog, the provider's documented default still applies.
    }
    const lifetime: PromptCacheLifetime = promptCacheLifetimeFor(
      providers,
      model,
      this.deps.learner.snapshot()
    );
    return { ttlMs: lifetime.ttlMs, likelyMs: lifetime.likelyMs ?? lifetime.ttlMs };
  }

  private providers(directory: string | undefined): Promise<readonly Provider[]> {
    const key = directory ?? '';
    const now = this.now();
    const cached = this.catalogs.get(key);
    if (cached && now - cached.readAt < PROVIDER_CATALOG_CACHE_MS) return cached.providers;
    const providers = this.deps.readProviders(directory);
    boundedSet(this.catalogs, key, { providers, readAt: now });
    // A failed read is retried by the next window instead of being cached.
    void providers.catch(() => {
      if (this.catalogs.get(key)?.providers === providers) this.catalogs.delete(key);
    });
    return providers;
  }

  private async ping(sessionID: string, entry: WarmEntry) {
    entry.timer = undefined;
    if (this.disposed || this.entries.get(sessionID) !== entry || entry.warmUntil === null) return;
    const now = this.now();
    if (now >= entry.warmUntil) {
      this.finish(entry, 'expired');
      return;
    }
    // A running turn sends the context itself and will start a new window when it ends.
    if (this.deps.isBusy(sessionID)) return;
    // The last request outlasted the cache, or the timer fired late after the computer slept:
    // a ping would only write a new cache, and the next real request does that anyway. Past the
    // provider's minimum but within its usual lifetime, a ping still probably renews it.
    if (entry.sentAt !== null && entry.likelyMs !== null && now >= entry.sentAt + entry.likelyMs) {
      this.finish(entry, 'cache-miss');
      return;
    }
    if (!this.deps.isAvailable() || this.deps.readMode() !== 'chosen') return;
    if (await this.refreshOpenCodeWarming()) {
      // OpenCode already warms this session; a second ping would only cost more.
      this.finish(entry, null);
      return;
    }
    if (this.entries.get(sessionID) !== entry) return;
    const request = new AbortController();
    entry.request = request;
    try {
      const usage = await this.deps.generate(
        sessionID,
        this.deps.directoryFor(sessionID),
        KEEP_ALIVE_PROMPT,
        request.signal
      );
      if (this.entries.get(sessionID) !== entry || request.signal.aborted) return;
      entry.request = undefined;
      entry.sentAt = now;
      // The keep-alive renewed the cache, so later gaps count from it.
      const model = this.requests.get(sessionID)?.model;
      if (model) boundedSet(this.cacheUses, sessionID, { at: now, model });
      // A ping that wrote more than it read rebuilt the cache instead of keeping it, so later
      // pings would keep paying for that. Providers that report no cache usage never miss.
      if (usage.cacheRead < usage.cacheWrite) {
        this.finish(entry, 'cache-miss');
        return;
      }
      this.schedule(sessionID, entry);
      this.publish();
    } catch (error) {
      if (request.signal.aborted || this.entries.get(sessionID) !== entry) return;
      entry.request = undefined;
      this.deps.logWarning(
        `Prompt cache warming stopped for ${sessionID}: ${error instanceof Error ? error.message : String(error)}`
      );
      this.finish(entry, 'failed');
    }
  }

  private finish(entry: WarmEntry, stopped: WarmEntry['stopped']) {
    entry.stopped = stopped;
    entry.warmUntil = stopped === 'expired' ? entry.warmUntil : null;
    this.publish();
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
      // An unreadable config keeps Varro's own schedule; OpenCode warms only when configured.
      return this.openCodeWarming?.value ?? false;
    }
  }

  private stop(sessionID: string) {
    const entry = this.entries.get(sessionID);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.request?.abort();
    this.entries.delete(sessionID);
  }

  private stopAll() {
    // Deleting the visited key while iterating a Map is safe.
    for (const sessionID of this.entries.keys()) this.stop(sessionID);
  }

  dispose(): void {
    this.disposed = true;
    this.stopAll();
  }
}
