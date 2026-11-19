import { flush as flushSolid } from 'solid-js';
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
    flushSolid();
    markProviderAuthFailure('openai', 'message-2');
    flushSolid();

    resolveProviderAuthFailure('openai');
    flushSolid();

    expect(providerRequiresReconnection('openai')).toBe(false);
    expect(providerAuthRestoredForMessage('message-1')).toBe(true);
    expect(providerAuthRestoredForMessage('message-2')).toBe(true);

    markProviderAuthFailure('openai', 'message-1');
    flushSolid();
    expect(providerRequiresReconnection('openai')).toBe(false);
  });

  it('keeps an older failure resolved when its message mounts after reauthentication', () => {
    markProviderAuthFailure('openai', 'current-message', 150);
    flushSolid();
    resolveProviderAuthFailure('openai');
    flushSolid();

    markProviderAuthFailure('openai', 'older-message', 100);
    flushSolid();

    expect(providerRequiresReconnection('openai')).toBe(false);
    expect(providerAuthRestoredForMessage('older-message')).toBe(true);

    markProviderAuthFailure('openai', 'newer-message', 201);
    flushSolid();
    expect(providerRequiresReconnection('openai')).toBe(true);
  });
});
