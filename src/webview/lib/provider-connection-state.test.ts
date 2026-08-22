import { beforeEach, describe, expect, it } from 'vitest';

import {
  markProviderAuthFailure,
  providerAuthRestoredForMessage,
  providerRequiresReconnection,
  resetProviderConnectionState,
  resolveProviderAuthFailure,
} from './provider-connection-state';

describe('provider connection state', () => {
  beforeEach(() => resetProviderConnectionState());

  it('resolves every failed message for a provider after reauthentication', () => {
    markProviderAuthFailure('openai', 'message-1');
    markProviderAuthFailure('openai', 'message-2');

    resolveProviderAuthFailure('openai');

    expect(providerRequiresReconnection('openai')).toBe(false);
    expect(providerAuthRestoredForMessage('message-1')).toBe(true);
    expect(providerAuthRestoredForMessage('message-2')).toBe(true);

    markProviderAuthFailure('openai', 'message-1');
    expect(providerRequiresReconnection('openai')).toBe(false);
  });

  it('keeps an older failure resolved when its message mounts after reauthentication', () => {
    markProviderAuthFailure('openai', 'current-message', 150);
    resolveProviderAuthFailure('openai');

    markProviderAuthFailure('openai', 'older-message', 100);

    expect(providerRequiresReconnection('openai')).toBe(false);
    expect(providerAuthRestoredForMessage('older-message')).toBe(true);

    markProviderAuthFailure('openai', 'newer-message', 201);
    expect(providerRequiresReconnection('openai')).toBe(true);
  });
});
