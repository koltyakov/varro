import { batch, createSignal } from 'solid-js';
import type { MessageEntry } from '../types';

export const MESSAGE_HISTORY_WINDOW = 200;
export const MESSAGE_HISTORY_CACHE_SESSION_LIMIT = 20;
export const MESSAGE_HISTORY_PAGE_CACHE_LIMIT = 20;
const LOADED_MESSAGE_CACHE_SESSION_LIMIT = 3;

type HistoryPage = MessageEntry[] & { nextCursor?: string };

const [truncatedSessionIds, setTruncatedSessionIds] = createSignal<ReadonlySet<string>>(
  new Set<string>()
);
const [historyLoadFailedSessionIds, setHistoryLoadFailedSessionIds] = createSignal<
  ReadonlySet<string>
>(new Set<string>());
const historyCursors = new Map<string, string>();
const historyPromptCursors = new Map<string, string>();
const consumedHistoryCursors = new Map<string, Set<string>>();
const consumedHistoryPromptCursors = new Map<string, Set<string>>();
// Latest, page, and prompt reads capture this revision before crossing the API boundary.
const messageWindowRevisions = new Map<string, number>();
const pendingMessageWindowResets = new Set<string>();
let nextMessageWindowRevision = 0;
const messageWindowStateVersions = new Map<string, number>();
const [messageWindowStateVersion, setMessageWindowStateVersion] = createSignal(0);
let defaultMessageWindowStateVersion = 0;
let nextMessageWindowStateVersion = 0;
const prefetchedHistoryPages = new Map<string, Map<string, HistoryPage>>();
const loadedMessagesBySession = new Map<string, MessageEntry[]>();
const historySessionRecency = new Map<string, true>();
const historyPageRecency = new Map<string, { sessionId: string; beforeCursor: string }>();
const [prefetchedHistoryVersion, setPrefetchedHistoryVersion] = createSignal(0);
const [historyPromptsBySession, setHistoryPromptsBySession] = createSignal<
  ReadonlyMap<string, MessageEntry[]>
>(new Map());

export function getSessionHistoryPrompts(sessionId: string | null | undefined): MessageEntry[] {
  if (sessionId) touchExistingHistorySession(sessionId);
  return sessionId ? (historyPromptsBySession().get(sessionId) ?? []) : [];
}

export function setSessionHistoryPrompts(sessionId: string, prompts: MessageEntry[]) {
  const next = new Map(historyPromptsBySession());
  if (prompts.length > 0) next.set(sessionId, prompts);
  else next.delete(sessionId);
  setHistoryPromptsBySession(next);
  if (prompts.length > 0) touchHistorySession(sessionId);
}

export function getSessionHistoryPromptCursor(sessionId: string): string | undefined {
  touchExistingHistorySession(sessionId);
  return historyPromptCursors.get(sessionId);
}

export function setSessionHistoryPromptCursor(sessionId: string, cursor?: string) {
  consumedHistoryPromptCursors.delete(sessionId);
  updateSessionHistoryPromptCursor(sessionId, cursor);
}

export function advanceSessionHistoryPromptCursor(
  sessionId: string,
  consumedCursor: string,
  nextCursor?: string
): string | undefined {
  const consumed = consumedHistoryPromptCursors.get(sessionId) ?? new Set<string>();
  consumed.add(consumedCursor);
  const cursor = nextCursor && !consumed.has(nextCursor) ? nextCursor : undefined;
  if (cursor) consumedHistoryPromptCursors.set(sessionId, consumed);
  else consumedHistoryPromptCursors.delete(sessionId);
  updateSessionHistoryPromptCursor(sessionId, cursor);
  return cursor;
}

function updateSessionHistoryPromptCursor(sessionId: string, cursor?: string) {
  if (cursor) {
    historyPromptCursors.set(sessionId, cursor);
    touchHistorySession(sessionId);
  } else historyPromptCursors.delete(sessionId);
}

