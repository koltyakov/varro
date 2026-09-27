import type { MessageEntry } from '../../types';
import { projectAutomaticActionMessage } from '../message/UserMessageContent';
import type { StreamingLayoutProjection } from './row-layout';

// Activity grouping, row boundaries, and empty-row classification never cross a user message.
// Splitting at the last one lets settled history be derived once while the trailing turn streams.
// History derivations must read history-restricted views of transient trailing-turn state so they
// rerun only when something that can affect a history row actually changes.

export function getHistorySegmentEnd(messages: readonly MessageEntry[]) {
  for (let index = messages.length - 1; index > 0; index -= 1) {
    // Automatic-action prompts render as assistant activity and can join the previous group.
    if (projectAutomaticActionMessage(messages[index]!).info.role === 'user') return index;
  }
  return 0;
}

export function sameEntries<T>(previous: readonly T[], next: readonly T[]) {
  return previous.length === next.length && previous.every((entry, index) => entry === next[index]);
}

export function sameKeys(previous: ReadonlySet<string>, next: ReadonlySet<string>) {
  if (previous.size !== next.size) return false;
  for (const key of next) if (!previous.has(key)) return false;
  return true;
}

export function sameValues<T>(previous: ReadonlyMap<string, T>, next: ReadonlyMap<string, T>) {
  if (previous.size !== next.size) return false;
  for (const [key, value] of next) {
    if (previous.get(key) !== value || (value === undefined && !previous.has(key))) return false;
  }
  return true;
}

/** Restricts `${messageID}\u0000${partID}` keys to parts owned by the given messages. */
export function restrictPartKeys(keys: ReadonlySet<string>, messageIds: ReadonlySet<string>) {
  const restricted = new Set<string>();
  for (const key of keys) {
    const separator = key.indexOf('\u0000');
    if (messageIds.has(separator === -1 ? key : key.slice(0, separator))) restricted.add(key);
  }
  return restricted;
}

export function restrictMessageIds(ids: Iterable<string>, messageIds: ReadonlySet<string>) {
  const restricted = new Set<string>();
  for (const id of ids) if (messageIds.has(id)) restricted.add(id);
  return restricted;
}

export function restrictStreamingProjection(
  projection: StreamingLayoutProjection,
  partIds: ReadonlySet<string>,
  messageIds: ReadonlySet<string>
): StreamingLayoutProjection {
  const owned = projection.partId !== null && partIds.has(projection.partId);
  const restricted: StreamingLayoutProjection = {
    partId: owned ? projection.partId : null,
    text: owned ? projection.text : '',
  };
  if (projection.textByPartId) {
    const textByPartId = new Map<string, string>();
    for (const [partId, text] of projection.textByPartId) {
      if (partIds.has(partId)) textByPartId.set(partId, text);
    }
    restricted.textByPartId = textByPartId;
  }
  if (projection.hiddenPartKeys) {
    restricted.hiddenPartKeys = restrictPartKeys(projection.hiddenPartKeys, messageIds);
  }
  return restricted;
}

export function sameStreamingProjection(
  previous: StreamingLayoutProjection,
  next: StreamingLayoutProjection
) {
  return (
    previous.partId === next.partId &&
    previous.text === next.text &&
    (previous.textByPartId === next.textByPartId ||
      (!!previous.textByPartId &&
        !!next.textByPartId &&
        sameValues(previous.textByPartId, next.textByPartId))) &&
    (previous.hiddenPartKeys === next.hiddenPartKeys ||
      (!!previous.hiddenPartKeys &&
        !!next.hiddenPartKeys &&
        sameKeys(previous.hiddenPartKeys, next.hiddenPartKeys)))
  );
}

/** Joins per-message results in transcript order: every history message precedes the tail. */
export function mergeSegmentMaps<T>(history: ReadonlyMap<string, T>, tail: ReadonlyMap<string, T>) {
  const merged = new Map(history);
  for (const [messageId, value] of tail) merged.set(messageId, value);
  return merged;
}
