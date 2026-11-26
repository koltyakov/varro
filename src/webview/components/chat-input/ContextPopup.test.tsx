import { createSignal, flush as flushSolid } from 'solid-js';
import { render } from '@solidjs/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextPopup, type PromptCacheActivity } from './ContextPopup';

const tokens = { total: 0, input: 10, output: 5, reasoning: 0, cacheRead: 100, cacheWrite: 0 };
const emptyTokens = { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

function mount(promptCache: () => PromptCacheActivity | null) {
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
    mount(() => ({ lastUsedAt: 1_000_000 - 60_000, inUse: false }));
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

  it('shows in-use while the session works and hides without cache activity', () => {
    const [activity, setActivity] = createSignal<PromptCacheActivity | null>({
      lastUsedAt: 0,
      inUse: true,
    });
    mount(activity);
    expect(cacheStatus()).toBe('In use');

    setActivity(null);
    flushSolid();
    expect(container.querySelector('.context-popup-prompt-cache')).toBeNull();
  });
});
