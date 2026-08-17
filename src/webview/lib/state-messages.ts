import { batch } from 'solid-js';
import { produce } from 'solid-js/store';
import type { AssistantMessage, Message, MessageEntry, Part } from '../types';
import {
  defaultAppState,
  messageIndex,
  messageStructureVersion,
  setState,
  showSessionPicker,
  state,
  streamingDeltaQueue,
} from './app-state';
import { areMessageEntriesEquivalent, getSharedMessagePrefixLength } from './message-entry-sync';
import { markSessionResponseCompleted, markSessionSeen } from './state-session-lifecycle';
import { flushPendingStreamingDeltasFor, shouldUseStreamingText } from './streaming-deltas';

const EMPTY_CHILD_RUNS_BY_PARENT_ID = new Map<string, Array<MessageEntry<AssistantMessage>>>();
const OPTIMISTIC_USER_MESSAGE_ID_PREFIX = 'optimistic-user-';
// Canonical parts can replace local part IDs before an older transcript request resolves.
const pendingOptimisticUserMessageKeys = new Set<string>();

let cachedChildRunsByParentIdMessages: MessageEntry[] | null = null;
let cachedChildRunsByParentIdVersion = -1;
let cachedChildRunsByParentId = EMPTY_CHILD_RUNS_BY_PARENT_ID;

function flushPendingStreamingDeltas() {
  flushPendingStreamingDeltasFor(defaultAppState);
}

export function upsertMessage(msg: MessageEntry) {
  flushPendingStreamingDeltas();
  if (isOptimisticUserMessage(msg) && !isOptimisticUserMessageId(msg.info.id)) {
    trackPendingOptimisticUserMessage(msg.info.sessionID, msg.info.id);
  }
  setState(
    'messages',
    produce((msgs) => {
      const idx = messageIndex.findMessageIndex(msgs, msg.info.id);
      if (idx !== -1) {
        if (areMessageEntriesEquivalent(msgs[idx]!, msg)) return;
        msgs[idx] = msg;
        messageIndex.invalidate();
      } else {
        msgs.push(msg);
        messageIndex.invalidate();
      }
    })
  );
}

export function upsertMessageInfo(info: Message) {
  setState(
    'messages',
    produce((msgs) => {
      const idx = messageIndex.findMessageIndex(msgs, info.id);
      if (idx !== -1) {
        if (isOptimisticUserMessage(msgs[idx]!) && info.role === 'user') {
          const optimisticEntry = msgs[idx]!;
          msgs[idx] = {
            info,
            parts: getAcknowledgedOptimisticParts(optimisticEntry, info),
          };
          messageIndex.invalidate();
          return;
        }
        if (msgs[idx]!.info === info) return;
        msgs[idx]!.info = info;
        messageIndex.invalidate();
        return;
      } else {
        msgs.push({ info, parts: [] });
        messageIndex.invalidate();
      }
    })
  );
}

function getAcknowledgedOptimisticParts(optimisticEntry: MessageEntry, info: Message): Part[] {
  return optimisticEntry.parts.map((part, index) => {
    if (!isImageFilePart(part)) return part;
    return {
      ...cloneValue(part),
      id: getOptimisticImagePartId(info.id, index),
      sessionID: info.sessionID,
      messageID: info.id,
    };
  });
}

function isOptimisticUserMessage(entry: MessageEntry) {
  return (
    entry.info.role === 'user' &&
    (isOptimisticUserMessageId(entry.info.id) ||
      entry.parts.some((part) => isLocalOptimisticPartId(part.id, entry.info.id)))
  );
}

function isOptimisticUserMessageId(id: string) {
  return id.startsWith(OPTIMISTIC_USER_MESSAGE_ID_PREFIX);
}

function isLocalOptimisticPartId(partId: string, messageId: string) {
  return partId.startsWith(`${messageId}-part-`);
}

function getPendingOptimisticUserMessageKey(sessionId: string, messageId: string) {
  return `${sessionId}\0${messageId}`;
}

export function trackPendingOptimisticUserMessage(sessionId: string, messageId: string) {
  pendingOptimisticUserMessageKeys.add(getPendingOptimisticUserMessageKey(sessionId, messageId));
}

export function clearPendingOptimisticUserMessage(sessionId: string, messageId: string) {
  pendingOptimisticUserMessageKeys.delete(getPendingOptimisticUserMessageKey(sessionId, messageId));
}

