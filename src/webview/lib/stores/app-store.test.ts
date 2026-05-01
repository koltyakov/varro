import { beforeEach, describe, expect, it } from 'vitest';
import { appStore } from './app-store';
import { state } from '../state';

describe('appStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    appStore.resetDefaultAppState();
  });

  it('resets state and consumes interrupted sessions', () => {
    appStore.setState('activeSessionId', 'session-1');
    appStore.setState('interruptedSessionIds', ['session-1', 'session-2']);

    expect(appStore.consumeInterruptedSessionIds()).toEqual(['session-1', 'session-2']);
    expect(state.interruptedSessionIds).toEqual([]);

    appStore.resetDefaultAppState();

    expect(state.activeSessionId).toBeNull();
    expect(state.interruptedSessionIds).toEqual([]);
  });
});
