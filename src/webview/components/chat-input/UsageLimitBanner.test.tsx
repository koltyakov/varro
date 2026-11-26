import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import { UsageLimitBanner } from './UsageLimitBanner';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

const NOW = new Date('2026-03-04T10:00:00').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  vi.useRealTimers();
});

type BannerProps = Parameters<typeof UsageLimitBanner>[0];

function renderBanner(overrides: Partial<BannerProps> = {}) {
  const props: BannerProps = {
    kind: 'quota',
    title: 'Usage limit reached',
    message: 'You have hit your plan limit.',
    summary: 'messages exhausted',
    modelLabel: 'GPT-5',
    retrying: false,
    retryAt: null,
    attempt: null,
    resetAt: null,
    showStopRetrying: false,
    onStopRetrying: vi.fn(),
    onContinue: vi.fn(),
    onSwitchModel: vi.fn(),
    ...overrides,
  };
  cleanup = render(() => UsageLimitBanner(props), container!);
  return props;
}

function buttons() {
  return Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? []);
}

function button(label: string) {
  return buttons().find((candidate) => candidate.textContent === label);
}

describe('UsageLimitBanner', () => {
  it('offers Continue first when a stopped limit has no known reset', () => {
    const props = renderBanner({
      externalAction: { label: 'Manage billing', link: 'https://example.com/billing' },
      onExternalAction: vi.fn(),
    });

    const banner = container?.querySelector('[role="status"]');
    expect(banner?.getAttribute('aria-live')).toBe('polite');
    expect(banner?.getAttribute('data-tone')).toBe('error');
    expect(container?.querySelector('.chat-usage-limit-meta')?.textContent).toBe(
      'GPT-5 · messages exhausted'
    );
    expect(buttons().map((candidate) => candidate.textContent)).toEqual([
      'Continue',
      'Switch model…',
      'Manage billing',
    ]);
    expect(button('Continue')?.classList.contains('primary')).toBe(true);

    button('Continue')?.click();
    button('Switch model…')?.click();
    button('Manage billing')?.click();
    expect(props.onContinue).toHaveBeenCalledOnce();
    expect(props.onSwitchModel).toHaveBeenCalledOnce();
    expect(props.onExternalAction).toHaveBeenCalledWith('https://example.com/billing');
  });

  it('counts down an automatic retry and offers no Continue while retrying', async () => {
    const props = renderBanner({
      kind: 'throttled',
      title: 'Request throttled',
      message: 'Request throttled',
      retrying: true,
      retryAt: NOW + 75_000,
      attempt: 3,
      showStopRetrying: true,
    });

    const banner = container?.querySelector('[role="status"]');
    expect(banner?.getAttribute('data-tone')).toBe('warning');
    expect(banner?.getAttribute('data-state')).toBe('retrying');
    const meta = () => container?.querySelector('.chat-usage-limit-meta')?.textContent;
    expect(meta()).toBe('GPT-5 · retrying in 1:15 · attempt 3');
    // The provider message only repeats the title, so it is not shown twice.
    expect(container?.querySelector('.chat-usage-limit-message')).toBeNull();
    expect(button('Continue')).toBeUndefined();
    expect(button('Switch model…')?.classList.contains('primary')).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(meta()).toBe('GPT-5 · retrying in 1:10 · attempt 3');
    await vi.advanceTimersByTimeAsync(75_000);
    expect(meta()).toBe('GPT-5 · retrying now · attempt 3');

    button('Stop retrying')?.click();
    expect(props.onStopRetrying).toHaveBeenCalledOnce();
  });

  it('shows the quota reset and leads with switching models until it passes', async () => {
    renderBanner({ resetAt: NOW + 2 * 3_600_000 + 10 * 60_000 });

    const meta = () => container?.querySelector('.chat-usage-limit-meta')?.textContent ?? '';
    expect(meta()).toMatch(/^GPT-5 · resets at .+ \(in 2h 10m\)$/);
    expect(buttons().map((candidate) => candidate.textContent)).toEqual([
      'Switch model…',
      'Try anyway',
    ]);
    expect(button('Switch model…')?.classList.contains('primary')).toBe(true);

    await vi.advanceTimersByTimeAsync(2 * 3_600_000 + 11 * 60_000);
    expect(meta()).toBe('GPT-5 · limit window has reset');
    expect(button('Continue')?.classList.contains('primary')).toBe(true);
    expect(button('Try anyway')).toBeUndefined();
  });
});