function isPendingOptimisticUserMessage(entry: MessageEntry) {
  return pendingOptimisticUserMessageKeys.has(
    getPendingOptimisticUserMessageKey(entry.info.sessionID, entry.info.id)
  );
}

export function upsertPart(part: Part) {
  flushPendingStreamingDeltas();
  const nextPart = materializeStreamingTextInPart(part, getStreamingTextSnapshot());
  const msgId = (nextPart as { messageID: string }).messageID;
  batch(() => {
    setState(
      'messages',
      produce((msgs) => {
        const idx = messageIndex.findMessageIndex(msgs, msgId);
        if (idx === -1) return;
        if (isOptimisticUserMessage(msgs[idx]!) && !isLocalOptimisticPartId(nextPart.id, msgId)) {
          const optimisticPartIndex = findMatchingOptimisticPartIndex(msgs[idx]!, nextPart);
          if (optimisticPartIndex !== -1) {
            const currentPart = msgs[idx]!.parts[optimisticPartIndex];
            msgs[idx]!.parts[optimisticPartIndex] = nextPart;
            messageIndex.invalidate();
            if (isPartRenderVisibilityChanged(currentPart, nextPart)) {
              messageIndex.notifyPartContentChange();
            }
            return;
          }
        }
        removeAcknowledgedOptimisticImageFilePart(msgs[idx]!, nextPart);
        const location = messageIndex.findPartLocation(msgs, nextPart.id);
        if (location && location.msgIdx === idx) {
          const currentPart = msgs[idx]!.parts[location.partIdx];
          const mergedPart = mergePartUpdate(currentPart, nextPart);
          msgs[idx]!.parts[location.partIdx] = mergedPart;
          if (
            getAssistantDialogPartSignature(currentPart) !==
              getAssistantDialogPartSignature(mergedPart) ||
            isPartRenderVisibilityChanged(currentPart, mergedPart)
          ) {
            messageIndex.notifyPartContentChange();
          }
          return;
        }
        msgs[idx]!.parts.push(nextPart);
        messageIndex.appendPart(msgs, nextPart.id, {
          msgIdx: idx,
          partIdx: msgs[idx]!.parts.length - 1,
        });
      })
    );
    if (state.streamingPartId === nextPart.id) {
      setState('streamingPartId', null);
      setState('streamingText', '');
    }
  });
}

function findMatchingOptimisticPartIndex(entry: MessageEntry, incoming: Part) {
  const optimisticIndexes = entry.parts.flatMap((part, index) =>
    isLocalOptimisticPartId(part.id, entry.info.id) ? [index] : []
  );
  const exactIndex = optimisticIndexes.find((index) =>
    areMatchingOptimisticParts(entry.parts[index]!, incoming)
  );
  if (exactIndex !== undefined) return exactIndex;

  return optimisticIndexes.find((index) => entry.parts[index]!.type === incoming.type) ?? -1;
}

function areMatchingOptimisticParts(left: Part, right: Part) {
  if (left.type === 'text' && right.type === 'text') return left.text === right.text;
  if (left.type !== 'file' || right.type !== 'file') return false;
  return left.url === right.url && left.mime === right.mime && left.filename === right.filename;
}

function isPartRenderVisibilityChanged(previous: Part | undefined, current: Part) {
  return isPartPotentiallyVisible(previous) !== isPartPotentiallyVisible(current);
}

function isPartPotentiallyVisible(part: Part | undefined) {
  if (!part) return false;
  if (part.type === 'text') return part.text.trim().length > 0;
  if (part.type === 'reasoning') {
    return part.text.replace(/<!--[\s\S]*?-->/g, '').trim().length > 0;
  }
  if (part.type === 'tool') {
    const toolName = part.tool.trim().toLowerCase();
    if (
      toolName.includes('todo') ||
      toolName === 'update_plan' ||
      toolName === 'updateplan' ||
      toolName === 'todowrite'
    ) {
      return false;
    }
    const title = 'title' in part.state ? part.state.title : undefined;
    const normalizedTitle = title?.trim().toLowerCase() ?? '';
    return (
      !normalizedTitle.includes('todo') &&
      normalizedTitle !== 'update plan' &&
      normalizedTitle !== 'updating plan'
    );
  }
  return (
    part.type === 'agent' ||
    part.type === 'retry' ||
    part.type === 'compaction' ||
    part.type === 'subtask' ||
    part.type === 'file'
  );
}

