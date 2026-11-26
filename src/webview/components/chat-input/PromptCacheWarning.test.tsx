import { createSignal, flush as flushSolid } from 'solid-js';
import { render } from '@solidjs/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptCacheActivity } from './ContextPopup';
import { PromptCacheWarning } from './PromptCacheWarning';

const THRESHOLD = 100_000;

const NOW = 10_000_000;
let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

function warning() {
  return container.querySelector('.chat-prompt-cache-warning');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
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

describe('PromptCacheWarning', () => {
  it('appears when a large idle session reaches the estimated expiry', async () => {
    cleanup = render(
      () => (
        <PromptCacheWarning
          sessionId="ses_expiry"
          activity={{ lastUsedAt: NOW - 4 * 60_000, inUse: false }}
          contextTokens={127_400}
          thresholdTokens={THRESHOLD}
        />
      ),
      container
    );
    flushSolid();
    expect(warning()).toBeNull();

    await vi.advanceTimersByTimeAsync(60_000);
    flushSolid();
    expect(warning()?.textContent).toContain('Prompt cache likely expired');
    expect(warning()?.textContent).toContain('re-sends 127.4K tokens uncached');
  });

  it('stays hidden for working sessions, below the threshold, or when turned off', () => {
    const [activity, setActivity] = createSignal<PromptCacheActivity>({
      lastUsedAt: NOW - 10 * 60_000,
      inUse: true,
    });
    const [tokens, setTokens] = createSignal(THRESHOLD);
    const [threshold, setThreshold] = createSignal(THRESHOLD);
    cleanup = render(
      () => (
        <PromptCacheWarning
          sessionId="ses_small"
          activity={activity()}
          contextTokens={tokens()}
          thresholdTokens={threshold()}
        />
      ),
      container
    );
    flushSolid();
    expect(warning()).toBeNull();

    setActivity({ lastUsedAt: NOW - 10 * 60_000, inUse: false });
    flushSolid();
    expect(warning()).not.toBeNull();

    setTokens(THRESHOLD - 1);
    flushSolid();
    expect(warning()).toBeNull();

    setThreshold(50_000);
    flushSolid();
    expect(warning()).not.toBeNull();

    setThreshold(0);
    flushSolid();
    expect(warning()).toBeNull();
  });

  it('stays dismissed for that expiry and returns after the cache is used again', () => {
    const [activity, setActivity] = createSignal<PromptCacheActivity>({
      lastUsedAt: NOW - 10 * 60_000,
      inUse: false,
    });
    cleanup = render(
      () => (
        <PromptCacheWarning
          sessionId="ses_dismiss"
          activity={activity()}
          contextTokens={120_000}
          thresholdTokens={THRESHOLD}
        />
      ),
      container
    );
    flushSolid();
    container
      .querySelector<HTMLButtonElement>('[aria-label="Dismiss prompt cache warning"]')!
      .click();
    flushSolid();
    expect(warning()).toBeNull();

    setActivity({ lastUsedAt: NOW - 8 * 60_000, inUse: false });
    flushSolid();
    expect(warning()).not.toBeNull();
  });
});
