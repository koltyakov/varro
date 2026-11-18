import { flush as flushSolid } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import { formatClockTime } from '../../lib/message-time';
import { compressIcon } from '../../lib/ui-icons';
import type { CompactionPart } from '../../types';
import { toCssUrl } from '../UiIcon';
import { CompactionDivider } from './CompactionDivider';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  flushSolid();
  cleanup = undefined;
  vi.useRealTimers();
  container?.remove();
  flushSolid();
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
  it.each([
    ['running', 'Compacting context (auto)'],
    ['failed', 'Context compaction failed (auto): Summary failed'],
    ['completed', 'Context compacted (auto)'],
  ] as const)('labels %s compaction accurately', (status, label) => {
    cleanup = render(
      () =>
        CompactionDivider({
          part: {
            ...compactionPart({ auto: true }),
            status,
            error: status === 'failed' ? 'Summary failed' : undefined,
          },
          timestamp: 1_000,
        }),
      container!
    );
    flushSolid();
    expect(container?.textContent).toContain(label);
  });

  it('renders manual compaction as an icon action instead of a divider', () => {
    cleanup = render(
      () => CompactionDivider({ part: compactionPart(), timestamp: 1_000 }),
      container!
    );
    flushSolid();

    expect(container?.textContent).toContain('Context compacted manually');
    const action = container?.querySelector('.manual-compaction-action');
    expect(action?.classList.contains('user-message-card-wrapperless')).toBe(true);
    expect(
      action?.querySelector<HTMLElement>('.ui-icon')?.style.getPropertyValue('--ui-icon-mask')
    ).toBe(toCssUrl(compressIcon));
    expect(container?.querySelector('.assistant-dialog-summary')).toBeNull();
    expect(container?.querySelector('.message-compaction-divider')).toBeNull();
  });

  it.each([
    ['running', 'Compacting context'],
    ['failed', 'Context compaction failed: Summary failed'],
    ['completed', 'Context compacted manually'],
  ] as const)('labels %s manual compaction accurately', (status, label) => {
    cleanup = render(
      () =>
        CompactionDivider({
          part: compactionPart({
            status,
            error: status === 'failed' ? 'Summary failed' : undefined,
          }),
          timestamp: 1_000,
        }),
      container!
    );
    flushSolid();
    expect(container?.querySelector('.manual-compaction-action')?.textContent).toContain(label);
  });

  it('renders the auto compaction label', () => {
    cleanup = render(
      () => CompactionDivider({ part: compactionPart({ auto: true }), timestamp: 1_000 }),
      container!
    );
    flushSolid();

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
    flushSolid();

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
    flushSolid();

    const divider = container?.querySelector<HTMLElement>('.chat-turn-manual-compaction');
    const time = divider?.querySelector<HTMLTimeElement>('.message-sent-time');
    expect(time?.textContent).toBe(formatClockTime(timestamp));
    expect(time?.classList.contains('is-animation-suppressed')).toBe(true);
    expect(time?.classList.contains('is-visible')).toBe(false);

    divider?.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    vi.advanceTimersByTime(299);
    flushSolid();
    expect(time?.classList.contains('is-visible')).toBe(false);
    vi.advanceTimersByTime(1);
    flushSolid();
    expect(time?.classList.contains('is-visible')).toBe(true);

    divider?.dispatchEvent(new MouseEvent('mouseleave'));
    flushSolid();
    expect(time?.classList.contains('is-visible')).toBe(false);
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
    flushSolid();

    expect(
      container
        ?.querySelector('.message-compaction-divider')
        ?.classList.contains('is-completion-time-visible')
    ).toBe(true);
  });
});