function getAssistantDialogPartSignature(part: Part | undefined): string | null {
  if (!part) return null;
  if (part.type === 'agent') return `agent:${part.name.trim().length > 0}`;
  if (part.type === 'subtask') return 'subtask';
  if (part.type !== 'tool') return null;

  const normalizedTool = part.tool.trim().toLowerCase().split('.').at(-1) || '';
  if (normalizedTool !== 'task') {
    return `tool:${normalizedTool}:${part.state.status === 'running'}`;
  }

  const metadata = 'metadata' in part.state ? part.state.metadata : undefined;
  const metadataSessionId = metadata?.sessionId ?? metadata?.sessionID;
  const description = part.state.input.description;
  const title = 'title' in part.state ? part.state.title : undefined;
  return JSON.stringify([
    normalizedTool,
    part.callID,
    part.sessionID,
    part.messageID,
    part.state.status,
    typeof metadataSessionId === 'string' ? metadataSessionId : '',
    typeof description === 'string' ? description : '',
    typeof title === 'string' ? title : '',
  ]);
}

function mergePartUpdate(current: Part | undefined, incoming: Part): Part {
  if (!current || current.type !== incoming.type) return incoming;
  if (isStreamingTextPart(current) && isStreamingTextPart(incoming)) {
    if (current.text.length <= incoming.text.length) return incoming;
    if (!current.text.startsWith(incoming.text)) return incoming;

    return { ...incoming, text: current.text };
  }
  if (current.type === 'tool' && incoming.type === 'tool') {
    return mergeToolPartUpdate(current, incoming);
  }

  return incoming;
}

function mergeToolPartUpdate(
  current: Extract<Part, { type: 'tool' }>,
  incoming: Extract<Part, { type: 'tool' }>
): Part {
  if (current.callID !== incoming.callID) return incoming;
  if (getToolStateProgressRank(current.state) <= getToolStateProgressRank(incoming.state)) {
    return incoming;
  }

  return current;
}

function getToolStateProgressRank(toolState: Extract<Part, { type: 'tool' }>['state']) {
  switch (toolState.status) {
    case 'pending':
      return 0;
    case 'running':
      return 1;
    case 'completed':
    case 'error':
      return 2;
  }
}

export function updateMessagePart(part: Part) {
  flushPendingStreamingDeltas();
  const partId = part.id;
  setState(
    'messages',
    produce((msgs) => {
      const location = messageIndex.findPartLocation(msgs, partId);
      if (!location) return;
      const msg = msgs[location.msgIdx];
      if (msg) {
        msg.parts[location.partIdx] = part;
        messageIndex.notifyPartContentChange();
      }
    })
  );
}

export function getMessageById(id: string) {
  const index = messageIndex.findMessageIndex(state.messages, id);
  return index === -1 ? null : state.messages[index] || null;
}

export function applyMessagePartDelta(
  messageId: string,
  partId: string,
  delta: string,
  sessionId?: string,
  field = 'text'
) {
  if (field !== 'text' || !delta) return;

  const pending = streamingDeltaQueue.get(partId);
  if (pending && pending.messageId === messageId) {
    streamingDeltaQueue.bump(partId, pending.text + delta);
    streamingDeltaQueue.scheduleFlush();
    return;
  }
  if (pending && pending.messageId !== messageId) {
    flushPendingStreamingDeltas();
  }

  messageIndex.ensureIndex(state.messages);
  const location = messageIndex.getIndexedPartLocation(partId);
  const message =
    location && state.messages[location.msgIdx]?.info.id === messageId
      ? state.messages[location.msgIdx]
      : state.messages.find((item) => item.info.id === messageId);
  if (!message) return;

  const existingPart =
    location && message.parts[location.partIdx]?.id === partId
      ? message.parts[location.partIdx]
      : message.parts.find((item) => item.id === partId);
  const existingText =
    existingPart && (existingPart.type === 'text' || existingPart.type === 'reasoning')
      ? existingPart.text
      : '';
  const currentStreamingText =
    state.streamingPartId === partId ? state.streamingText : existingText;
  streamingDeltaQueue.set({
    messageId,
    partId,
    sessionId,
    text: currentStreamingText + delta,
  });
  streamingDeltaQueue.scheduleFlush();
}