export function cacheSessionHistoryPage(
  sessionId: string,
  beforeCursor: string,
  page: HistoryPage
) {
  const pages = prefetchedHistoryPages.get(sessionId) ?? new Map<string, HistoryPage>();
  pages.set(beforeCursor, page);
  prefetchedHistoryPages.set(sessionId, pages);
  touchHistorySession(sessionId);
  touchHistoryPage(sessionId, beforeCursor);
  pruneHistoryPageCache();
  setPrefetchedHistoryVersion((version) => version + 1);
}

export function getPrefetchedSessionHistory(sessionId: string | null | undefined): MessageEntry[] {
  prefetchedHistoryVersion();
  if (!sessionId) return [];
  const pages = prefetchedHistoryPages.get(sessionId);
  if (!pages) return [];
  touchHistorySession(sessionId);
  for (const cursor of pages.keys()) touchHistoryPage(sessionId, cursor);

  let history: MessageEntry[] = [];
  for (const page of pages.values()) history = mergeOlderHistory(history, page);
  return history;
}

export function getCachedSessionMessages(sessionId: string): MessageEntry[] {
  const messages = loadedMessagesBySession.get(sessionId) ?? [];
  if (messages.length > 0) {
    loadedMessagesBySession.delete(sessionId);
    loadedMessagesBySession.set(sessionId, messages);
    touchHistorySession(sessionId);
  }
  return messages;
}

export function setCachedSessionMessages(sessionId: string, messages: MessageEntry[]) {
  if (messages.length > 0) {
    loadedMessagesBySession.delete(sessionId);
    loadedMessagesBySession.set(sessionId, messages);
    while (loadedMessagesBySession.size > LOADED_MESSAGE_CACHE_SESSION_LIMIT) {
      const oldestSessionId = loadedMessagesBySession.keys().next().value;
      if (!oldestSessionId) break;
      loadedMessagesBySession.delete(oldestSessionId);
    }
    touchHistorySession(sessionId);
  } else {
    loadedMessagesBySession.delete(sessionId);
  }
}

export function takeCachedSessionHistoryPage(
  sessionId: string,
  beforeCursor: string
): HistoryPage | undefined {
  const pages = prefetchedHistoryPages.get(sessionId);
  const page = pages?.get(beforeCursor);
  if (!page) return undefined;
  pages!.delete(beforeCursor);
  historyPageRecency.delete(getHistoryPageKey(sessionId, beforeCursor));
  if (pages!.size === 0) prefetchedHistoryPages.delete(sessionId);
  touchHistorySession(sessionId);
  setPrefetchedHistoryVersion((version) => version + 1);
  return page;
}

export function clearCachedSessionHistoryPages(sessionId: string) {
  if (prefetchedHistoryPages.delete(sessionId)) {
    clearHistoryPageRecency(sessionId);
    setPrefetchedHistoryVersion((version) => version + 1);
  }
}

export function isSessionHistoryTruncated(sessionId: string | null | undefined): boolean {
  if (sessionId) touchExistingHistorySession(sessionId);
  return !!sessionId && truncatedSessionIds().has(sessionId);
}

export function markSessionHistoryTruncated(sessionId: string, truncated: boolean) {
  const current = truncatedSessionIds();
  if (current.has(sessionId) === truncated) return;
  const next = new Set(current);
  if (truncated) next.add(sessionId);
  else next.delete(sessionId);
  setTruncatedSessionIds(next);
  if (truncated) touchHistorySession(sessionId);
}

export function isSessionHistoryLoadFailed(sessionId: string | null | undefined): boolean {
  if (sessionId) touchExistingHistorySession(sessionId);
  return !!sessionId && historyLoadFailedSessionIds().has(sessionId);
}

export function markSessionHistoryLoadFailed(sessionId: string, failed: boolean) {
  const current = historyLoadFailedSessionIds();
  if (current.has(sessionId) === failed) return;
  const next = new Set(current);
  if (failed) next.add(sessionId);
  else next.delete(sessionId);
  setHistoryLoadFailedSessionIds(next);
  if (failed) touchHistorySession(sessionId);
}

