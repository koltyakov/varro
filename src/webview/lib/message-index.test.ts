import { describe, expect, it, vi } from 'vitest';
import { createMessageIndex } from './message-index';
import type { Message, Part } from '../types';

type MessageEntry = { info: Message; parts: Part[] };

function msg(id: string): Message {
  return {
    id,
    sessionID: 's1',
    role: 'user',
    time: { created: 0 },
    agent: 'a',
    model: { providerID: 'p', modelID: 'm' },
  } as Message;
}

function part(id: string): Part {
  return { id, sessionID: 's1', messageID: 'm1', type: 'text', text: 't' } as Part;
}

function entry(id: string, partIds: string[] = []): MessageEntry {
  return { info: msg(id), parts: partIds.map(part) };
}

describe('createMessageIndex', () => {
  it('finds message index after ensureIndex', () => {
    const idx = createMessageIndex();
    const msgs = [entry('m1'), entry('m2'), entry('m3')];

    expect(idx.findMessageIndex(msgs, 'm2')).toBe(1);
    expect(idx.findMessageIndex(msgs, 'm1')).toBe(0);
    expect(idx.findMessageIndex(msgs, 'm3')).toBe(2);
  });

  it('returns -1 for missing message id', () => {
    const idx = createMessageIndex();
    const msgs = [entry('m1')];

    expect(idx.findMessageIndex(msgs, 'missing')).toBe(-1);
  });

  it('finds part location by part id', () => {
    const idx = createMessageIndex();
    const msgs = [entry('m1', ['p1', 'p2']), entry('m2', ['p3'])];

    expect(idx.findPartLocation(msgs, 'p2')).toEqual({ msgIdx: 0, partIdx: 1 });
    expect(idx.findPartLocation(msgs, 'p3')).toEqual({ msgIdx: 1, partIdx: 0 });
  });

  it('returns null for missing part id', () => {
    const idx = createMessageIndex();
    const msgs = [entry('m1', ['p1'])];

    expect(idx.findPartLocation(msgs, 'missing')).toBeNull();
  });

  it('getIndexedPartLocation returns null before any indexing', () => {
    const idx = createMessageIndex();

    expect(idx.getIndexedPartLocation('p1')).toBeNull();
  });

  it('getIndexedPartLocation returns location after findPartLocation', () => {
    const idx = createMessageIndex();
    const msgs = [entry('m1', ['p1'])];
    idx.findPartLocation(msgs, 'p1');

    expect(idx.getIndexedPartLocation('p1')).toEqual({ msgIdx: 0, partIdx: 0 });
  });

  it('invalidate triggers onInvalidate callback', () => {
    const onInvalidate = vi.fn();
    const idx = createMessageIndex(onInvalidate);

    idx.invalidate();
    expect(onInvalidate).toHaveBeenCalledTimes(1);
  });

  it('invalidate forces re-index on next query', () => {
    const idx = createMessageIndex();
    const msgsV1 = [entry('m1', ['p1'])];
    expect(idx.findPartLocation(msgsV1, 'p1')).toEqual({ msgIdx: 0, partIdx: 0 });

    const msgsV2 = [entry('m1', ['p1', 'p2'])];
    idx.invalidate();
    expect(idx.findPartLocation(msgsV2, 'p2')).toEqual({ msgIdx: 0, partIdx: 1 });
  });

  it('findMessageIndex falls back to linear scan on stale index', () => {
    const idx = createMessageIndex();
    const msgs = [entry('m1')];
    expect(idx.findMessageIndex(msgs, 'm1')).toBe(0);

    idx.invalidate();
    const newMsgs = [entry('m1'), entry('m2')];
    expect(idx.findMessageIndex(newMsgs, 'm2')).toBe(1);
  });

  it('appendPart adds a part to the index', () => {
    const idx = createMessageIndex();
    const msgs = [entry('m1', ['p1'])];
    idx.findPartLocation(msgs, 'p1');

    idx.appendPart(msgs, 'p2', { msgIdx: 0, partIdx: 1 });

    expect(idx.getIndexedPartLocation('p2')).toEqual({ msgIdx: 0, partIdx: 1 });
  });

  it('removePart deletes part and re-indexes subsequent parts', () => {
    const idx = createMessageIndex();
    const msgs = [entry('m1', ['p1', 'p2', 'p3'])];
    idx.findPartLocation(msgs, 'p1');

    msgs[0].parts.splice(1, 1);
    idx.removePart(msgs, 'p2', { msgIdx: 0, partIdx: 1 });

    expect(idx.getIndexedPartLocation('p2')).toBeNull();
    expect(idx.getIndexedPartLocation('p3')).toEqual({ msgIdx: 0, partIdx: 1 });
  });

  it('removePart on non-existent part does not throw', () => {
    const idx = createMessageIndex();
    const msgs = [entry('m1', ['p1'])];
    idx.findPartLocation(msgs, 'p1');

    expect(() => idx.removePart(msgs, 'missing', { msgIdx: 0, partIdx: 5 })).not.toThrow();
    expect(idx.getIndexedPartLocation('p1')).toEqual({ msgIdx: 0, partIdx: 0 });
  });

  it('findPartLocation repairs stale index via linear scan', () => {
    const idx = createMessageIndex();
    const msgs = [entry('m1', ['p1'])];
    idx.findPartLocation(msgs, 'p1');

    idx.invalidate();
    const repaired = [entry('m1', ['p1'])];
    const loc = idx.findPartLocation(repaired, 'p1');

    expect(loc).toEqual({ msgIdx: 0, partIdx: 0 });
    expect(idx.getIndexedPartLocation('p1')).toEqual({ msgIdx: 0, partIdx: 0 });
  });

  it('appendPart and removePart call onInvalidate', () => {
    const onInvalidate = vi.fn();
    const idx = createMessageIndex(onInvalidate);
    const msgs = [entry('m1', ['p1'])];
    idx.findPartLocation(msgs, 'p1');

    idx.appendPart(msgs, 'p2', { msgIdx: 0, partIdx: 1 });
    expect(onInvalidate).toHaveBeenCalledTimes(1);

    idx.removePart(msgs, 'p1', { msgIdx: 0, partIdx: 0 });
    expect(onInvalidate).toHaveBeenCalledTimes(2);
  });

  it('handles empty message array', () => {
    const idx = createMessageIndex();
    const msgs: MessageEntry[] = [];

    expect(idx.findMessageIndex(msgs, 'm1')).toBe(-1);
    expect(idx.findPartLocation(msgs, 'p1')).toBeNull();
  });
});