export function finishMessageStreaming(messageId: string) {
  flushPendingStreamingDeltas();
  const partId = state.streamingPartId;
  if (!partId) return;

  const location = messageIndex.findPartLocation(state.messages, partId);
  if (!location) return;

  const message = state.messages[location.msgIdx];
  if (!message || message.info.id !== messageId) return;

  streamingDeltaQueue.reset();
  batch(() => {
    setState('messages', location.msgIdx, 'parts', location.partIdx, (currentPart) => {
      if (currentPart.type !== 'text' && currentPart.type !== 'reasoning') return currentPart;
      if (currentPart.text === state.streamingText) return currentPart;
      return {
        ...currentPart,
        text: state.streamingText,
      };
    });
    setState('streamingPartId', null);
    setState('streamingText', '');
  });
  messageIndex.notifyPartContentChange();
}

export function removeMessagePart(sessionId: string, messageId: string, partId: string) {
  flushPendingStreamingDeltas();
  batch(() => {
    setState(
      'messages',
      produce((msgs) => {
        const idx = messageIndex.findMessageIndex(msgs, messageId);
        if (idx !== -1 && msgs[idx]!.info.sessionID === sessionId) {
          const location = messageIndex.findPartLocation(msgs, partId);
          if (location && location.msgIdx === idx) {
            msgs[idx]!.parts.splice(location.partIdx, 1);
            messageIndex.removePart(msgs, partId, location);
          }
        }
      })
    );
    if (state.streamingPartId === partId) {
      setState('streamingPartId', null);
      setState('streamingText', '');
    }
  });
}

export function clearStreamingState() {
  streamingDeltaQueue.reset();
  batch(() => {
    setState('streamingPartId', null);
    setState('streamingText', '');
  });
}

export function clearMessages() {
  streamingDeltaQueue.reset();
  pendingOptimisticUserMessageKeys.clear();
  batch(() => {
    setState('messages', []);
    setState('todos', []);
    setState('diffs', []);
    setState('streamingPartId', null);
    setState('streamingText', '');
  });
  messageIndex.invalidate();
}

type StreamingTextSnapshot = { partId: string; text: string } | null;

export function replaceMessages(incoming: MessageEntry[]) {
  flushPendingStreamingDeltas();
  const streamingSnapshot = getStreamingTextSnapshot();
  const nextMessages = cloneMessageEntries(incoming);
  materializeStreamingText(nextMessages, streamingSnapshot);
  streamingDeltaQueue.reset();
  batch(() => {
    setState('messages', nextMessages);
    if (state.streamingPartId !== null) setState('streamingPartId', null);
    if (state.streamingText !== '') setState('streamingText', '');
  });
  messageIndex.invalidate();
  recordSettledAssistantMarkers(nextMessages);
}

export function pruneMessagesFrom(sessionId: string, messageId: string): (() => void) | null {
  flushPendingStreamingDeltas();
  const currentMessages = state.messages;
  const previousMessages = cloneMessageEntries(currentMessages);
  materializeStreamingText(previousMessages, getStreamingTextSnapshot());

  const targetIndex = currentMessages.findIndex(
    (entry) => entry.info.sessionID === sessionId && entry.info.id === messageId
  );
  if (targetIndex === -1) return null;

  const retainedMessages = currentMessages.slice(0, targetIndex);
  streamingDeltaQueue.reset();
  batch(() => {
    setState('messages', retainedMessages);
    if (state.streamingPartId !== null) setState('streamingPartId', null);
    if (state.streamingText !== '') setState('streamingText', '');
  });
  messageIndex.invalidate();
  recordSettledAssistantMarkers(retainedMessages);
  return () => replaceMessages(previousMessages);
}

