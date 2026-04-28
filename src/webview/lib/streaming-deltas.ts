type StreamingDelta = {
  messageId: string;
  partId: string;
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
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(callback);
    return;
  }
  setTimeout(callback, 16);
}
