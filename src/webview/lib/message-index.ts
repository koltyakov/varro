import type { Message, Part } from '../types';

type MessageEntry = { info: Message; parts: Part[] };

export function createMessageIndex(onInvalidate?: () => void) {
  let messageIndexVersion = 0;
  let indexedVersion = -1;
  let messageById: Map<string, number> = new Map();
  let partById: Map<string, { msgIdx: number; partIdx: number }> = new Map();

  function ensureIndex(msgs: MessageEntry[]) {
    if (indexedVersion === messageIndexVersion) return;
    messageById = new Map();
    partById = new Map();
    for (let i = 0; i < msgs.length; i++) {
      messageById.set(msgs[i].info.id, i);
      for (let j = 0; j < msgs[i].parts.length; j++) {
        partById.set(msgs[i].parts[j].id, { msgIdx: i, partIdx: j });
      }
    }
    indexedVersion = messageIndexVersion;
  }

  return {
    invalidate() {
      messageIndexVersion++;
      onInvalidate?.();
    },

    ensureIndex,

    findMessageIndex(msgs: MessageEntry[], id: string) {
      ensureIndex(msgs);
      const idx = messageById.get(id);
      if (idx !== undefined && idx < msgs.length && msgs[idx].info.id === id) return idx;
      return msgs.findIndex((m) => m.info.id === id);
    },

    findPartLocation(msgs: MessageEntry[], partId: string) {
      ensureIndex(msgs);
      const indexed = partById.get(partId);
      if (indexed) {
        const message = msgs[indexed.msgIdx];
        if (message?.parts[indexed.partIdx]?.id === partId) {
          return indexed;
        }
      }

      for (let msgIdx = 0; msgIdx < msgs.length; msgIdx++) {
        const partIdx = msgs[msgIdx].parts.findIndex((part) => part.id === partId);
        if (partIdx !== -1) {
          const location = { msgIdx, partIdx };
          partById.set(partId, location);
          return location;
        }
      }

      return null;
    },

    getIndexedPartLocation(partId: string) {
      return partById.get(partId) || null;
    },
  };
}
