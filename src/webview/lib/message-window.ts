import { createSignal } from 'solid-js';
import type { MessageEntry } from '../types';

export const MESSAGE_HISTORY_WINDOW = 50;

type HistoryPage = MessageEntry[] & { nextCursor?: string };

const [truncatedSessionIds, setTruncatedSessionIds] = createSignal<ReadonlySet<string>>(
  new Set<string>()
);
const historyCursors = new Map<string, string>();
const historyPromptCursors = new Map<string, string>();
const prefetchedHistoryPages = new Map<string, Map<string, HistoryPage>>();
const [prefetchedHistoryVersion, setPrefetchedHistoryVersion] = createSignal(0);
const [historyPromptsBySession, setHistoryPromptsBySession] = createSignal<
  ReadonlyMap<string, MessageEntry[]>
>(new Map());

export function getSessionHistoryPrompts(sessionId: string | null | undefined): MessageEntry[] {
  return sessionId ? (historyPromptsBySession().get(sessionId) ?? []) : [];
}

export function setSessionHistoryPrompts(sessionId: string, prompts: MessageEntry[]) {
  const next = new Map(historyPromptsBySession());
  if (prompts.length > 0) next.set(sessionId, prompts);
  else next.delete(sessionId);
  setHistoryPromptsBySession(next);
}

export function getSessionHistoryPromptCursor(sessionId: string): string | undefined {
  return historyPromptCursors.get(sessionId);
}

export function setSessionHistoryPromptCursor(sessionId: string, cursor?: string) {
  if (cursor) historyPromptCursors.set(sessionId, cursor);
  else historyPromptCursors.delete(sessionId);
}

export function cacheSessionHistoryPage(
  sessionId: string,
  beforeCursor: string,
  page: HistoryPage
) {
  const pages = prefetchedHistoryPages.get(sessionId) ?? new Map<string, HistoryPage>();
  pages.set(beforeCursor, page);
  prefetchedHistoryPages.set(sessionId, pages);
  setPrefetchedHistoryVersion((version) => version + 1);
}

export function getPrefetchedSessionHistory(sessionId: string | null | undefined): MessageEntry[] {
  prefetchedHistoryVersion();
  if (!sessionId) return [];
  const pages = prefetchedHistoryPages.get(sessionId);
  if (!pages) return [];

  let history: MessageEntry[] = [];
  for (const page of pages.values()) history = mergeOlderHistory(history, page);
  return history;
}

export function takeCachedSessionHistoryPage(
  sessionId: string,
  beforeCursor: string
): HistoryPage | undefined {
  const pages = prefetchedHistoryPages.get(sessionId);
  const page = pages?.get(beforeCursor);
  if (!page) return undefined;
  pages!.delete(beforeCursor);
  if (pages!.size === 0) prefetchedHistoryPages.delete(sessionId);
  setPrefetchedHistoryVersion((version) => version + 1);
  return page;
}

export function clearCachedSessionHistoryPages(sessionId: string) {
  if (prefetchedHistoryPages.delete(sessionId)) {
    setPrefetchedHistoryVersion((version) => version + 1);
  }
}

export function isSessionHistoryTruncated(sessionId: string | null | undefined): boolean {
  return !!sessionId && truncatedSessionIds().has(sessionId);
}

export function markSessionHistoryTruncated(sessionId: string, truncated: boolean) {
  const current = truncatedSessionIds();
  if (current.has(sessionId) === truncated) return;
  const next = new Set(current);
  if (truncated) next.add(sessionId);
  else next.delete(sessionId);
  setTruncatedSessionIds(next);
}

export function getSessionHistoryCursor(sessionId: string): string | undefined {
  return historyCursors.get(sessionId);
}

export function setSessionHistoryCursor(sessionId: string, cursor?: string) {
  if (cursor) historyCursors.set(sessionId, cursor);
  else historyCursors.delete(sessionId);
  markSessionHistoryTruncated(sessionId, !!cursor);
}

export function resetMessageWindowState() {
  historyCursors.clear();
  historyPromptCursors.clear();
  prefetchedHistoryPages.clear();
  setPrefetchedHistoryVersion(0);
  setTruncatedSessionIds(new Set<string>());
  setHistoryPromptsBySession(new Map());
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