export function setMessagesIncremental(
  incoming: MessageEntry[],
  options?: { preserveExtraParts?: boolean }
) {
  flushPendingStreamingDeltas();
  const current = state.messages;
  incoming = preserveMissingOptimisticUserMessages(current, incoming);
  const streamingSnapshot = getStreamingTextSnapshot();
  if (current === incoming) return;
  if (current.length === 0 || incoming.length === 0) {
    replaceMessages(incoming);
    return;
  }

  const insertion = getMessageInsertion(current, incoming);
  if (insertion) {
    reconcileMessageInsertion(incoming, insertion, options, streamingSnapshot);
    recordSettledAssistantMarkers(incoming);
    return;
  }

  const sharedPrefixLength = getSharedMessagePrefixLength(current, incoming);

  if (sharedPrefixLength === 0) {
    replaceMessages(incoming);
    return;
  }

  streamingDeltaQueue.reset();
  batch(() => {
    if (state.streamingPartId !== null) setState('streamingPartId', null);
    if (state.streamingText !== '') setState('streamingText', '');

    setState(
      'messages',
      produce((msgs) => {
        let changed = false;
        let startIndex = 0;
        while (startIndex < sharedPrefixLength && msgs[startIndex] === incoming[startIndex]) {
          startIndex += 1;
        }

        for (let i = startIndex; i < incoming.length; i++) {
          const next = incoming[i]!;
          const currentEntry = msgs[i];
          if (
            currentEntry &&
            areMessageEntriesEquivalent(currentEntry, next) &&
            !hasExtraMessagePartsToPreserve(currentEntry, next, options) &&
            !hasStreamingTextToMaterialize(currentEntry, next, options, streamingSnapshot)
          ) {
            continue;
          }

          const nextEntry = mergeMessageEntry(currentEntry, next, options, streamingSnapshot);
          if (i < sharedPrefixLength) {
            if (!areMessageEntriesEquivalent(currentEntry!, nextEntry)) {
              msgs[i] = nextEntry;
              changed = true;
            }
            continue;
          }

          if (i < msgs.length) {
            if (!areMessageEntriesEquivalent(msgs[i]!, nextEntry)) {
              msgs[i] = nextEntry;
              changed = true;
            }
          } else {
            msgs.push(nextEntry);
            changed = true;
          }
        }
        if (msgs.length !== incoming.length) {
          msgs.length = incoming.length;
          changed = true;
        }
        if (changed) messageIndex.invalidate();
      })
    );
  });
  recordSettledAssistantMarkers(incoming);
}

function getMessageInsertion(current: MessageEntry[], incoming: MessageEntry[]) {
  const count = incoming.length - current.length;
  if (count <= 0) return null;

  let index = 0;
  while (index < current.length && sameMessageIdentity(current[index], incoming[index])) index += 1;
  for (let currentIndex = index; currentIndex < current.length; currentIndex += 1) {
    if (!sameMessageIdentity(current[currentIndex], incoming[currentIndex + count])) return null;
  }
  return { count, index };
}

function sameMessageIdentity(left: MessageEntry | undefined, right: MessageEntry | undefined) {
  return (
    !!left &&
    !!right &&
    left.info.id === right.info.id &&
    left.info.sessionID === right.info.sessionID
  );
}

function reconcileMessageInsertion(
  incoming: MessageEntry[],
  insertion: { count: number; index: number },
  options: { preserveExtraParts?: boolean } | undefined,
  streamingSnapshot: StreamingTextSnapshot
) {
  streamingDeltaQueue.reset();
  batch(() => {
    if (state.streamingPartId !== null) setState('streamingPartId', null);
    if (state.streamingText !== '') setState('streamingText', '');

    setState(
      'messages',
      produce((msgs) => {
        const inserted = incoming
          .slice(insertion.index, insertion.index + insertion.count)
          .map((entry) => mergeMessageEntry(undefined, entry, options, streamingSnapshot));
        msgs.splice(insertion.index, 0, ...inserted);

        for (let index = 0; index < incoming.length; index += 1) {
          if (index >= insertion.index && index < insertion.index + insertion.count) continue;
          const currentEntry = msgs[index]!;
          const next = incoming[index]!;
          if (
            areMessageEntriesEquivalent(currentEntry, next) &&
            !hasExtraMessagePartsToPreserve(currentEntry, next, options) &&
            !hasStreamingTextToMaterialize(currentEntry, next, options, streamingSnapshot)
          ) {
            continue;
          }
          msgs[index] = mergeMessageEntry(currentEntry, next, options, streamingSnapshot);
        }
        messageIndex.invalidate();
      })
    );
  });
}

function preserveMissingOptimisticUserMessages(current: MessageEntry[], incoming: MessageEntry[]) {
  const incomingKeys = new Set(
    incoming.map((entry) => {
      const key = getPendingOptimisticUserMessageKey(entry.info.sessionID, entry.info.id);
      pendingOptimisticUserMessageKeys.delete(key);
      return key;
    })
  );
  const pending = current.filter(
    (entry) =>
      (isOptimisticUserMessage(entry) || isPendingOptimisticUserMessage(entry)) &&
      !isOptimisticUserMessageId(entry.info.id) &&
      !incomingKeys.has(getPendingOptimisticUserMessageKey(entry.info.sessionID, entry.info.id))
  );
  return pending.length > 0 ? [...incoming, ...pending] : incoming;
}

