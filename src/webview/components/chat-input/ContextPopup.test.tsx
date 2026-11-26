import { createSignal, flush as flushSolid } from 'solid-js';
import { render } from '@solidjs/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContextPopup,
  type PromptCacheActivity,
  type PromptCacheWarmingView,
} from './ContextPopup';

const LIFETIME = {
  ttlMs: 5 * 60_000,
  likelyMs: 5 * 60_000,
  description: 'Claude keeps the cache 5 min.',
};
const tokens = { total: 0, input: 10, output: 5, reasoning: 0, cacheRead: 100, cacheWrite: 0 };
const emptyTokens = { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

function mount(
  promptCache: () => PromptCacheActivity | null,
  warming: () => PromptCacheWarmingView | null = () => null,
  onToggleWarming?: (enabled: boolean) => void
) {
  cleanup = render(
    () => (
      <ContextPopup
        usage={{ used: 1000, limit: 10000, percent: 10 }}
        breakdown={[]}
        nestedBreakdown={[]}
        tokens={tokens}
        subagentTokens={emptyTokens}
        subagentCount={0}
        model={{ providerName: '', modelName: '' }}
        promptCache={promptCache()}
        warming={warming()}
        onToggleWarming={onToggleWarming}
        compactDisabled
        onClose={() => {}}
        onCompact={() => {}}
      />
    ),
    container
  );
  flushSolid();
}

function cacheStatus() {
  const value = container.querySelector('.context-popup-prompt-cache .context-popup-row-value');
  const countdown = value?.querySelector('.context-popup-prompt-cache-countdown')?.textContent;
  const text = value?.firstChild?.textContent;
  return countdown ? `${text} ${countdown}` : value?.textContent;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  cleanup?.();
  flushSolid();
  cleanup = undefined;
  container.remove();
  vi.useRealTimers();
});

describe('ContextPopup prompt cache', () => {
  it('counts down the estimated warm window and then reports it as likely expired', async () => {
    mount(() => ({ lastUsedAt: 1_000_000 - 60_000, inUse: false, ...LIFETIME }));
    expect(cacheStatus()).toBe('Warm 4:00');

    await vi.advanceTimersByTimeAsync(3 * 60_000 + 30_000);
    flushSolid();
    expect(cacheStatus()).toBe('Warm 0:30');

    await vi.advanceTimersByTimeAsync(31_000);
    flushSolid();
    expect(cacheStatus()).toBe('Likely expired');
    expect(container.querySelector('.context-popup-prompt-cache')?.getAttribute('data-tone')).toBe(
      'cold'
    );
  });

  it("counts down the model's own lifetime, with hours for long caches", () => {
    mount(() => ({
      lastUsedAt: 1_000_000,
      inUse: false,
      ttlMs: 60 * 60_000,
      likelyMs: 60 * 60_000,
      description: 'Claude keeps the cache 1 h (cache.ttl).',
    }));
    expect(cacheStatus()).toBe('Warm 1:00:00');
  });

  it("reports a cache past the provider's minimum as maybe warm until its usual lifetime", async () => {
    mount(() => ({
      lastUsedAt: 1_000_000,
      inUse: false,
      ttlMs: 30 * 60_000,
      likelyMs: 3 * 60 * 60_000,
      description: 'OpenAI keeps the cache at least 30 min, and often up to about 3 h.',
    }));
    expect(cacheStatus()).toBe('Warm 30:00');

    await vi.advanceTimersByTimeAsync(31 * 60_000);
    flushSolid();
    expect(cacheStatus()).toBe('May be warm');

    await vi.advanceTimersByTimeAsync(150 * 60_000);
    flushSolid();
    expect(cacheStatus()).toBe('Likely expired');
  });

  it('shows in-use while the session works and hides without cache activity', () => {
    const [activity, setActivity] = createSignal<PromptCacheActivity | null>({
      lastUsedAt: 0,
      inUse: true,
      ...LIFETIME,
    });
    mount(activity);
    expect(cacheStatus()).toBe('In use');

    setActivity(null);
    flushSolid();
    expect(container.querySelector('.context-popup-prompt-cache')).toBeNull();
  });
});

describe('ContextPopup keep warm', () => {
  const warmActivity = () => ({ lastUsedAt: 1_000_000, inUse: false, ...LIFETIME });
  const warmingStatus = () =>
    [
      container.querySelector('.context-popup-warming-status')?.textContent,
      container.querySelector('.context-popup-warming-detail')?.textContent,
    ]
      .filter(Boolean)
      .join(' · ') || null;

  it('offers a per-session toggle with the keep-alive cost while off', () => {
    const onToggle = vi.fn();
    mount(
      warmActivity,
      () => ({
        kind: 'chosen',
        enabled: false,
        session: null,
        ttlMs: 5 * 60_000,
        durationMs: 30 * 60_000,
      }),
      onToggle
    );
    expect(warmingStatus()).toBe('Off · Re-reads ~1K cached tokens every 4m while on');
    const checkbox = container.querySelector<HTMLInputElement>(
      '.context-popup-warming-toggle input'
    );
    expect(checkbox?.checked).toBe(false);
    checkbox?.click();
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('says no keep-alive is needed when the cache outlives the window', () => {
    mount(warmActivity, () => ({
      kind: 'chosen',
      enabled: false,
      session: null,
      ttlMs: 60 * 60_000,
      durationMs: 30 * 60_000,
    }));
    expect(warmingStatus()).toBe('Off · Not needed: the cache lasts 1h after each request');
  });

  it('reports the remaining window and why warming stopped', () => {
    const [view, setView] = createSignal<PromptCacheWarmingView | null>({
      kind: 'chosen',
      enabled: true,
      session: {
        warmUntil: 1_000_000 + 25 * 60_000,
        sentAt: 1_000_000,
        ttlMs: 5 * 60_000,
        stopped: null,
      },
      ttlMs: 5 * 60_000,
      durationMs: 30 * 60_000,
    });
    mount(warmActivity, view);
    expect(warmingStatus()).toBe('25m left');

    setView({
      kind: 'chosen',
      enabled: true,
      session: {
        warmUntil: 1_000_000 + 25 * 60_000,
        sentAt: 1_000_000,
        ttlMs: 30 * 60_000,
        stopped: null,
      },
      ttlMs: 30 * 60_000,
      durationMs: 30 * 60_000,
    });
    flushSolid();
    expect(warmingStatus()).toBe('25m left · No keep-alive needed');

    setView({
      kind: 'chosen',
      enabled: true,
      session: { warmUntil: null, sentAt: null, ttlMs: null, stopped: 'cache-miss' },
      ttlMs: 5 * 60_000,
      durationMs: 30 * 60_000,
    });
    flushSolid();
    expect(warmingStatus()).toBe('Stopped · The cache had already expired');

    setView({ kind: 'opencode' });
    flushSolid();
    expect(container.textContent).toContain('Kept warm by OpenCode');
    expect(container.querySelector('.context-popup-warming-toggle')).toBeNull();
  });
});
