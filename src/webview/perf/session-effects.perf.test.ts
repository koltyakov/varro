import { storePath } from '@solidjs/signals';
import { describe, expect, it, vi } from 'vitest';
import { registerProviderLimitRefreshEffect } from '../hooks/session/session-effects';
import { getActiveProviderSelection, isProviderWorking } from '../hooks/routing-state';
import { createAppState } from '../lib/state';
import type { Provider } from '../types';
import type { ProviderLimitStatus } from '../../shared/protocol';
import {
  createPerfRoot,
  expectEffectDependencyIsolation,
  settlePerfEffects,
  createAssistantMessage,
} from './harness';
import { deferred } from '../test-fixtures';

function createProvider(): Provider {
  return {
    id: 'openai',
    name: 'OpenAI',
    source: 'api',
    models: {
      'gpt-4o': {
        id: 'gpt-4o',
        name: 'GPT-4o',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
    },
  };
}

describe('session effects perf guards', () => {
  it('does not rerun provider-limit polling when messages state changes', async () => {
    const appState = createAppState();
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    const loadProviderLimit = vi.fn(async () => null);
    const logError = vi.fn();

    appState.setState(storePath('serverStatus', { state: 'running' }));
    appState.setState(storePath('providersLoaded', true));
    appState.setState(storePath('providers', [createProvider()]));
    appState.setState(storePath('providerDefaults', { openai: 'gpt-4o' }));
    appState.setState(storePath('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' }));
    appState.setState(storePath('sessionStatus', 'background', { type: 'busy' }));
    appState.setState(
      storePath('sessionSelectedModels', 'background', {
        providerID: 'openai',
        modelID: 'gpt-4o',
      })
    );

    const dispose = createPerfRoot(() => {
      registerProviderLimitRefreshEffect({
        getServerState: () => appState.state.serverStatus.state,
        areProvidersLoaded: () => appState.state.providersLoaded,
        isDocumentVisible: () => true,
        isProviderWorking: (providerID) =>
          isProviderWorking(
            providerID,
            appState.state.sessionStatus,
            (sessionId) => appState.state.sessionSelectedModels[sessionId]?.providerID
          ),
        getRequestScope: () => 0,
        getActiveProviderSelection: () =>
          getActiveProviderSelection({
            selectedModel: appState.state.selectedModel,
            providers: appState.state.providers,
            providerDefaults: appState.state.providerDefaults,
          }),
        getProviderLimit: (providerID, modelID) =>
          appState.state.providerLimits[`${providerID}:${modelID ?? ''}`] ?? null,
        loadProviderLimit,
        setProviderLimit: (providerID, modelID, limit) => {
          appState.setState(storePath('providerLimits', `${providerID}:${modelID ?? ''}`, limit));
        },
        getPollIntervalMs: () => 120_000,
        logError,
      });
    });

    try {
      await settlePerfEffects();
      expect(loadProviderLimit).toHaveBeenCalledTimes(1);

      await expectEffectDependencyIsolation({
        label: 'provider-limit refresh effect',
        getCount: () => loadProviderLimit.mock.calls.length,
        mutate: () => {
          appState.setState(
            storePath('messages', [{ info: createAssistantMessage('message-1'), parts: [] }])
          );
        },
      });

      await expectEffectDependencyIsolation({
        label: 'provider-limit busy/retry transitions',
        getCount: () => loadProviderLimit.mock.calls.length,
        mutate: () => {
          appState.setState(
            storePath('sessionStatus', 'background', {
              type: 'retry',
              attempt: 2,
              message: 'Retrying',
              next: 1000,
            })
          );
        },
      });

      expect(logError).not.toHaveBeenCalled();
    } finally {
      dispose();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
    }
  });

  it('does not overlap provider-limit polling while a refresh is in flight', async () => {
    vi.useFakeTimers();
    const appState = createAppState();
    const pendingLimit = deferred<ProviderLimitStatus | null>();
    const loadProviderLimit = vi.fn(() => pendingLimit.promise);
    const logError = vi.fn();

    appState.setState(storePath('serverStatus', { state: 'running' }));
    appState.setState(storePath('providersLoaded', true));
    appState.setState(storePath('providers', [createProvider()]));
    appState.setState(storePath('providerDefaults', { openai: 'gpt-4o' }));
    appState.setState(storePath('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' }));

    const dispose = createPerfRoot(() => {
      registerProviderLimitRefreshEffect({
        getServerState: () => appState.state.serverStatus.state,
        areProvidersLoaded: () => appState.state.providersLoaded,
        isDocumentVisible: () => true,
        isProviderWorking: () => false,
        getRequestScope: () => 0,
        getActiveProviderSelection: () =>
          getActiveProviderSelection({
            selectedModel: appState.state.selectedModel,
            providers: appState.state.providers,
            providerDefaults: appState.state.providerDefaults,
          }),
        getProviderLimit: (providerID, modelID) =>
          appState.state.providerLimits[`${providerID}:${modelID ?? ''}`] ?? null,
        loadProviderLimit,
        setProviderLimit: (providerID, modelID, limit) => {
          appState.setState(storePath('providerLimits', `${providerID}:${modelID ?? ''}`, limit));
        },
        getPollIntervalMs: () => 10,
        logError,
      });
    });

    try {
      await settlePerfEffects();
      expect(loadProviderLimit).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(50);
      expect(loadProviderLimit).toHaveBeenCalledTimes(1);

      pendingLimit.resolve(null);
      await settlePerfEffects();
      await vi.advanceTimersByTimeAsync(10);

      expect(loadProviderLimit).toHaveBeenCalledTimes(2);
      expect(logError).not.toHaveBeenCalled();
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });
});
