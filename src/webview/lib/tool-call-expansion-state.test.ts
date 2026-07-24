import { beforeEach, describe, expect, it } from 'vitest';
import {
  getToolCallExpanded,
  getToolDiffPreviewState,
  getTrackedToolCallStateSize,
  resetToolCallExpansionState,
  setToolCallExpanded,
  setToolDiffPreviewState,
} from './tool-call-expansion-state';

const MAX_TRACKED_TOOL_CALLS = 2_000;

beforeEach(() => {
  resetToolCallExpansionState();
});

describe('tool call expansion state', () => {
  it('round-trips expansion and diff preview state', () => {
    setToolCallExpanded('a', true);
    setToolDiffPreviewState('a', { expanded: true, scrollTop: 10, scrollLeft: 5 });

    expect(getToolCallExpanded('a')).toBe(true);
    expect(getToolDiffPreviewState('a')).toEqual({
      expanded: true,
      scrollTop: 10,
      scrollLeft: 5,
    });
  });

  it('defaults to collapsed and null for unknown keys', () => {
    expect(getToolCallExpanded('missing')).toBe(false);
    expect(getToolDiffPreviewState('missing')).toBeNull();
  });

  it('reset clears everything', () => {
    setToolCallExpanded('a', true);
    setToolDiffPreviewState('a', { expanded: true, scrollTop: 0, scrollLeft: 0 });

    resetToolCallExpansionState();

    expect(getTrackedToolCallStateSize()).toEqual({ expansions: 0, diffPreviews: 0 });
  });

  it('caps tracked entries instead of growing without bound', () => {
    for (let index = 0; index < MAX_TRACKED_TOOL_CALLS + 500; index += 1) {
      setToolCallExpanded(`call-${index}`, true);
      setToolDiffPreviewState(`call-${index}`, {
        expanded: true,
        scrollTop: 0,
        scrollLeft: 0,
      });
    }

    expect(getTrackedToolCallStateSize()).toEqual({
      expansions: MAX_TRACKED_TOOL_CALLS,
      diffPreviews: MAX_TRACKED_TOOL_CALLS,
    });
    expect(getToolCallExpanded('call-0')).toBe(false);
    expect(getToolCallExpanded(`call-${MAX_TRACKED_TOOL_CALLS + 499}`)).toBe(true);
  });

  it('keeps entries that are still being read', () => {
    setToolCallExpanded('pinned', true);

    for (let index = 0; index < MAX_TRACKED_TOOL_CALLS; index += 1) {
      // Reading refreshes recency, so the entry survives the eviction sweep.
      getToolCallExpanded('pinned');
      setToolCallExpanded(`call-${index}`, true);
    }

    expect(getToolCallExpanded('pinned')).toBe(true);
  });

  it('updating an existing key does not grow the store', () => {
    setToolCallExpanded('a', true);
    setToolCallExpanded('a', false);

    expect(getTrackedToolCallStateSize().expansions).toBe(1);
    expect(getToolCallExpanded('a')).toBe(false);
  });
});