export function getSessionHistoryCursor(sessionId: string): string | undefined {
  touchExistingHistorySession(sessionId);
  return historyCursors.get(sessionId);
}

export function setSessionHistoryCursor(sessionId: string, cursor?: string) {
  consumedHistoryCursors.delete(sessionId);
  updateSessionHistoryCursor(sessionId, cursor);
}

export function advanceSessionHistoryCursor(
  sessionId: string,
  consumedCursor: string,
  nextCursor?: string
): string | undefined {
  const consumed = consumedHistoryCursors.get(sessionId) ?? new Set<string>();
  consumed.add(consumedCursor);
  const cursor = nextCursor && !consumed.has(nextCursor) ? nextCursor : undefined;
  if (cursor) consumedHistoryCursors.set(sessionId, consumed);
  else consumedHistoryCursors.delete(sessionId);
  updateSessionHistoryCursor(sessionId, cursor);
  return cursor;
}

function updateSessionHistoryCursor(sessionId: string, cursor?: string) {
  if (cursor) {
    historyCursors.set(sessionId, cursor);
    touchHistorySession(sessionId);
  } else historyCursors.delete(sessionId);
  markSessionHistoryTruncated(sessionId, !!cursor);
}

export function clearSessionMessageWindowState(sessionId: string) {
  batch(() => clearSessionMessageWindowStateInternal(sessionId));
}

export function resetSessionMessageWindowForRefetch(sessionId: string) {
  batch(() => {
    clearSessionMessageWindowStateInternal(sessionId);
    pendingMessageWindowResets.add(sessionId);
  });
}

export function isSessionMessageWindowResetPending(sessionId: string): boolean {
  return pendingMessageWindowResets.has(sessionId);
}

export function getSessionMessageWindowRevision(sessionId: string): number {
  return messageWindowRevisions.get(sessionId) ?? 0;
}

export function getSessionMessageWindowStateVersion(sessionId: string): number {
  messageWindowStateVersion();
  return messageWindowStateVersions.get(sessionId) ?? defaultMessageWindowStateVersion;
}

export function invalidateSessionMessageWindowRequests(sessionId: string) {
  messageWindowRevisions.set(sessionId, ++nextMessageWindowRevision);
}

export function resetMessageWindowState() {
  historyCursors.clear();
  historyPromptCursors.clear();
  consumedHistoryCursors.clear();
  consumedHistoryPromptCursors.clear();
  messageWindowRevisions.clear();
  pendingMessageWindowResets.clear();
  nextMessageWindowRevision = 0;
  messageWindowStateVersions.clear();
  defaultMessageWindowStateVersion = ++nextMessageWindowStateVersion;
  setMessageWindowStateVersion((version) => version + 1);
  prefetchedHistoryPages.clear();
  loadedMessagesBySession.clear();
  historySessionRecency.clear();
  historyPageRecency.clear();
  setPrefetchedHistoryVersion(0);
  setTruncatedSessionIds(new Set<string>());
  setHistoryLoadFailedSessionIds(new Set<string>());
  setHistoryPromptsBySession(new Map());
}

function touchExistingHistorySession(sessionId: string) {
  if (
    historyCursors.has(sessionId) ||
    historyPromptCursors.has(sessionId) ||
    prefetchedHistoryPages.has(sessionId) ||
    loadedMessagesBySession.has(sessionId) ||
    historyPromptsBySession().has(sessionId) ||
    truncatedSessionIds().has(sessionId) ||
    historyLoadFailedSessionIds().has(sessionId)
  ) {
    touchHistorySession(sessionId);
  }
}

