import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderLimitStatus, ProviderLimitWindow } from '../../../shared/protocol';
import { STORAGE_KEYS, writeStored } from '../../lib/state-storage';
import { ProviderQuotaWarning } from './ProviderQuotaWarning';
import { getLowQuotaWindows, quotaWarningDismissals } from './provider-quota-warning';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const HOUR = 60 * 60_000;

function quota(
  id: string,
  remaining: number,
  resetAt: number | null = NOW + HOUR
): ProviderLimitWindow {
  return { id, label: id, unit: 'unknown', remaining, limit: 100, resetAt };
}

function snapshot(
  windows: ProviderLimitWindow[],
  providerID = 'openai'
): Extract<ProviderLimitStatus, { status: 'available' }> {
  return { providerID, status: 'available', source: 'provider', checkedAt: Date.now(), windows };
}

let container: HTMLDivElement;
let dispose: (() => void) | undefined;
const sendToExtension = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  writeStored(STORAGE_KEYS.quotaWarningDismissals, null);
  quotaWarningDismissals.reload();
  container = document.createElement('div');
  document.body.append(container);
  sendToExtension.mockClear();
  Reflect.set(window, '__sendToExtension', sendToExtension);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
  writeStored(STORAGE_KEYS.quotaWarningDismissals, null);
  vi.useRealTimers();
  Reflect.deleteProperty(window, '__sendToExtension');
});

function mount(initial: ProviderLimitStatus, modelID = 'gpt-6') {
  const [limit, setLimit] = createSignal<ProviderLimitStatus | null>(initial);
  const [model, setModel] = createSignal(modelID);
  const [forceShow, setForceShow] = createSignal(false);
  const onRefresh = vi.fn();
  const mountBanner = () => {
    dispose = render(
      () => (
        <ProviderQuotaWarning
          limit={limit()}
          modelID={model()}
          modelName={model()}
          providerName={limit()?.providerID ?? ''}
          forceShow={forceShow()}
          onRefresh={onRefresh}
        />
      ),
      container
    );
  };
  mountBanner();
  return {
    setLimit,
    setModel,
    setForceShow,
    onRefresh,
    remount: () => {
      dispose?.();
      mountBanner();
    },
  };
}

function banner() {
  return container.querySelector('.chat-quota-warning');
}

function dismiss() {
  container.querySelector<HTMLButtonElement>('.chat-quota-warning-close')!.click();
}

