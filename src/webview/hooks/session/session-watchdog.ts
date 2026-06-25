import { createEffect, on, onCleanup } from 'solid-js';
import type { AssistantMessage, Message, Part, SessionStatus } from '../../types';

type MessageEntry = { info: Message; parts: Part[] };

// How often the watchdog polls server-authoritative status while at least one
// session looks busy locally. Tuned short so a missed finish (e.g. a fast ping
// whose idle/step.ended events never arrived) recovers within ~one poll; this
// mirrors opencode's stream-transport, which polls `/session/status` while a
// turn is armed rather than relying on the SSE event alone.
export const STUCK_SESSION_WATCHDOG_INTERVAL_MS = 1_000;
// How long the server must *continuously* report a session idle (while the UI
// still shows it busy) before we force a reconcile, when there is NO local
// evidence the turn finished (no loaded assistant message, no streamed text).
// Requiring it to persist protects against momentary races. A false reconcile
// is self-correcting (the next progress event re-marks the session busy),
// whereas a missed completion is permanent, so this is tuned for prompt
// recovery with a small safety margin.
export const STUCK_SESSION_GRACE_MS = 2_000;
// Reduced grace (zero) used when local evidence says the turn is already done
// — the latest assistant message is settled (completed/errored) or it streamed
// its final text with no tools in flight — even though the closing status
// event was missed. The server-idle confirmation is still required, but we no
// longer demand it persist, so recovery happens on the first poll instead of
// after the full grace window.
export const STUCK_SESSION_STREAMED_GRACE_MS = 0;

function isRunningStatus(status: SessionStatus | null | undefined): boolean {
  return status?.type === 'busy' || status?.type === 'retry';
}

export type StuckSessionReconcileDeps = {
  /** Server-authoritative statuses (REST `/session/status`), independent of the SSE stream. */
  loadSessionStatuses(): Promise<Record<string, SessionStatus>>;
  /** The webview's current view of per-session status. */
  getLocalSessionStatuses(): Record<string, SessionStatus>;
  /** The currently focused session, whose spinner may be driven by `isLoading`. */
  getActiveSessionId(): string | null | undefined;
  /**
   * The webview's global loading flag. The active session's "Thinking..."
   * indicator is driven by this (see `isActiveSessionWorking`), and it can be
   * left on when a completion event is missed even though no session status is
   * busy. The watchdog folds the active session in as a candidate in that case
   * so orphaned loading states are recovered, not just busy statuses.
   */
  isLoading(): boolean;
  /** Sessions paused on a permission/question prompt legitimately show as working. */
  isAwaitingInput(sessionId: string): boolean;
  /** The abort flow owns its own busy->idle transition; don't fight it. */
  hasPendingAbort(sessionId: string): boolean;
  forceReconcileIdleSession(sessionId: string): Promise<void>;
  logError(context: string, err: unknown): void;
  /** Loaded messages for the active tree; used to detect streamed completion. */
  getMessages(): MessageEntry[];
  /**
   * The active streaming buffer (partId + accumulated text). Text is kept here
   * until the completion event commits it to the message part, so when that
   * event is missed the watchdog must look here for evidence the turn streamed.
   */
  getStreamingText(): { partId: string | null; text: string };
};

/**
 * Compares the webview's busy sessions against server-authoritative status. Any
 * session the server has reported idle/absent for at least `graceMs` while the
 * UI still shows it busy is declared stuck and force-reconciled. `stuckSince`
 * persists across calls so the grace window spans multiple polls. When a session
 * shows local evidence its final response already streamed (`streamedGraceMs`),
 * that grace collapses so recovery happens on the first server-idle poll.
 */
