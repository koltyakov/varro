import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { beforeEach, describe, expect, it } from 'vitest';
import { appStore } from './app-store';
import { state } from '../state';

describe('appStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    flushSolid();
    appStore.resetDefaultAppState();
    flushSolid();
  });

  it('resets state and consumes interrupted sessions', () => {
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    appStore.setState(storePath('interruptedSessionIds', ['session-1', 'session-2']));
    flushSolid();

    expect(appStore.consumeInterruptedSessionIds()).toEqual(['session-1', 'session-2']);
    flushSolid();
    expect(state.interruptedSessionIds).toEqual([]);

    appStore.resetDefaultAppState();
    flushSolid();

    expect(state.activeSessionId).toBeNull();
    expect(state.interruptedSessionIds).toEqual([]);
  });
});