export function hasSettledLatestAssistantMessage(
  sessionId: string,
  messages: MessageEntry[] = state.messages
) {
  const latest = getLatestMessageEntryForSession(sessionId, messages);
  return (
    latest?.info.role === 'assistant' &&
    (!!latest.info.error || !!latest.info.time.completed) &&
    !hasRunningToolPart(latest.parts)
  );
}

function recordSettledAssistantMarkers(messages: MessageEntry[]) {
  const settledMessages = getSettledLatestAssistantMessages(messages);
  if (settledMessages.size === 0) return;

  batch(() => {
    for (const [sessionId, message] of settledMessages) {
      if (message.error) continue;
      if (state.activeSessionId === sessionId && !showSessionPicker()) {
        markSessionSeen(sessionId, message.time.completed);
      } else {
        markSessionResponseCompleted(sessionId, message.time.completed);
      }
    }
  });
}

function getSettledLatestAssistantMessages(messages: MessageEntry[]) {
  const latestBySession = new Map<string, MessageEntry>();
  for (const entry of messages) {
    latestBySession.set(entry.info.sessionID, entry);
  }

  const settled = new Map<string, AssistantMessage>();
  for (const [sessionId, entry] of latestBySession) {
    const message = entry.info;
    if (message.role !== 'assistant') continue;
    if (!message.error && !message.time.completed) continue;
    if (hasRunningToolPart(entry.parts)) continue;
    settled.set(sessionId, message);
  }
  return settled;
}

function getLatestMessageEntryForSession(sessionId: string, messages: MessageEntry[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (entry?.info.sessionID === sessionId) return entry;
  }
  return null;
}

function hasRunningToolPart(parts: Part[]) {
  return parts.some((part) => part.type === 'tool' && part.state.status === 'running');
}

function mergeMessageEntry(
  current: MessageEntry | undefined,
  incoming: MessageEntry,
  options?: { preserveExtraParts?: boolean },
  streamingSnapshot?: StreamingTextSnapshot
) {
  const next = cloneValue(incoming);
  if (!current || current.info.id !== incoming.info.id) {
    materializeStreamingTextInEntry(next, streamingSnapshot ?? null);
    return next;
  }

  preserveLongerToolExecutionTimes(current, next);
  preserveCompletionState(current, next);
  preserveOptimisticImageFileParts(current, next);
  if (!options?.preserveExtraParts || current.parts.length === 0) {
    materializeStreamingTextInEntry(next, streamingSnapshot ?? null);
    return next;
  }

  const currentPartById = new Map(current.parts.map((part) => [part.id, part]));
  for (let index = 0; index < next.parts.length; index += 1) {
    const part = next.parts[index]!;
    next.parts[index] = mergePartUpdate(currentPartById.get(part.id), part);
  }

  const incomingPartIds = new Set(next.parts.map((part) => part.id));
  const matchedOptimisticPartIndexes = new Set<number>();
  for (const part of current.parts) {
    if (isOptimisticImageFilePart(part)) continue;
    if (incomingPartIds.has(part.id)) continue;
    if (current.info.role === 'user' && isLocalOptimisticPartId(part.id, current.info.id)) {
      const matchIndex = next.parts.findIndex(
        (incomingPart, index) =>
          !matchedOptimisticPartIndexes.has(index) && areMatchingOptimisticParts(part, incomingPart)
      );
      if (matchIndex !== -1) {
        matchedOptimisticPartIndexes.add(matchIndex);
        continue;
      }
    }
    next.parts.push(cloneValue(part));
  }

  materializeStreamingTextInEntry(next, streamingSnapshot ?? null);
  return next;
}

