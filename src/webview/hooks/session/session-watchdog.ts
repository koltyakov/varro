import { createEffect, on, onCleanup } from 'solid-js';
import type { AssistantMessage, Message, Part, SessionStatus } from '../../types';

type MessageEntry = { info: Message; parts: Part[] };

// How often the watchdog polls server-authoritative status while at least one
// session looks busy locally.
export const STUCK_SESSION_WATCHDOG_INTERVAL_MS = 4_000;
// How long the server must *continuously* report a session idle (while the UI
// still shows it busy) before we force a reconcile. Requiring the disagreement
// to persist across multiple polls protects against momentary races between
// agentic steps. A false reconcile is self-correcting (the next progress event
// re-marks the session busy), whereas a missed completion is permanent, so this
// is tuned for prompt recovery with a safety margin.
export const STUCK_SESSION_GRACE_MS = 8_000;

function isRunningStatus(status: SessionStatus | null | undefined): boolean {
  return status?.type === 'busy' || status?.type === 'retry';
}

export type StuckSessionReconcileDeps = {
  /** Server-authoritative statuses (REST `/session/status`), independent of the SSE stream. */
  loadSessionStatuses(): Promise<Record<string, SessionStatus>>;
  /** The webview's current view of per-session status. */
  getLocalSessionStatuses(): Record<string, SessionStatus>;
  /** Sessions paused on a permission/question prompt legitimately show as working. */
  isAwaitingInput(sessionId: string): boolean;
  /** The abort flow owns its own busy->idle transition; don't fight it. */
  hasPendingAbort(sessionId: string): boolean;
  forceReconcileIdleSession(sessionId: string): Promise<void>;
  logError(context: string, err: unknown): void;
};

/**
 * Compares the webview's busy sessions against server-authoritative status. Any
 * session the server has reported idle/absent for at least `graceMs` while the
 * UI still shows it busy is declared stuck and force-reconciled. `stuckSince`
 * persists across calls so the grace window spans multiple polls.
 */
export async function reconcileStuckSessionsWithDependencies(
  deps: StuckSessionReconcileDeps,
  stuckSince: Map<string, number>,
  now: number = Date.now(),
  graceMs: number = STUCK_SESSION_GRACE_MS
): Promise<void> {
  const local = deps.getLocalSessionStatuses();
  const locallyBusy = Object.keys(local).filter((sessionId) => isRunningStatus(local[sessionId]));
  if (locallyBusy.length === 0) {
    stuckSince.clear();
    return;
  }

  let serverStatuses: Record<string, SessionStatus>;
  try {
    serverStatuses = await deps.loadSessionStatuses();
  } catch (err) {
    deps.logError('stuckSessionWatchdog', err);
    return;
  }

  const stillTracked = new Set<string>();
  for (const sessionId of locallyBusy) {
    if (deps.hasPendingAbort(sessionId) || deps.isAwaitingInput(sessionId)) continue;
    if (isRunningStatus(serverStatuses[sessionId])) continue;

    const since = stuckSince.get(sessionId);
    if (since === undefined) {
      stuckSince.set(sessionId, now);
      stillTracked.add(sessionId);
      continue;
    }
    if (now - since < graceMs) {
      stillTracked.add(sessionId);
      continue;
    }
    stuckSince.delete(sessionId);
    try {
      await deps.forceReconcileIdleSession(sessionId);
    } catch (err) {
      deps.logError('forceReconcileIdleSession', err);
    }
  }

  for (const sessionId of Array.from(stuckSince.keys())) {
    if (!stillTracked.has(sessionId)) stuckSince.delete(sessionId);
  }
}

export type ForceReconcileIdleSessionDeps = {
  setSessionStatusEntry(sessionId: string, status: SessionStatus): void;
  clearPendingAbort(sessionId: string): void;
  updateUsageLimitState(sessionId: string, status: SessionStatus | null | undefined): void;
  /** Pulls the authoritative final message/tool state from the server. */
  syncSessionMessages(sessionId: string): Promise<void>;
  /** Stamps `time.completed` on the latest assistant message if it never settled. */
  settleLatestAssistantMessage(sessionId: string): void;
  isActiveSession(sessionId: string): boolean;
  isTreeWorking(sessionId: string): boolean;
  stopLoading(): void;
  logError(context: string, err: unknown): void;
};

/**
 * Recovers a session the server has confirmed idle. Flips the local status to
 * idle, resyncs messages from the server (authoritative completion + tool
 * results), then — as a last resort for servers that never stamp completion —
 * settles the latest assistant message locally so all message-gated UI
 * converges. Finally stops the chat spinner when nothing in the tree is working.
 */
export async function forceReconcileIdleSessionWithDependencies(
  deps: ForceReconcileIdleSessionDeps,
  sessionId: string
): Promise<void> {
  deps.clearPendingAbort(sessionId);
  deps.setSessionStatusEntry(sessionId, { type: 'idle' });
  deps.updateUsageLimitState(sessionId, { type: 'idle' });
  try {
    await deps.syncSessionMessages(sessionId);
  } catch (err) {
    deps.logError('forceReconcileIdleSync', err);
  }
  deps.settleLatestAssistantMessage(sessionId);
  if (deps.isActiveSession(sessionId) && !deps.isTreeWorking(sessionId)) {
    deps.stopLoading();
  }
}

/**
 * Returns the latest assistant message for the session that has neither
 * completed nor errored (i.e. it is stuck mid-stream), or null when the latest
 * assistant message is already settled or the latest message isn't an assistant.
 */
export function selectUnsettledLatestAssistant(
  messages: MessageEntry[],
  sessionId: string
): AssistantMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry || entry.info.sessionID !== sessionId) continue;
    if (entry.info.role !== 'assistant') return null;
    const info = entry.info as AssistantMessage;
    if (info.error || info.time.completed) return null;
    return info;
  }
  return null;
}

export function registerStuckSessionWatchdogEffect(deps: {
  getServerState(): string;
  isDocumentVisible(): boolean;
  hasBusySession(): boolean;
  runReconcile(): Promise<void>;
}) {
  createEffect(
    on(
      () =>
        deps.getServerState() === 'running' && deps.isDocumentVisible() && deps.hasBusySession(),
      (active) => {
        if (!active) return;
        let cancelled = false;
        let inFlight = false;
        const tick = async () => {
          if (cancelled || inFlight) return;
          inFlight = true;
          try {
            await deps.runReconcile();
          } finally {
            inFlight = false;
          }
        };
        const timer = window.setInterval(() => void tick(), STUCK_SESSION_WATCHDOG_INTERVAL_MS);
        onCleanup(() => {
          cancelled = true;
          window.clearInterval(timer);
        });
      }
    )
  );
}
