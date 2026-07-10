import { beforeEach, describe, expect, it } from 'vitest';
import type { Message, Part } from '../types';
import {
  getSessionHistoryCursor,
  isSessionHistoryTruncated,
  markSessionHistoryTruncated,
  mergeOlderHistory,
  mergeWindowedHistory,
  resetMessageWindowState,
  setSessionHistoryCursor,
} from './message-window';

function entry(id: string, sessionID = 'session-1'): { info: Message; parts: Part[] } {
  return {
    info: {
      id,
      sessionID,
      role: 'user',
      time: { created: 0 },
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5' },
    },
    parts: [],
  };
}

beforeEach(() => {
  resetMessageWindowState();
});

describe('mergeWindowedHistory', () => {
  it('returns the incoming window when nothing was loaded before', () => {
    const incoming = [entry('m1'), entry('m2')];
    expect(mergeWindowedHistory([], incoming)).toBe(incoming);
  });

  it('returns the incoming window when it becomes empty', () => {
    expect(mergeWindowedHistory([entry('m1')], [])).toEqual([]);
  });

  it('returns the incoming window when it starts at or before the loaded head', () => {
    const incoming = [entry('m1'), entry('m2'), entry('m3')];
    expect(mergeWindowedHistory([entry('m1'), entry('m2')], incoming)).toBe(incoming);
  });

  it('stitches previously loaded older entries in front of an overlapping window', () => {
    const current = [entry('m1'), entry('m2'), entry('m3')];
    const incoming = [entry('m2'), entry('m3'), entry('m4')];

    expect(mergeWindowedHistory(current, incoming).map((item) => item.info.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ]);
  });

  it('returns the incoming window when the windows do not overlap', () => {
    const current = [entry('m1'), entry('m2')];
    const incoming = [entry('m8'), entry('m9')];
    expect(mergeWindowedHistory(current, incoming)).toBe(incoming);
  });

  it('does not stitch entries from a different session', () => {
    const current = [entry('m1', 'session-other'), entry('m2', 'session-other')];
    const incoming = [entry('m2'), entry('m3')];
    expect(mergeWindowedHistory(current, incoming)).toBe(incoming);
  });
});

describe('history window state', () => {
  it('tracks truncated sessions', () => {
    expect(isSessionHistoryTruncated('session-1')).toBe(false);
    markSessionHistoryTruncated('session-1', true);
    expect(isSessionHistoryTruncated('session-1')).toBe(true);
    expect(isSessionHistoryTruncated('session-2')).toBe(false);
    expect(isSessionHistoryTruncated(null)).toBe(false);
    markSessionHistoryTruncated('session-1', false);
    expect(isSessionHistoryTruncated('session-1')).toBe(false);
  });

  it('tracks opaque history cursors until reset', () => {
    expect(getSessionHistoryCursor('session-1')).toBeUndefined();
    setSessionHistoryCursor('session-1', 'cursor-1');
    expect(getSessionHistoryCursor('session-1')).toBe('cursor-1');
    expect(isSessionHistoryTruncated('session-1')).toBe(true);
    resetMessageWindowState();
    expect(getSessionHistoryCursor('session-1')).toBeUndefined();
    expect(isSessionHistoryTruncated('session-1')).toBe(false);
  });

  it('clears truncation when the cursor reaches the final page', () => {
    setSessionHistoryCursor('session-1', 'cursor-1');
    setSessionHistoryCursor('session-1');
    expect(getSessionHistoryCursor('session-1')).toBeUndefined();
    expect(isSessionHistoryTruncated('session-1')).toBe(false);
  });
});

describe('mergeOlderHistory', () => {
  it('prepends older entries while preserving current duplicates', () => {
    const current = [entry('m2'), entry('m3')];
    const olderDuplicate = entry('m2');
    olderDuplicate.parts = [{ id: 'old-part' } as Part];

    const merged = mergeOlderHistory(current, [entry('m1'), olderDuplicate]);

    expect(merged.map((item) => item.info.id)).toEqual(['m1', 'm2', 'm3']);
    expect(merged[1]).toBe(current[0]);
  });
});
