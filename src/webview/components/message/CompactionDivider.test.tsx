import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { formatClockTime } from '../../lib/message-time';
import type { CompactionPart } from '../../types';
import { CompactionDivider } from './CompactionDivider';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
  container?.remove();
  container = null;
});

function compactionPart(overrides: Partial<CompactionPart> = {}): CompactionPart {
  return {
    id: 'compaction-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'compaction',
    auto: false,
    ...overrides,
  };
}

describe('CompactionDivider', () => {
  it('renders the manual compaction label by default', () => {
    cleanup = render(
      () => CompactionDivider({ part: compactionPart(), timestamp: 1_000 }),
      container!
    );

    expect(container?.textContent).toContain('Context compacted (manual)');
    expect(
      container
        ?.querySelector('.message-compaction-divider')
        ?.classList.contains('assistant-dialog-summary')
    ).toBe(true);
    expect(container?.querySelector('.assistant-dialog-summary-content')).not.toBeNull();
  });

  it('renders the auto compaction label', () => {
    cleanup = render(
      () => CompactionDivider({ part: compactionPart({ auto: true }), timestamp: 1_000 }),
      container!
    );

    expect(container?.textContent).toContain('Context compacted (auto)');
  });

  it('includes the overflow suffix when compaction happened after overflow', () => {
    cleanup = render(
      () =>
        CompactionDivider({
          part: compactionPart({ auto: true, overflow: true }),
          timestamp: 1_000,
        }),
      container!
    );

    expect(container?.textContent).toContain('Context compacted (auto, after overflow)');
  });

  it('shows the timestamp after hover intent', () => {
    vi.useFakeTimers();
    const timestamp = new Date(2026, 0, 2, 13, 45).getTime();
    cleanup = render(
      () =>
        CompactionDivider({
          part: compactionPart(),
          timestamp,
          suppressTimestampAnimation: true,
        }),
      container!
    );

    const divider = container?.querySelector<HTMLElement>('.message-compaction-divider');
    const time = divider?.querySelector<HTMLTimeElement>(
      '.assistant-dialog-summary-completed-time'
    );
    expect(time?.textContent).toBe(formatClockTime(timestamp));
    expect(time?.classList.contains('is-animation-suppressed')).toBe(true);
    expect(divider?.classList.contains('is-completion-time-visible')).toBe(false);

    divider?.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(299);
    expect(divider?.classList.contains('is-completion-time-visible')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(divider?.classList.contains('is-completion-time-visible')).toBe(true);

    divider?.dispatchEvent(new MouseEvent('mouseleave'));
    expect(divider?.classList.contains('is-completion-time-visible')).toBe(false);
  });

  it('keeps the timestamp visible when configured', () => {
    cleanup = render(
      () =>
        CompactionDivider({
          part: compactionPart({ auto: true }),
          timestamp: 1_000,
          showTimestamp: true,
        }),
      container!
    );

    expect(
      container
        ?.querySelector('.message-compaction-divider')
        ?.classList.contains('is-completion-time-visible')
    ).toBe(true);
  });
});
