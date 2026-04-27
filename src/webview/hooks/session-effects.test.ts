import { createRoot, createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import {
  registerLoadingStatusPollEffect,
  registerProviderLimitRefreshEffect,
} from './session-effects';

describe('session effect helpers', () => {
  it('polls active session status while loading and visible', async () => {
    vi.useFakeTimers();
    const [loading] = createSignal(true);
    const [activeSessionId] = createSignal<string | null>('session-1');
    const [visible] = createSignal(true);
    const recheckSessionStatus = vi.fn();

    const dispose = createRoot((cleanup) => {
      registerLoadingStatusPollEffect({
        isLoading: loading,
        getActiveSessionId: activeSessionId,
        isDocumentVisible: visible,
        recheckSessionStatus,
      });
      return cleanup;
    });

    try {
      await Promise.resolve();
      vi.advanceTimersByTime(8000);
      expect(recheckSessionStatus).toHaveBeenCalledWith('session-1');
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it('refreshes provider limits immediately and skips unsupported models', async () => {
    vi.useFakeTimers();
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    const loadProviderLimit = vi.fn(async () => null);
    const setProviderLimit = vi.fn();

    const dispose = createRoot((cleanup) => {
      registerProviderLimitRefreshEffect({
        getServerState: () => 'running',
        areProvidersLoaded: () => true,
        isDocumentVisible: () => true,
        getActiveProviderSelection: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
        getProviderLimit: () => null,
        loadProviderLimit,
        setProviderLimit,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(loadProviderLimit).toHaveBeenCalledWith('openai', 'gpt-4o');
      expect(setProviderLimit).toHaveBeenCalledWith('openai', 'gpt-4o', null);
    } finally {
      dispose();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
      vi.useRealTimers();
    }
  });

  it('does not refresh provider limits when the current model is unsupported', async () => {
    const loadProviderLimit = vi.fn(async () => null);

    const dispose = createRoot((cleanup) => {
      registerProviderLimitRefreshEffect({
        getServerState: () => 'running',
        areProvidersLoaded: () => true,
        isDocumentVisible: () => true,
        getActiveProviderSelection: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
        getProviderLimit: () => ({
          providerID: 'openai',
          modelID: 'gpt-4o',
          status: 'unsupported',
          source: 'provider',
          checkedAt: 1,
          note: 'Unsupported',
        }),
        loadProviderLimit,
        setProviderLimit: vi.fn(),
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await Promise.resolve();
      expect(loadProviderLimit).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});
