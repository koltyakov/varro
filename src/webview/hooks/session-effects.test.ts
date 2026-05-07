import { createRoot, createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import {
  registerLoadingStatusPollEffect,
  registerProviderLimitRefreshEffect,
} from './session/session-effects';

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
        getPollIntervalMs: () => 120_000,
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
        getPollIntervalMs: () => 120_000,
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

  it('refreshes provider limits for the active Ralph model when it differs from the composer model', async () => {
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
        getActiveProviderSelection: () => ({ providerID: 'openai', modelID: 'gpt-5' }),
        getProviderLimit: () => null,
        loadProviderLimit,
        setProviderLimit,
        getPollIntervalMs: () => 120_000,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(loadProviderLimit).toHaveBeenCalledWith('openai', 'gpt-5');
      expect(setProviderLimit).toHaveBeenCalledWith('openai', 'gpt-5', null);
    } finally {
      dispose();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
      vi.useRealTimers();
    }
  });

  it('uses the configured provider-limit refresh interval', async () => {
    vi.useFakeTimers();
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    const loadProviderLimit = vi.fn(async () => null);

    const dispose = createRoot((cleanup) => {
      registerProviderLimitRefreshEffect({
        getServerState: () => 'running',
        areProvidersLoaded: () => true,
        isDocumentVisible: () => true,
        getActiveProviderSelection: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
        getProviderLimit: () => null,
        loadProviderLimit,
        setProviderLimit: vi.fn(),
        getPollIntervalMs: () => 30_000,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await Promise.resolve();
      await Promise.resolve();
      loadProviderLimit.mockClear();

      vi.advanceTimersByTime(29_999);
      expect(loadProviderLimit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(loadProviderLimit).toHaveBeenCalledWith('openai', 'gpt-4o');
    } finally {
      dispose();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
      vi.useRealTimers();
    }
  });

  it('does not refresh provider limits when polling is disabled', async () => {
    vi.useFakeTimers();
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    const loadProviderLimit = vi.fn(async () => null);

    const dispose = createRoot((cleanup) => {
      registerProviderLimitRefreshEffect({
        getServerState: () => 'running',
        areProvidersLoaded: () => true,
        isDocumentVisible: () => true,
        getActiveProviderSelection: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
        getProviderLimit: () => null,
        loadProviderLimit,
        setProviderLimit: vi.fn(),
        getPollIntervalMs: () => -1,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(300_000);
      expect(loadProviderLimit).not.toHaveBeenCalled();
    } finally {
      dispose();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
      vi.useRealTimers();
    }
  });
});
