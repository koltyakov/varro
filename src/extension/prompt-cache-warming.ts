/* oxlint-disable anti-slop/no-runtime-typeof -- Persisted IDs and raw server event fields are validated at this boundary. */
import type {
  PromptCacheWarmingMode,
  PromptCacheWarmingSession,
  PromptCacheWarmingState,
  ServerEvent,
} from '../shared/protocol';
import type { Persistence } from '../shared/persistence';
import { asRecord } from '../shared/type-utils';

/**
 * OpenCode's own keep-alive prompt. Its warming plugin ignores a request with exactly this text,
 * so a Varro ping never restarts OpenCode's schedule when both are configured.
 */
export const KEEP_ALIVE_PROMPT =
  'This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK';
/** OpenCode's fallback for models without a cache TTL: a little under the common 5 minutes. */
export const PROMPT_CACHE_PING_INTERVAL_MS = 4 * 60_000;
/** Most providers keep an idle prompt cache about this long after the request that used it. */
const PROMPT_CACHE_TTL_ESTIMATE_MS = 5 * 60_000;
const CHOSEN_SESSIONS_KEY = 'varro.promptCacheWarming.sessions';
const MAX_CHOSEN_SESSIONS = 50;
const MAX_TRACKED_TURN_ENDS = 200;
const OPENCODE_WARMING_CACHE_MS = 60_000;

export type PromptCacheWarmingUsage = { cacheRead: number; cacheWrite: number };

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
  /** Whether OpenCode's effective config already warms every session. */
  readOpenCodeWarming(): Promise<boolean>;
  writeOpenCodeWarming(value: true | { duration: string } | null): Promise<void>;
  persistence: Persistence;
  post(state: PromptCacheWarmingState): void;
  logWarning(message: string): void;
  now?: () => number;
}

type WarmEntry = {
  /** End of the warming window; `null` while waiting for a turn to finish. */
  warmUntil: number | null;
  /** When the latest turn or ping sent the context, which is when its cache lifetime starts. */
  sentAt: number | null;
  stopped: PromptCacheWarmingSession['stopped'];
  timer?: ReturnType<typeof setTimeout>;
  request?: AbortController;
};

/**
 * Keeps chosen sessions' provider prompt caches alive while they sit idle, by sending OpenCode's
 * transient `/generate` keep-alive just before the cache would expire. "All sessions" mode is
 * delegated to OpenCode's own `warming` config instead, so it also covers the TUI and closed windows.
 */
export class PromptCacheWarming {
  private readonly chosen: Set<string>;
  private readonly entries = new Map<string, WarmEntry>();
  private readonly turnEnds = new Map<string, number>();
  private openCodeWarming: { value: boolean; readAt: number } | null = null;
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
          stopped: entry?.stopped ?? null,
        };
      }
    }
    return {
      available: this.deps.isAvailable(),
      mode,
      durationMs: this.deps.readDurationMs(),
      intervalMs: PROMPT_CACHE_PING_INTERVAL_MS,
      openCodeWarming: this.openCodeWarming?.value ?? false,
      sessions,
    };
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
    if (!sessionID || (event.type !== 'session.status' && event.type !== 'session.idle')) return;
    const status = asRecord(properties?.status)?.type;
    if (event.type === 'session.status' && (status === 'busy' || status === 'retry')) {
      this.turnEnds.delete(sessionID);
      if (!this.chosen.has(sessionID)) return;
      // A real request replaces the warming window; the next turn end starts a new one.
      this.stop(sessionID);
      this.entries.set(sessionID, { warmUntil: null, sentAt: null, stopped: null });
      this.publish();
      return;
    }
    if (event.type === 'session.status' && status !== 'idle') return;
    const now = this.now();
    this.turnEnds.delete(sessionID);
    this.turnEnds.set(sessionID, now);
    while (this.turnEnds.size > MAX_TRACKED_TURN_ENDS) {
      const oldest = this.turnEnds.keys().next().value;
      if (oldest === undefined) break;
      this.turnEnds.delete(oldest);
    }
    if (!this.chosen.has(sessionID)) return;
    this.startWindow(sessionID, now);
    this.publish();
  }

  /** A newly chosen session is warmed at once only when its last turn ended recently enough. */
  private startFromLastTurn(sessionID: string) {
    const endedAt = this.turnEnds.get(sessionID);
    if (
      endedAt !== undefined &&
      !this.deps.isBusy(sessionID) &&
      this.now() - endedAt < PROMPT_CACHE_TTL_ESTIMATE_MS
    ) {
      this.startWindow(sessionID, endedAt);
      return;
    }
    this.stop(sessionID);
    this.entries.set(sessionID, { warmUntil: null, sentAt: null, stopped: null });
  }

  private startWindow(sessionID: string, sentAt: number) {
    this.stop(sessionID);
    if (this.deps.readMode() !== 'chosen') return;
    const entry: WarmEntry = {
      warmUntil: sentAt + this.deps.readDurationMs(),
      sentAt,
      stopped: null,
    };
    this.entries.set(sessionID, entry);
    this.schedule(sessionID, entry);
  }

  private schedule(sessionID: string, entry: WarmEntry) {
    if (entry.warmUntil === null || entry.sentAt === null) return;
    const due = Math.min(entry.sentAt + PROMPT_CACHE_PING_INTERVAL_MS, entry.warmUntil);
    entry.timer = setTimeout(() => void this.ping(sessionID, entry), Math.max(0, due - this.now()));
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
