import { describe, expect, it, vi } from 'vitest';
import { registerProviderLimitRefreshEffect } from '../hooks/session/session-effects';
import { getActiveProviderSelection } from '../hooks/routing-state';
import { createAppState } from '../lib/state';
import type { AssistantMessage, Provider } from '../types';
import type { ProviderLimitStatus } from '../../shared/protocol';
import { createPerfRoot, expectEffectDependencyIsolation, settlePerfEffects } from './harness';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

function createAssistantMessage(id: string): AssistantMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: 'parent-1',
    modelID: 'gpt-4o',
    providerID: 'openai',
    mode: 'default',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
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

    appState.setState('serverStatus', { state: 'running' });
    appState.setState('providersLoaded', true);
    appState.setState('providers', [createProvider()]);
    appState.setState('providerDefaults', { openai: 'gpt-4o' });
    appState.setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });

    const dispose = createPerfRoot(() => {
      registerProviderLimitRefreshEffect({
        getServerState: () => appState.state.serverStatus.state,
        areProvidersLoaded: () => appState.state.providersLoaded,
        isDocumentVisible: () => true,
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
          appState.setState('providerLimits', `${providerID}:${modelID ?? ''}`, limit);
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
          appState.setState('messages', [{ info: createAssistantMessage('message-1'), parts: [] }]);
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

    appState.setState('serverStatus', { state: 'running' });
    appState.setState('providersLoaded', true);
    appState.setState('providers', [createProvider()]);
    appState.setState('providerDefaults', { openai: 'gpt-4o' });
    appState.setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });

    const dispose = createPerfRoot(() => {
      registerProviderLimitRefreshEffect({
        getServerState: () => appState.state.serverStatus.state,
        areProvidersLoaded: () => appState.state.providersLoaded,
        isDocumentVisible: () => true,
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
          appState.setState('providerLimits', `${providerID}:${modelID ?? ''}`, limit);
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