describe('ProviderQuotaWarning', () => {
  it('previews healthy quotas and saved dismissals without persisting debug closes', () => {
    const windows = [quota('weekly', 80), quota('five_hour', 100)];
    quotaWarningDismissals.dismiss('openai', windows, NOW);
    const saved = quotaWarningDismissals.read();
    const { setForceShow } = mount(snapshot(windows));
    expect(banner()).toBeNull();

    setForceShow(true);
    expect(banner()?.textContent).toContain('weekly: 80% left');
    expect(banner()?.textContent).toContain('five_hour: 100% left');
    dismiss();
    expect(banner()).toBeNull();
    expect(quotaWarningDismissals.read()).toEqual(saved);

    setForceShow(false);
    setForceShow(true);
    expect(banner()).not.toBeNull();
    setForceShow(false);
    expect(banner()).toBeNull();
  });

  it.each([
    { windows: [quota('weekly', 8)], labels: ['weekly: 8% left'], critical: true },
    {
      windows: [quota('five_hour', 90), quota('weekly', 8)],
      labels: ['weekly: 8% left'],
      critical: true,
    },
    {
      windows: [quota('five_hour', 8), quota('weekly', 90)],
      labels: ['five_hour: 8% left'],
      critical: true,
    },
    {
      windows: [quota('five_hour', 8), quota('weekly', 15)],
      labels: ['five_hour: 8% left', 'weekly: 15% left'],
      critical: true,
    },
    {
      windows: [quota('five_hour', 0), quota('weekly', 0)],
      labels: ['five_hour: 0% left', 'weekly: 0% left'],
      critical: true,
    },
    { windows: [quota('monthly', 12)], labels: ['monthly: 12% left'], critical: false },
    { windows: [quota('weekly', 25)], labels: ['weekly: 25% left'], critical: false },
    { windows: [quota('weekly', 10)], labels: ['weekly: 10% left'], critical: true },
    { windows: [quota('weekly', 25.01), quota('five_hour', 100)], labels: [], critical: false },
  ])('selects low windows and severity for $windows', ({ windows, labels, critical }) => {
    mount(snapshot(windows));
    expect(
      Array.from(
        container.querySelectorAll('.chat-quota-warning-row > span:first-child'),
        (row) => row.textContent
      )
    ).toEqual(labels);
    expect(banner()?.classList.contains('error') ?? false).toBe(critical);
    expect(banner() !== null).toBe(labels.length > 0);
  });

  it('orders the most depleted window first and associates each reset with its own label', () => {
    mount(
      snapshot([
        { ...quota('five_hour', 15, NOW + 32 * 60_000), label: '5-hour limit' },
        { ...quota('weekly', 8, NOW + 76 * HOUR), label: 'Weekly limit' },
      ])
    );
    expect(
      Array.from(container.querySelectorAll('.chat-quota-warning-row'), (row) => row.textContent)
    ).toEqual([
      'Weekly limit: 8% left · resets in 3d 4h',
      '5-hour limit: 15% left · resets in 32m',
    ]);
  });

  it('uses reported percentages with missing bounds and does not guess unknown usage', () => {
    mount(
      snapshot([
        { ...quota('weekly', 10), limit: null, percent: 94 },
        { ...quota('unknown', 1), limit: null },
      ])
    );
    expect(banner()?.textContent).toContain('weekly: 6% left');
    expect(banner()?.textContent).not.toContain('unknown');
  });

  it('filters unrelated operation and model quotas while preserving account and extra-usage limits', () => {
    const limit = snapshot(
      [
        quota('seven_day', 12),
        quota('seven_day_sonnet', 2),
        quota('seven_day_opus', 3),
        quota('extra_usage', 4),
        quota('code_review', 0),
        quota('mcp', 0),
        quota('seven_day_cowork', 0),
        quota('spark_five_hour', 0),
      ],
      'anthropic'
    );
    const { setModel } = mount(limit, 'claude-opus-4-6');
    expect(
      Array.from(
        container.querySelectorAll('.chat-quota-warning-row > span:first-child'),
        (row) => row.textContent
      )
    ).toEqual(['seven_day_opus: 3% left', 'extra_usage: 4% left', 'seven_day: 12% left']);
    setModel('claude-sonnet-4-6');
    expect(banner()?.textContent).toContain('seven_day_sonnet: 2% left');
    expect(banner()?.textContent).not.toContain('seven_day_opus');
  });

  it('uses Spark windows only for Spark models', () => {
    const windows = [quota('five_hour', 2), quota('spark_seven_day', 8)];
    expect(
      getLowQuotaWindows(snapshot(windows), 'gpt-5.3-codex-spark', 'Codex Spark').map(
        (window) => window.id
      )
    ).toEqual(['spark_seven_day']);
  });

  it('keeps provider dismissals through polling, model switches and remounts without hiding a newly low window', () => {
    const weekly = quota('weekly', 8, NOW + 76 * HOUR);
    const { setLimit, setModel, remount } = mount(snapshot([quota('five_hour', 90), weekly]));
    dismiss();
    expect(banner()).toBeNull();
    setLimit(snapshot([quota('five_hour', 90), { ...weekly, remaining: 1 }]));
    setModel('gpt-6-sol');
    remount();
    expect(banner()).toBeNull();
    setLimit(snapshot([weekly], 'anthropic'));
    expect(banner()?.textContent).toContain('weekly');
    setLimit(snapshot([quota('five_hour', 8), weekly]));
    expect(banner()?.textContent).toContain('five_hour');
    expect(banner()?.textContent).not.toContain('weekly');
  });

  it('restores a dismissed yellow warning at the red threshold, then keeps red dismissed until renewal', () => {
    const weekly = quota('weekly', 20, NOW + 76 * HOUR);
    const { setLimit, remount } = mount(snapshot([weekly]));
    expect(banner()?.classList.contains('error')).toBe(false);
    expect(container.querySelector('.chat-quota-warning-close')?.getAttribute('title')).toContain(
      'until quota becomes critical'
    );
    dismiss();
    remount();
    expect(banner()).toBeNull();
    setLimit(snapshot([{ ...weekly, remaining: 10.01 }]));
    expect(banner()).toBeNull();
    setLimit(snapshot([{ ...weekly, remaining: 10 }]));
    expect(banner()?.classList.contains('error')).toBe(true);
    expect(banner()?.textContent).toContain('weekly: 10% left');
    expect(container.querySelector('.chat-quota-warning-close')?.getAttribute('title')).toContain(
      'until quota resets'
    );
    dismiss();
    remount();
    expect(banner()).toBeNull();
    setLimit(snapshot([{ ...weekly, remaining: 0 }]));
    expect(banner()).toBeNull();
    setLimit(snapshot([{ ...weekly, remaining: 20 }]));
    expect(banner()).toBeNull();
    setLimit(snapshot([{ ...weekly, resetAt: NOW + 168 * HOUR }]));
    expect(banner()?.textContent).toContain('weekly: 20% left');
  });

  it('tracks severity per window when dismissing a mix of yellow and red quotas', () => {
    const fiveHour = quota('five_hour', 8);
    const weekly = quota('weekly', 20, NOW + 76 * HOUR);
    const { setLimit, remount } = mount(snapshot([fiveHour, weekly]));
    dismiss();
    remount();
    expect(banner()).toBeNull();
    setLimit(
      snapshot([
        { ...fiveHour, remaining: 0 },
        { ...weekly, remaining: 10 },
      ])
    );
    expect(banner()?.textContent).toContain('weekly: 10% left');
    expect(banner()?.textContent).not.toContain('five_hour');
    dismiss();
    remount();
    expect(banner()).toBeNull();
  });

  it('allows critical warnings after dismissals saved without severity', () => {
    writeStored(STORAGE_KEYS.quotaWarningDismissals, [
      { providerID: 'openai', windowID: 'weekly', resetAt: NOW + HOUR, expiresAt: NOW + HOUR },
    ]);
    quotaWarningDismissals.reload();
    const { setLimit, remount } = mount(snapshot([quota('weekly', 20)]));
    expect(banner()).toBeNull();
    setLimit(snapshot([quota('weekly', 10)]));
    expect(banner()?.classList.contains('error')).toBe(true);
    dismiss();
    remount();
    expect(banner()).toBeNull();
  });

  it('dismisses multiple windows until their individual resets and waits for fresh quota data', () => {
    const fiveHour = quota('five_hour', 8, NOW + 2_000);
    const weekly = quota('weekly', 15, NOW + 76 * HOUR);
    const { setLimit, onRefresh } = mount(snapshot([fiveHour, weekly]));
    dismiss();
    vi.advanceTimersByTime(2_000);
    expect(banner()).toBeNull();
    expect(onRefresh).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10_000);
    setLimit(snapshot([fiveHour, weekly]));
    expect(banner()).toBeNull();
    expect(onRefresh).toHaveBeenCalledOnce();
    setLimit(snapshot([quota('five_hour', 100, Date.now() + HOUR), weekly]));
    expect(banner()).toBeNull();
    setLimit(snapshot([quota('five_hour', 20, Date.now() + HOUR), weekly]));
    expect(banner()?.textContent).toContain('five_hour: 20% left');
    expect(banner()?.textContent).not.toContain('weekly');
  });

  it('recognizes an early provider reset as a new quota cycle', () => {
    const { setLimit } = mount(snapshot([quota('weekly', 8, NOW + 76 * HOUR)]));
    dismiss();
    setLimit(snapshot([quota('weekly', 100, NOW + 168 * HOUR)]));
    expect(banner()).toBeNull();
    setLimit(snapshot([quota('weekly', 8, NOW + 168 * HOUR)]));
    expect(banner()).not.toBeNull();
  });

  it('uses a one-hour fallback when reset time is unknown without extending it on reload', () => {
    const { remount } = mount(snapshot([quota('weekly', 8, null)]));
    expect(banner()?.textContent).not.toContain('resets');
    dismiss();
    vi.advanceTimersByTime(HOUR - 1_000);
    remount();
    expect(banner()).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(banner()).not.toBeNull();
  });

  it('ignores corrupt persisted dismissal data', () => {
    writeStored(STORAGE_KEYS.quotaWarningDismissals, [
      { providerID: 'openai', windowID: 'weekly', resetAt: NOW + HOUR, expiresAt: 'forever' },
      null,
    ]);
    quotaWarningDismissals.reload();
    mount(snapshot([quota('weekly', 8)]));
    expect(banner()).not.toBeNull();
  });

  it('shares dismissal changes with another mounted composer and storage events', () => {
    mount(snapshot([quota('weekly', 8)]));
    quotaWarningDismissals.dismiss('openai', [quota('weekly', 8)], NOW);
    expect(banner()).toBeNull();
    writeStored(STORAGE_KEYS.quotaWarningDismissals, []);
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEYS.quotaWarningDismissals }));
    expect(banner()).not.toBeNull();
  });

  it.each([
    ['openai', 'https://chatgpt.com/#settings/Usage'],
    ['anthropic', 'https://claude.ai/settings/usage'],
  ])('opens %s usage in the external browser', (providerID, url) => {
    mount({
      ...snapshot([quota('extra_usage', 4), quota('five_hour', 90)], providerID),
      usageLimitResets: { availableCount: 2, credits: null },
    });
    const link = container.querySelector<HTMLAnchorElement>('.chat-quota-warning-usage')!;
    expect(link.href).toBe(url);
    link.click();
    expect(sendToExtension).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url },
    });
    expect(sendToExtension).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.provider-limit-popup')).toBeNull();
  });

  it('updates available resets and hides missing or zero counts', () => {
    const { setLimit } = mount(snapshot([quota('weekly', 8)]));
    expect(container.querySelector('.chat-quota-warning-usage')).toBeNull();
    for (const count of [1, 3, 0]) {
      setLimit({
        ...snapshot([quota('weekly', 8)]),
        usageLimitResets: { availableCount: count, credits: null },
      });
      const link = container.querySelector('.chat-quota-warning-usage');
      if (count === 0) expect(link).toBeNull();
      else expect(link?.textContent).toBe(`${count} ${count === 1 ? 'reset' : 'resets'} available`);
    }
    setLimit({
      ...snapshot([quota('weekly', 8)], 'custom-provider'),
      usageLimitResets: { availableCount: 2, credits: null },
    });
    expect(banner()?.textContent).toContain('2 resets available');
    expect(container.querySelector('.chat-quota-warning-usage')).toBeNull();
    expect(banner()?.textContent).not.toContain('View usage');
  });

  it('removes warnings when quota recovers or becomes unavailable', () => {
    const { setLimit } = mount(snapshot([quota('weekly', 8)]));
    setLimit(snapshot([quota('weekly', 80)]));
    expect(banner()).toBeNull();
    setLimit(snapshot([quota('weekly', 8)]));
    expect(banner()).not.toBeNull();
    setLimit({
      providerID: 'openai',
      status: 'error',
      source: 'provider',
      checkedAt: NOW,
      note: 'Unavailable',
    });
    expect(banner()).toBeNull();
  });
});