function preserveOptimisticImageFileParts(current: MessageEntry | undefined, next: MessageEntry) {
  if (!current || current.info.role !== 'user' || next.info.role !== 'user') return;

  const optimisticParts = current.parts.filter(
    (part) =>
      isOptimisticImageFilePart(part) && !next.parts.some((nextPart) => nextPart.id === part.id)
  );
  const canonicalParts = next.parts.filter(
    (part) => isImageFilePart(part) && !isOptimisticImageFilePart(part)
  );
  const matchedCanonicalIndexes = new Set<number>();
  const unmatchedOptimisticParts: Part[] = [];

  for (const part of optimisticParts) {
    const matchIndex = canonicalParts.findIndex(
      (canonical, index) =>
        !matchedCanonicalIndexes.has(index) && areMatchingImageFileParts(part, canonical)
    );
    if (matchIndex === -1) {
      unmatchedOptimisticParts.push(part);
    } else {
      matchedCanonicalIndexes.add(matchIndex);
    }
  }

  let remainingCanonicalCount = canonicalParts.length - matchedCanonicalIndexes.size;
  for (const part of unmatchedOptimisticParts) {
    if (remainingCanonicalCount > 0) {
      remainingCanonicalCount -= 1;
      continue;
    }
    next.parts.push(cloneValue(part));
  }
}

function removeAcknowledgedOptimisticImageFilePart(entry: MessageEntry, incoming: Part) {
  if (
    entry.info.role !== 'user' ||
    !isImageFilePart(incoming) ||
    isOptimisticImageFilePart(incoming)
  ) {
    return;
  }
  const matchingIndex = entry.parts.findIndex(
    (part) => isOptimisticImageFilePart(part) && areMatchingImageFileParts(part, incoming)
  );
  const index =
    matchingIndex !== -1
      ? matchingIndex
      : entry.parts.findIndex((part) => isOptimisticImageFilePart(part));
  if (index === -1) return;
  entry.parts.splice(index, 1);
  messageIndex.invalidate();
}

function isImageFilePart(part: Part): part is Extract<Part, { type: 'file' }> {
  return part.type === 'file' && part.mime.startsWith('image/');
}

function isOptimisticImageFilePart(part: Part): part is Extract<Part, { type: 'file' }> {
  return isImageFilePart(part) && part.id.includes('-optimistic-file-');
}

function getOptimisticImagePartId(messageId: string, index: number) {
  return `${messageId}-optimistic-file-${index}`;
}

function areMatchingImageFileParts(left: Part, right: Part) {
  if (!isImageFilePart(left) || !isImageFilePart(right)) return false;
  return left.url === right.url && left.mime === right.mime && left.filename === right.filename;
}

function preserveCompletionState(current: MessageEntry | undefined, next: MessageEntry) {
  if (!current || current.info.role !== 'assistant' || next.info.role !== 'assistant') return;
  if (next.info.time.completed === undefined && current.info.time.completed !== undefined) {
    next.info.time = { ...next.info.time, completed: current.info.time.completed };
  }
  if (!next.info.error && current.info.error) {
    next.info.error = current.info.error;
  }
}

function preserveLongerToolExecutionTimes(current: MessageEntry | undefined, next: MessageEntry) {
  if (!current?.parts.length) return;

  const currentToolParts = new Map<string, Extract<Part, { type: 'tool' }>>();
  for (const part of current.parts) {
    if (part.type === 'tool') currentToolParts.set(part.id, part);
  }
  if (currentToolParts.size === 0) return;

  for (let index = 0; index < next.parts.length; index += 1) {
    const incomingPart = next.parts[index]!;
    if (incomingPart.type !== 'tool') continue;
    const currentPart = currentToolParts.get(incomingPart.id);
    if (!currentPart || currentPart.callID !== incomingPart.callID) continue;

    const currentDuration = getToolStateDurationMs(currentPart.state);
    const incomingDuration = getToolStateDurationMs(incomingPart.state);
    if (
      currentDuration === null ||
      incomingDuration === null ||
      currentDuration <= incomingDuration
    ) {
      continue;
    }
    if (currentPart.state.status === 'completed' && incomingPart.state.status === 'completed') {
      next.parts[index] = {
        ...incomingPart,
        state: { ...incomingPart.state, time: currentPart.state.time },
      };
      continue;
    }

    if (currentPart.state.status === 'error' && incomingPart.state.status === 'error') {
      next.parts[index] = {
        ...incomingPart,
        state: { ...incomingPart.state, time: currentPart.state.time },
      };
    }
  }
}

function getToolStateDurationMs(toolState: Extract<Part, { type: 'tool' }>['state']) {
  if (toolState.status !== 'completed' && toolState.status !== 'error') return null;
  return Math.max(0, toolState.time.end - toolState.time.start);
}