function touchHistorySession(sessionId: string) {
  historySessionRecency.delete(sessionId);
  historySessionRecency.set(sessionId, true);
  while (historySessionRecency.size > MESSAGE_HISTORY_CACHE_SESSION_LIMIT) {
    const oldest = historySessionRecency.keys().next().value;
    if (!oldest) break;
    clearSessionMessageWindowStateInternal(oldest);
  }
}

function touchHistoryPage(sessionId: string, beforeCursor: string) {
  const key = getHistoryPageKey(sessionId, beforeCursor);
  historyPageRecency.delete(key);
  historyPageRecency.set(key, { sessionId, beforeCursor });
}

function pruneHistoryPageCache() {
  while (historyPageRecency.size > MESSAGE_HISTORY_PAGE_CACHE_LIMIT) {
    const oldestKey = historyPageRecency.keys().next().value;
    if (!oldestKey) break;
    const oldest = historyPageRecency.get(oldestKey);
    historyPageRecency.delete(oldestKey);
    if (!oldest) continue;
    const pages = prefetchedHistoryPages.get(oldest.sessionId);
    pages?.delete(oldest.beforeCursor);
    if (pages?.size === 0) prefetchedHistoryPages.delete(oldest.sessionId);
  }
}

function clearSessionMessageWindowStateInternal(sessionId: string) {
  invalidateSessionMessageWindowRequests(sessionId);
  messageWindowStateVersions.set(sessionId, ++nextMessageWindowStateVersion);
  setMessageWindowStateVersion((version) => version + 1);
  historyCursors.delete(sessionId);
  historyPromptCursors.delete(sessionId);
  consumedHistoryCursors.delete(sessionId);
  consumedHistoryPromptCursors.delete(sessionId);
  pendingMessageWindowResets.delete(sessionId);
  historySessionRecency.delete(sessionId);
  const removedPages = prefetchedHistoryPages.delete(sessionId);
  loadedMessagesBySession.delete(sessionId);
  clearHistoryPageRecency(sessionId);

  const prompts = historyPromptsBySession();
  if (prompts.has(sessionId)) {
    const next = new Map(prompts);
    next.delete(sessionId);
    setHistoryPromptsBySession(next);
  }
  const truncated = truncatedSessionIds();
  if (truncated.has(sessionId)) {
    const next = new Set(truncated);
    next.delete(sessionId);
    setTruncatedSessionIds(next);
  }
  const failed = historyLoadFailedSessionIds();
  if (failed.has(sessionId)) {
    const next = new Set(failed);
    next.delete(sessionId);
    setHistoryLoadFailedSessionIds(next);
  }
  if (removedPages) setPrefetchedHistoryVersion((version) => version + 1);
}

function clearHistoryPageRecency(sessionId: string) {
  for (const [key, page] of historyPageRecency) {
    if (page.sessionId === sessionId) historyPageRecency.delete(key);
  }
}

function getHistoryPageKey(sessionId: string, beforeCursor: string) {
  return JSON.stringify([sessionId, beforeCursor]);
}

// Windowed refetches only return the most recent messages; older entries that
// are already loaded must survive the resync, so stitch them back in front
// when the fetched window overlaps the current list.
export function mergeWindowedHistory(
  current: MessageEntry[],
  incoming: MessageEntry[]
): MessageEntry[] {
  if (incoming.length === 0 || current.length === 0) return incoming;
  const first = incoming[0]!;
  const index = current.findIndex(
    (entry) => entry.info.id === first.info.id && entry.info.sessionID === first.info.sessionID
  );
  if (index <= 0) return incoming;
  return [...current.slice(0, index), ...incoming];
}

export function mergeOlderHistory(current: MessageEntry[], older: MessageEntry[]): MessageEntry[] {
  if (older.length === 0) return current;
  const currentKeys = new Set(
    current.map((entry) => `${entry.info.sessionID}\u0000${entry.info.id}`)
  );
  return [
    ...older.filter((entry) => !currentKeys.has(`${entry.info.sessionID}\u0000${entry.info.id}`)),
    ...current,
  ];
}
