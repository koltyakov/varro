import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AttentionSessionsBadge,
  CompletedSessionsBadge,
  FailedSessionsBadge,
  PlanReadyBadge,
  RunningSessionsBadge,
  PendingSessionsBadge,
} from './HeaderBadges';

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
  vi.useRealTimers();
});

describe('header status badges', () => {
  it('renders pending sessions as an hourglass without a counter', () => {
    const onClick = vi.fn();
    cleanup = render(() => <PendingSessionsBadge count={3} onClick={onClick} />, container);
    const badge = container.querySelector<HTMLButtonElement>('.chat-header-pending-badge');
    expect(badge?.querySelector('.ui-icon')).not.toBeNull();
    expect(badge?.textContent).toBe('');
    badge?.click();
    expect(onClick).toHaveBeenCalledOnce();
  });
  it.each([
    ['.chat-header-running-badge', '2 running sessions'],
    ['.chat-header-pending-badge', 'Sessions pending background tasks'],
    ['.chat-header-attention-badge', 'Sessions waiting for input or permission'],
    ['.chat-header-failed-badge', 'Failed sessions'],
    ['.chat-header-plan-badge', 'Completed plans ready in another chat'],
    ['.chat-header-completed-badge', 'Completed sessions'],
  ])('shows the meaning of %s after one second', async (selector, meaning) => {
    cleanup = render(
      () => (
        <>
          <RunningSessionsBadge count={2} onClick={vi.fn()} />
          <PendingSessionsBadge count={2} onClick={vi.fn()} />
          <AttentionSessionsBadge count={1} onClick={vi.fn()} />
          <FailedSessionsBadge count={1} onClick={vi.fn()} />
          <PlanReadyBadge count={1} onClick={vi.fn()} />
          <CompletedSessionsBadge count={1} onClick={vi.fn()} />
        </>
      ),
      container
    );

    container.querySelector(selector)?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(999);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(meaning);
  });
});
