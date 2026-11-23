import type { AppStateInstance } from './app-state';
import { isFunction } from './runtime-values';

type StreamingDelta = {
  messageId: string;
  partId: string;
  partType: 'text' | 'reasoning';
  partStartedAt: number;
  sessionId?: string;
  text: string;
};

export function createStreamingDeltaQueue(
  flush: () => void,
  scheduleFrame: (callback: () => void) => void = defaultScheduleFrame
) {
  let flushScheduled = false;
  let generation = 0;
  const pending = new Map<string, StreamingDelta>();

  return {
    get(partId: string) {
      return pending.get(partId);
    },

    set(item: StreamingDelta) {
      pending.set(item.partId, item);
    },

    bump(partId: string, text: string) {
      const item = pending.get(partId);
      if (!item) return null;
      const next = { ...item, text };
      pending.delete(partId);
      pending.set(partId, next);
      return next;
    },

    takeAll() {
      if (pending.size === 0) return [];
      const items = [...pending.values()];
      pending.clear();
      flushScheduled = false;
      return items;
    },

    reset() {
      pending.clear();
      flushScheduled = false;
      generation++;
    },

    scheduleFlush() {
      if (flushScheduled) return;
      flushScheduled = true;
      const currentGeneration = generation;
      scheduleFrame(() => {
        if (currentGeneration !== generation) return;
        flushScheduled = false;
        flush();
      });
    },
  };
}

function defaultScheduleFrame(callback: () => void) {
  if (isFunction(globalThis.requestAnimationFrame)) {
    globalThis.requestAnimationFrame(callback);
    return;
  }
  setTimeout(callback, 16);
}

export function flushPendingStreamingDeltasFor(appState: AppStateInstance) {
  const deltas = appState.streamingDeltaQueue.takeAll();
  if (deltas.length === 0) return;
  const latest = deltas[deltas.length - 1]!;
  // Keep read-after-write indexing inside the store transaction. A staged
  // setter need not expose an appended part through appState.state yet.
  appState.setState((draft) => {
    let appendedPart = false;
    let committedPreviousStreamingPart = false;
    if (draft.streamingPartId && draft.streamingPartId !== latest.partId) {
      const previousLocation = appState.messageIndex.findPartLocation(
        draft.messages,
        draft.streamingPartId
      );
      const previousPart = previousLocation
        ? draft.messages[previousLocation.msgIdx]?.parts[previousLocation.partIdx]
        : undefined;
      if (
        previousLocation &&
        previousPart &&
        (previousPart.type === 'text' || previousPart.type === 'reasoning') &&
        previousPart.text !== draft.streamingText
      ) {
        draft.messages[previousLocation.msgIdx]!.parts[previousLocation.partIdx] = {
          ...previousPart,
          text: draft.streamingText,
        };
        committedPreviousStreamingPart = true;
      }
    }
    draft.streamingPartId = latest.partId;
    draft.streamingText = latest.text;

    for (const item of deltas) {
      const msgIdx = appState.messageIndex.findMessageIndex(draft.messages, item.messageId);
      if (msgIdx === -1) continue;
      const message = draft.messages[msgIdx]!;
      const location = appState.messageIndex.findPartLocation(draft.messages, item.partId, msgIdx);
      if (location) {
        const currentPart = draft.messages[location.msgIdx]?.parts[location.partIdx];
        if (
          item.partId !== latest.partId &&
          (currentPart?.type === 'text' || currentPart?.type === 'reasoning') &&
          currentPart.text !== item.text &&
          shouldUseStreamingText(currentPart.text, item.text)
        ) {
          draft.messages[location.msgIdx]!.parts[location.partIdx] = {
            ...currentPart,
            text: item.text,
          };
          committedPreviousStreamingPart = true;
        }
        continue;
      }

      const commonPart = {
        id: item.partId,
        messageID: item.messageId,
        sessionID: item.sessionId || message.info.sessionID,
        text: item.text,
      };
      const part =
        item.partType === 'reasoning'
          ? { ...commonPart, type: 'reasoning' as const, time: { start: item.partStartedAt } }
          : { ...commonPart, type: 'text' as const };
      const partIdx = message.parts.length;
      message.parts = [...message.parts, part];
      appendedPart = true;
      appState.messageIndex.appendPart(draft.messages, item.partId, { msgIdx, partIdx });
    }

    if (!appendedPart && committedPreviousStreamingPart) {
      // Keep the part index fresh after committing the previously active streaming part.
      appState.messageIndex.ensureIndex(draft.messages);
    }
  });
}

export function shouldUseStreamingText(currentText: string, streamingText: string) {
  if (currentText === streamingText) return true;
  if (!streamingText) return false;
  return streamingText.startsWith(currentText);
}
