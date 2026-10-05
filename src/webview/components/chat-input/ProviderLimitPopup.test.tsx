import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderLimitStatus } from '../../../shared/protocol';
import { hasProviderLimitWindowWithinThreshold } from '../../lib/format';
import { ProviderLimitPopup } from './ProviderLimitPopup';

describe('ProviderLimitPopup', () => {
  let dispose: (() => void) | undefined;
  let container: HTMLDivElement;

  afterEach(() => {
    dispose?.();
    container?.remove();
    Reflect.deleteProperty(window, '__sendToExtension');
    vi.clearAllMocks();
  });

  it.each([62_500, 0, undefined])(
    'shows the credit balance %s separately from quotas',
    (balance) => {
      const limit: ProviderLimitStatus = {
        providerID: 'openai',
        status: 'available',
        source: 'provider',
        checkedAt: 1,
        creditBalance: balance,
        windows: [
          {
            id: 'five_hour',
            label: '5-Hour Limit',
            unit: 'unknown',
            remaining: 80,
            limit: 100,
            resetAt: null,
            percent: 20,
          },
        ],
      };
      container = document.createElement('div');
      document.body.append(container);
      dispose = render(
        () => <ProviderLimitPopup providerName="OpenAI" onClose={() => {}} limit={limit} />,
        container
      );

      const credits = container.querySelector('.provider-limit-credit-section');
      if (balance === undefined) {
        expect(credits).toBeNull();
      } else {
        expect(credits?.querySelector('.provider-limit-row-label')?.textContent).toBe('Credits');
        expect(credits?.querySelector('.provider-limit-row-pct')?.textContent).toBe(
          balance.toLocaleString()
        );
        expect(credits?.querySelector('.provider-limit-row-bar')).toBeNull();
      }
      expect(container.querySelectorAll('.provider-limit-row-bar')).toHaveLength(1);
      expect(hasProviderLimitWindowWithinThreshold(limit, 10)).toBe(false);
    }
  );

  it('expands Grok reset expiration details and opens Grok Usage', () => {
    const sendToExtension = vi.fn();
    Reflect.set(window, '__sendToExtension', sendToExtension);
    container = document.createElement('div');
    document.body.append(container);
    const expiresAt = Date.parse('2026-09-12T12:00:00Z');
    dispose = render(
      () => (
        <ProviderLimitPopup
          providerName="xAI"
          onClose={() => {}}
          limit={{
            providerID: 'xai',
            modelID: null,
            status: 'available',
            source: 'provider',
            checkedAt: 1,
            windows: [
              {
                id: 'credits',
                label: 'Weekly Credits',
                unit: 'credits',
                remaining: 89,
                limit: 100,
                resetAt: null,
                percent: 11,
              },
            ],
            usageLimitResets: {
              availableCount: 1,
              credits: [{ title: 'Weekly quota reset', expiresAt }],
            },
          }}
        />
      ),
      container
    );

    const toggle = container.querySelector<HTMLButtonElement>('.provider-limit-reset-toggle');
    expect(toggle?.textContent).toBe('Usage limit resets (1)');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.provider-limit-reset-rows')).toBeNull();

    toggle?.click();

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.provider-limit-reset-rows')?.textContent).toBe(
      `Expires ${new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(expiresAt)}`
    );
    const link = container.querySelector<HTMLAnchorElement>('.provider-limit-reset-link');
    expect(link?.textContent).toBe('Grok Usage');
    expect(link?.href).toBe('https://grok.com/?_s=usage');
    link?.click();
    expect(sendToExtension).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://grok.com/?_s=usage' },
    });
    expect(sendToExtension).toHaveBeenCalledTimes(1);

    toggle?.click();
    expect(container.querySelector('.provider-limit-reset-rows')).toBeNull();
  });
});