export async function reconcileStuckSessionsWithDependencies(
  deps: StuckSessionReconcileDeps,
  stuckSince: Map<string, number>,
  now: number = Date.now(),
  graceMs: number = STUCK_SESSION_GRACE_MS,
  streamedGraceMs: number = STUCK_SESSION_STREAMED_GRACE_MS
): Promise<void> {
  const local = deps.getLocalSessionStatuses();
  const candidates = new Set<string>(
    Object.keys(local).filter((sessionId) => isRunningStatus(local[sessionId]))
  );
  // The active session's spinner is also driven by the global loading flag,
  // which can be left on when a completion event is missed even though no
  // session status is busy. Treat it as a candidate so the watchdog recovers
  // orphaned loading states too — not just stale busy statuses.
  if (deps.isLoading()) {
    const activeSessionId = deps.getActiveSessionId();
    if (activeSessionId) candidates.add(activeSessionId);
  }
  if (candidates.size === 0) {
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

  const messages = deps.getMessages();
  const stillTracked = new Set<string>();
  for (const sessionId of candidates) {
    if (deps.hasPendingAbort(sessionId) || deps.isAwaitingInput(sessionId)) continue;
    if (isRunningStatus(serverStatuses[sessionId])) continue;

    // When local evidence says the turn is already done (settled assistant, or
    // streamed final text with no tools in flight), collapse the grace so we
    // reconcile on the first server-idle confirmation instead of waiting out
    // the full window tuned for the no-evidence case. This is the fast path for
    // missed finishes on short turns (ping-style) whose idle/step.ended events
    // never arrived.
    const effectiveGrace = hasLocalEvidenceTurnDone(messages, sessionId, deps.getStreamingText())
      ? streamedGraceMs
      : graceMs;
    const since = stuckSince.get(sessionId);
    if (since === undefined) {
      if (effectiveGrace > 0) {
        stuckSince.set(sessionId, now);
        stillTracked.add(sessionId);
        continue;
      }
    } else if (now - since < effectiveGrace) {
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

/**
 * Strong local evidence that the latest assistant turn for `sessionId` finished
 * streaming even though its completion was never stamped: the latest message is
 * an unsettled assistant turn that produced a non-empty text part and has no
 * tool part still pending or running. Used to shorten the watchdog grace.
 */
export function hasStreamedFinalResponse(
  messages: MessageEntry[],
  sessionId: string,
  streaming?: { partId: string | null; text: string } | null
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry || entry.info.sessionID !== sessionId) continue;
    if (entry.info.role !== 'assistant') return false;
    const info = entry.info as AssistantMessage;
    if (info.error || info.time.completed) return false;
    const hasCommittedText = entry.parts.some(
      (part) => part.type === 'text' && part.text.trim().length > 0
    );
    // Text may still be buffered in the streaming state if the completion
    // event that would commit it (session.next.text.ended) was missed. Treat
    // non-empty buffered text for a part of this message as equivalent
    // evidence — it collapses the watchdog grace for prompt recovery.
    const hasBufferedText =
      !!streaming &&
      !!streaming.partId &&
      streaming.text.trim().length > 0 &&
      entry.parts.some((part) => part.id === streaming.partId);
    if (!hasCommittedText && !hasBufferedText) return false;
    return !entry.parts.some(
      (part) =>
        part.type === 'tool' && (part.state.status === 'pending' || part.state.status === 'running')
    );
  }
  return false;
}

/**
 * Strong local evidence the latest turn for `sessionId` has finished, even when
 * its closing status event was missed: the latest assistant message is already
 * settled (completed or errored), or — if still unsettled — it streamed its
 * final text with no tools in flight. The watchdog uses this to collapse its
 * grace window so a missed finish on a short turn (e.g. a ping whose idle /
 * step.ended events never arrived) recovers on the first server-idle poll.
 *
 * `hasStreamedFinalResponse` alone returns false once the assistant message is
 * settled, which would wrongly push a completed-but-still-busy session back
 * onto the long no-evidence grace; this wrapper treats a settled latest
 * assistant as the strongest possible "done" signal.
 */
export function hasLocalEvidenceTurnDone(
  messages: MessageEntry[],
  sessionId: string,
  streaming?: { partId: string | null; text: string } | null
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry || entry.info.sessionID !== sessionId) continue;
    if (entry.info.role !== 'assistant') return false;
    const info = entry.info as AssistantMessage;
    if (info.error || info.time.completed) return true;
    return hasStreamedFinalResponse(messages, sessionId, streaming);
  }
  return false;
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
