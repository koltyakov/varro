import { createRoot, createSignal, flush as flushSolid } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderSetupPrompt } from './provider-setup-prompt';

function setup(options: { providersAfterRefresh?: number } = {}) {
  const [ready, setReady] = createSignal(true);
  const [providerCount, setProviderCount] = createSignal(0);
  let refreshes = 0;
  const refreshProviders = vi.fn(async () => {
    refreshes += 1;
    if (options.providersAfterRefresh === refreshes) setProviderCount(1);
  });
  let dispose = () => {};
  const visible = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return createProviderSetupPrompt({
      isReady: ready,
      hasProviders: () => providerCount() > 0,
      refreshProviders,
    });
  });
  flushSolid();
  return { visible, setReady, setProviderCount, refreshProviders, dispose };
}

describe('createProviderSetupPrompt', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the prompt only after repeated reads stay empty', async () => {
    vi.useFakeTimers();
    const prompt = setup();

    expect(prompt.visible()).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000);
    flushSolid();
    expect(prompt.refreshProviders).toHaveBeenCalledTimes(2);
    expect(prompt.visible()).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    flushSolid();
    expect(prompt.refreshProviders).toHaveBeenCalledTimes(3);
    expect(prompt.visible()).toBe(true);
    prompt.dispose();
  });

  it('never shows the prompt when a retry finds providers', async () => {
    vi.useFakeTimers();
    const prompt = setup({ providersAfterRefresh: 1 });

    await vi.advanceTimersByTimeAsync(10_000);
    flushSolid();

    expect(prompt.refreshProviders).toHaveBeenCalledTimes(1);
    expect(prompt.visible()).toBe(false);
    prompt.dispose();
  });

  it('hides the prompt as soon as providers arrive', async () => {
    vi.useFakeTimers();
    const prompt = setup();
    await vi.advanceTimersByTimeAsync(6_000);
    flushSolid();
    expect(prompt.visible()).toBe(true);

    prompt.setProviderCount(2);
    flushSolid();

    expect(prompt.visible()).toBe(false);
    prompt.dispose();
  });

  it('does not start checking until the connection is ready', async () => {
    vi.useFakeTimers();
    const prompt = setup();
    prompt.setReady(false);
    flushSolid();
    prompt.dispose();

    const idle = setup();
    idle.setReady(false);
    flushSolid();
    await vi.advanceTimersByTimeAsync(10_000);
    flushSolid();
    expect(idle.visible()).toBe(false);
    idle.dispose();
  });
});
