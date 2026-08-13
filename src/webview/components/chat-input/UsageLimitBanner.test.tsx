import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { UsageLimitBanner } from './UsageLimitBanner';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
});

describe('UsageLimitBanner', () => {
  it('renders the usage-limit copy and all actions when stop retrying is available', () => {
    const onPrimaryAction = vi.fn();
    const onStopRetrying = vi.fn();
    const onSwitchProvider = vi.fn();
    const onExternalAction = vi.fn();

    cleanup = render(
      () =>
        UsageLimitBanner({
          title: 'Request throttled',
          message: 'OpenAI has temporarily rate limited requests.',
          meta: '5 requests remaining',
          primaryActionLabel: 'Continue',
          onPrimaryAction,
          externalAction: {
            label: 'Manage billing',
            link: 'https://example.com/billing',
          },
          onExternalAction,
          showStopRetrying: true,
          onStopRetrying,
          onSwitchProvider,
        }),
      container!
    );

    const status = container?.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(container?.textContent).toContain('Request throttled');
    expect(container?.textContent).toContain('5 requests remaining');
    expect(container?.textContent).toContain('OpenAI has temporarily rate limited requests.');

    const continueButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Continue'
    );
    const stopRetryingButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Stop retrying'
    );
    const externalActionButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Manage billing'
    );
    const switchProviderButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Switch provider'
    );

    continueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    externalActionButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    stopRetryingButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    switchProviderButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onPrimaryAction).toHaveBeenCalledOnce();
    expect(onExternalAction).toHaveBeenCalledWith('https://example.com/billing');
    expect(onStopRetrying).toHaveBeenCalledOnce();
    expect(onSwitchProvider).toHaveBeenCalledOnce();
  });

  it('omits the stop-retrying action when it is not available', () => {
    cleanup = render(
      () =>
        UsageLimitBanner({
          title: 'Service temporarily unavailable',
          message: 'Claude is unavailable until the window resets.',
          meta: 'Resets in 12 minutes',
          primaryActionLabel: 'Continue',
          onPrimaryAction: () => {},
          showStopRetrying: false,
          onStopRetrying: () => {},
          onSwitchProvider: () => {},
        }),
      container!
    );

    expect(container?.textContent).not.toContain('Stop retrying');
    expect(container?.textContent).toContain('Continue');
    expect(container?.textContent).toContain('Switch provider');
    expect(container?.querySelectorAll('button')).toHaveLength(2);
  });
});
