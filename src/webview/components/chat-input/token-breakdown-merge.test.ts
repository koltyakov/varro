import { describe, expect, it } from 'vitest';
import { mergeCompleteTokenBreakdown } from './message-usage';
import type { SessionTreeTokenBreakdown } from './message-usage';

function usage(total: number) {
  return {
    total,
    input: total,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

function breakdown(
  sessionTotal: number,
  subagentsTotal: number,
  subagentCount: number
): SessionTreeTokenBreakdown {
  return {
    session: usage(sessionTotal),
    subagents: usage(subagentsTotal),
    total: usage(sessionTotal + subagentsTotal),
    subagentCount,
  };
}

const local = breakdown(100, 50, 2);

describe('mergeCompleteTokenBreakdown', () => {
  it('returns the local breakdown when there is no root session', () => {
    const complete = { rootId: 'root-1', breakdown: breakdown(900, 900, 9) };
    expect(mergeCompleteTokenBreakdown(local, complete, null)).toBe(local);
  });

  it('returns the local breakdown when nothing has been fetched yet', () => {
    expect(mergeCompleteTokenBreakdown(local, null, 'root-1')).toBe(local);
    expect(mergeCompleteTokenBreakdown(local, undefined, 'root-1')).toBe(local);
  });

  it('ignores a breakdown fetched for a different session tree', () => {
    const complete = { rootId: 'other-root', breakdown: breakdown(900, 900, 9) };
    expect(mergeCompleteTokenBreakdown(local, complete, 'root-1')).toBe(local);
  });

  it('takes the server totals when they are larger than the local view', () => {
    const complete = { rootId: 'root-1', breakdown: breakdown(500, 400, 7) };
    const merged = mergeCompleteTokenBreakdown(local, complete, 'root-1');

    expect(merged.session.total).toBe(500);
    expect(merged.subagents.total).toBe(400);
    expect(merged.subagentCount).toBe(7);
  });

  it('keeps the local totals when the server view is behind', () => {
    const complete = { rootId: 'root-1', breakdown: breakdown(10, 5, 1) };
    const merged = mergeCompleteTokenBreakdown(local, complete, 'root-1');

    expect(merged.session.total).toBe(100);
    expect(merged.subagents.total).toBe(50);
    expect(merged.subagentCount).toBe(2);
  });

  it('merges each bucket independently so a partial catch-up still counts', () => {
    const complete = { rootId: 'root-1', breakdown: breakdown(500, 5, 1) };
    const merged = mergeCompleteTokenBreakdown(local, complete, 'root-1');

    expect(merged.session.total).toBe(500);
    expect(merged.subagents.total).toBe(50);
  });

  it('prefers the server bucket when the two totals are equal', () => {
    const completeSession = usage(100);
    const complete = {
      rootId: 'root-1',
      breakdown: { session: completeSession, subagents: usage(50), subagentCount: 2 },
    };
    const merged = mergeCompleteTokenBreakdown(local, complete, 'root-1');

    expect(merged.session).toBe(completeSession);
  });

  it('carries the local total through untouched', () => {
    const complete = { rootId: 'root-1', breakdown: breakdown(500, 400, 7) };
    const merged = mergeCompleteTokenBreakdown(local, complete, 'root-1');

    expect(merged.total).toBe(local.total);
  });

  it('accepts a server payload that omits the total bucket entirely', () => {
    const complete = {
      rootId: 'root-1',
      breakdown: { session: usage(500), subagents: usage(400), subagentCount: 7 },
    };
    const merged = mergeCompleteTokenBreakdown(local, complete, 'root-1');

    expect(merged.session.total).toBe(500);
    expect(merged.subagentCount).toBe(7);
  });

  it('never lowers the displayed subagent count', () => {
    const complete = { rootId: 'root-1', breakdown: breakdown(500, 400, 0) };
    const merged = mergeCompleteTokenBreakdown(local, complete, 'root-1');

    expect(merged.subagentCount).toBe(2);
  });
});
