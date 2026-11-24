import { flush as flushSolid, createSignal } from 'solid-js';
import { render } from '@solidjs/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderLimitStatus } from '../../../shared/protocol';
import { hasProviderLimitWindowWithinThreshold } from '../../lib/format';
import { ProviderLimitPopup } from './ProviderLimitPopup';

describe('ProviderLimitPopup', () => {
  let dispose: (() => void) | undefined;
  let container: HTMLDivElement;

  afterEach(() => {
    dispose?.();
    flushSolid();
    container?.remove();
    flushSolid();
    Reflect.deleteProperty(window, '__sendToExtension');
    flushSolid();
    vi.clearAllMocks();
    flushSolid();
    vi.useRealTimers();
  });

  it.each([62_500, 0.5, 0, undefined])(
    'shows only nonzero credit balances separately from quotas, balance=%s',
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
      flushSolid();

      const credits = container.querySelector('.provider-limit-credit-section');
      if (balance === undefined || balance === 0) {
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

  it('names Claude Agent quotas after the Claude Code subscription', () => {
    container = document.createElement('div');
    document.body.append(container);
    dispose = render(
      () => (
        <ProviderLimitPopup
          providerName="Claude Agent"
          onClose={() => {}}
          limit={{
            providerID: 'claude-agent',
            status: 'available',
            source: 'provider',
            checkedAt: 1,
            planName: 'Max 5x',
            windows: [],
          }}
        />
      ),
      container
    );
    flushSolid();

    expect(container.querySelector('.provider-limit-popup-provider')?.textContent).toBe(
      'Claude Code · Max 5x'
    );
  });

  it('shows the empty state when the credit balance is zero and there are no quotas', () => {
    container = document.createElement('div');
    document.body.append(container);
    dispose = render(
      () => (
        <ProviderLimitPopup
          providerName="OpenAI"
          onClose={() => {}}
          limit={{
            providerID: 'openai',
            status: 'available',
            source: 'provider',
            checkedAt: 1,
            creditBalance: 0,
            windows: [],
          }}
        />
      ),
      container
    );
    flushSolid();

    expect(container.querySelector('.provider-limit-credit-section')).toBeNull();
    expect(container.querySelector('.provider-limit-popup-empty')?.textContent).toBe(
      'No active limits'
    );
  });

  it('expands Grok reset expiration details and opens Grok Usage', () => {
    const sendToExtension = vi.fn();
    Reflect.set(window, '__sendToExtension', sendToExtension);
    flushSolid();
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
    flushSolid();

    const toggle = container.querySelector<HTMLButtonElement>('.provider-limit-reset-toggle');
    expect(toggle?.textContent).toBe('Usage limit resets (1)');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.provider-limit-reset-rows')).toBeNull();

    toggle?.click();
    flushSolid();

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.provider-limit-reset-rows')?.textContent).toBe(
      `Expires ${new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(expiresAt)}`
    );
    const link = container.querySelector<HTMLAnchorElement>('.provider-limit-reset-link');
    expect(link?.textContent).toBe('Grok Usage');
    expect(link?.href).toBe('https://grok.com/?_s=usage');
    link?.click();
    flushSolid();
    expect(sendToExtension).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://grok.com/?_s=usage' },
    });
    expect(sendToExtension).toHaveBeenCalledTimes(1);

    toggle?.click();
    flushSolid();
    expect(container.querySelector('.provider-limit-reset-rows')).toBeNull();
  });

  it.each(['error', 'unsupported'] as const)('shows a quota %s reason and retry time', (status) => {
    const retryAt = Date.parse('2026-11-17T10:05:00Z');
    container = document.createElement('div');
    document.body.append(container);
    dispose = render(
      () => (
        <ProviderLimitPopup
          providerName="Z.ai"
          onClose={() => {}}
          limit={{
            providerID: 'zai',
            status,
            source: 'provider',
            checkedAt: Date.now(),
            retryAt,
            failureKind: status === 'unsupported' ? 'authentication' : undefined,
            note:
              status === 'unsupported'
                ? 'Z.ai quota endpoint rejected credentials (401)'
                : 'Z.ai quota endpoint returned invalid quota data',
          }}
        />
      ),
      container
    );
    flushSolid();
    const message = container.querySelector('[role="status"]')?.textContent;
    expect(message).toContain(
      status === 'unsupported' ? 'Authentication failed' : 'invalid quota data'
    );
    expect(container.textContent).toContain('Retry available at');
    expect(container.textContent).toContain(
      new Intl.DateTimeFormat(undefined, {
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(retryAt)
    );
    expect(container.querySelector('.provider-limit-row')).toBeNull();
  });

  it('marks retained quotas stale and expires their rows without another response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00Z'));
    flushSolid();
    const checkedAt = Date.now() - 15 * 60_000 + 1_000;
    container = document.createElement('div');
    document.body.append(container);
    dispose = render(
      () => (
        <ProviderLimitPopup
          providerName="Z.ai"
          onClose={() => {}}
          limit={{
            providerID: 'zai',
            status: 'available',
            source: 'provider',
            checkedAt,
            stale: true,
            retryAt: Date.now() + 15_000,
            note: 'Invalid quota data',
            windows: [
              {
                id: 'five_hour',
                label: '5-Hour Limit',
                unit: 'unknown',
                remaining: 75,
                limit: 100,
                resetAt: null,
              },
            ],
          }}
        />
      ),
      container
    );
    flushSolid();
    expect(container.querySelector('.provider-limit-row')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Quota data is stale'
    );
    expect(container.textContent).toContain('Invalid quota data');
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(container.querySelector('.provider-limit-row')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('snapshot expired');
  });

  it.each([false, true])('marks retained reset credits stale, resetsOnly=%s', (resetsOnly) => {
    const fresh: ProviderLimitStatus = {
      providerID: 'zai',
      status: 'available',
      source: 'provider',
      checkedAt: Date.now(),
      windows: [],
      usageLimitResets: {
        availableCount: 1,
        credits: [{ title: 'Weekly quota reset', expiresAt: null }],
        checkedAt: Date.now(),
      },
    };
    const [limit, setLimit] = createSignal(fresh);
    container = document.createElement('div');
    document.body.append(container);
    dispose = render(
      () => (
        <ProviderLimitPopup
          providerName="Z.ai"
          onClose={() => {}}
          limit={limit()}
          resetsOnly={resetsOnly}
        />
      ),
      container
    );
    flushSolid();
    expect(container.querySelector('[role="status"]')).toBeNull();
    setLimit({
      ...fresh,
      usageLimitResetsUnavailable: true,
      usageLimitResets: { ...fresh.usageLimitResets!, stale: true },
    });
    flushSolid();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Reset credits may be outdated'
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'latest refresh failed'
    );
    setLimit(fresh);
    flushSolid();
    expect(container.querySelector('[role="status"]')).toBeNull();
    setLimit({ ...fresh, usageLimitResets: undefined });
    flushSolid();
    expect(container.querySelector('.provider-limit-reset-section')).toBeNull();
  });
});
