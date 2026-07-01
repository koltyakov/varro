import { createSignal } from 'solid-js';
import type { Message, Part } from '../types';

export const MESSAGE_HISTORY_WINDOW = 200;

type MessageEntry = { info: Message; parts: Part[] };

const [truncatedSessionIds, setTruncatedSessionIds] = createSignal<ReadonlySet<string>>(
  new Set<string>()
);
const fullHistorySessionIds = new Set<string>();

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

export function requestFullMessageHistory(sessionId: string) {
  fullHistorySessionIds.add(sessionId);
}

export function hasFullMessageHistory(sessionId: string): boolean {
  return fullHistorySessionIds.has(sessionId);
}

export function resetMessageWindowState() {
  fullHistorySessionIds.clear();
  setTruncatedSessionIds(new Set<string>());
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