function getStreamingTextSnapshot(): StreamingTextSnapshot {
  return state.streamingPartId
    ? { partId: state.streamingPartId, text: state.streamingText }
    : null;
}

function materializeStreamingText(
  entries: MessageEntry[],
  streamingSnapshot: StreamingTextSnapshot
) {
  if (!streamingSnapshot) return;
  for (const entry of entries) {
    materializeStreamingTextInEntry(entry, streamingSnapshot);
  }
}

function materializeStreamingTextInEntry(
  entry: MessageEntry,
  streamingSnapshot: StreamingTextSnapshot
) {
  if (!streamingSnapshot) return;
  for (let index = 0; index < entry.parts.length; index += 1) {
    const part = entry.parts[index]!;
    if (part.id !== streamingSnapshot.partId) continue;
    const nextPart = materializeStreamingTextInPart(part, streamingSnapshot);
    if (nextPart !== part) entry.parts[index] = nextPart;
    return;
  }
}

function materializeStreamingTextInPart(
  part: Part,
  streamingSnapshot: StreamingTextSnapshot
): Part {
  if (!streamingSnapshot || part.id !== streamingSnapshot.partId) return part;
  if (!isStreamingTextPart(part)) return part;
  if (!shouldUseStreamingText(part.text, streamingSnapshot.text)) return part;
  if (part.text === streamingSnapshot.text) return part;
  return { ...part, text: streamingSnapshot.text };
}

function hasStreamingTextToMaterialize(
  current: MessageEntry | undefined,
  incoming: MessageEntry,
  options: { preserveExtraParts?: boolean } | undefined,
  streamingSnapshot: StreamingTextSnapshot
) {
  if (!streamingSnapshot) return false;

  const incomingPart = incoming.parts.find((part) => part.id === streamingSnapshot.partId);
  if (incomingPart) {
    return (
      isStreamingTextPart(incomingPart) &&
      incomingPart.text !== streamingSnapshot.text &&
      shouldUseStreamingText(incomingPart.text, streamingSnapshot.text)
    );
  }

  if (!current || !options?.preserveExtraParts) return false;
  const currentPart = current.parts.find((part) => part.id === streamingSnapshot.partId);
  return (
    !!currentPart &&
    isStreamingTextPart(currentPart) &&
    currentPart.text !== streamingSnapshot.text &&
    shouldUseStreamingText(currentPart.text, streamingSnapshot.text)
  );
}

function isStreamingTextPart(part: Part): part is Extract<Part, { type: 'text' | 'reasoning' }> {
  return part.type === 'text' || part.type === 'reasoning';
}

function hasExtraMessagePartsToPreserve(
  current: MessageEntry,
  incoming: MessageEntry,
  options?: { preserveExtraParts?: boolean }
) {
  if (!options?.preserveExtraParts || current.parts.length <= incoming.parts.length) return false;

  const incomingPartIds = new Set(incoming.parts.map((part) => part.id));
  return current.parts.some((part) => !incomingPartIds.has(part.id));
}

function cloneMessageEntries(entries: MessageEntry[]) {
  return entries.map((entry) => cloneValue(entry));
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        cloneValue(entry),
      ])
    ) as T;
  }
  return value;
}

export function getChildRunsByParentId(
  messages: MessageEntry[]
): Map<string, Array<MessageEntry<AssistantMessage>>> {
  if (
    messages === state.messages &&
    cachedChildRunsByParentIdMessages === messages &&
    cachedChildRunsByParentIdVersion === messageStructureVersion()
  ) {
    return cachedChildRunsByParentId;
  }

  const map = new Map<string, Array<MessageEntry<AssistantMessage>>>();
  for (const entry of messages) {
    if (entry.info.role !== 'assistant') continue;
    const a = entry.info as AssistantMessage;
    if (a.mode !== 'subagent') continue;
    const children = map.get(a.parentID);
    if (children) children.push(entry as MessageEntry<AssistantMessage>);
    else map.set(a.parentID, [entry as MessageEntry<AssistantMessage>]);
  }
  for (const children of map.values()) {
    children.sort((a, b) => a.info.time.created - b.info.time.created);
  }

  if (messages === state.messages) {
    cachedChildRunsByParentIdMessages = messages;
    cachedChildRunsByParentIdVersion = messageStructureVersion();
    cachedChildRunsByParentId = map;
  }

  return map;
}
