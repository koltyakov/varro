import { batch } from 'solid-js';
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
  let appendedPart = false;
  let committedPreviousStreamingPart = false;

  batch(() => {
    if (appState.state.streamingPartId && appState.state.streamingPartId !== latest.partId) {
      const previousLocation = appState.messageIndex.findPartLocation(
        appState.state.messages,
        appState.state.streamingPartId
      );
      if (previousLocation) {
        const previousPart =
          appState.state.messages[previousLocation.msgIdx]?.parts[previousLocation.partIdx];
        if (
          previousPart &&
          (previousPart.type === 'text' || previousPart.type === 'reasoning') &&
          previousPart.text !== appState.state.streamingText
        ) {
          appState.setState(
            'messages',
            previousLocation.msgIdx,
            'parts',
            previousLocation.partIdx,
            (currentPart) => {
              if (currentPart.type !== 'text' && currentPart.type !== 'reasoning') {
                return currentPart;
              }
              return {
                ...currentPart,
                text: appState.state.streamingText,
              };
            }
          );
          committedPreviousStreamingPart = true;
        }
      }
    }

    appState.setState('streamingPartId', latest.partId);
    appState.setState('streamingText', latest.text);

    for (const item of deltas) {
      const location = appState.messageIndex.findPartLocation(appState.state.messages, item.partId);
      if (location) {
        const currentPart = appState.state.messages[location.msgIdx]?.parts[location.partIdx];
        if (
          item.partId !== latest.partId &&
          (currentPart?.type === 'text' || currentPart?.type === 'reasoning') &&
          currentPart.text !== item.text &&
          shouldUseStreamingText(currentPart.text, item.text)
        ) {
          appState.setState('messages', location.msgIdx, 'parts', location.partIdx, {
            ...currentPart,
            text: item.text,
          });
          committedPreviousStreamingPart = true;
        }
        continue;
      }

      const msgIdx = appState.messageIndex.findMessageIndex(
        appState.state.messages,
        item.messageId
      );
      if (msgIdx === -1) continue;
      const commonPart = {
        id: item.partId,
        messageID: item.messageId,
        sessionID: item.sessionId || appState.state.messages[msgIdx]!.info.sessionID,
        text: item.text,
      };
      const part =
        item.partType === 'reasoning'
          ? { ...commonPart, type: 'reasoning' as const, time: { start: item.partStartedAt } }
          : { ...commonPart, type: 'text' as const };
      appState.setState('messages', msgIdx, 'parts', (parts) => [...parts, part]);
      appendedPart = true;
      appState.messageIndex.appendPart(appState.state.messages, item.partId, {
        msgIdx,
        partIdx: appState.state.messages[msgIdx]!.parts.length - 1,
      });
    }

    if (!appendedPart && committedPreviousStreamingPart) {
      // Keep the part index fresh after committing the previously active streaming part.
      appState.messageIndex.ensureIndex(appState.state.messages);
    }
  });
}

export function shouldUseStreamingText(currentText: string, streamingText: string) {
  if (currentText === streamingText) return true;
  if (!streamingText) return false;
  return streamingText.startsWith(currentText);
}
