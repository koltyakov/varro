import { flush as flushSolid } from 'solid-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from '../state-storage';
import { resetDefaultAppState } from '../state';
import { uiStore } from './ui-store';

describe('uiStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    flushSolid();
    resetDefaultAppState();
    flushSolid();
  });

  it('persists UI preferences and request counters', () => {
    const composerFocusKey = uiStore.composerFocusKey();
    const openAttentionSessionsKey = uiStore.openAttentionSessionsKey();
    const openCompletedSessionsKey = uiStore.openCompletedSessionsKey();
    const messageListScrollRequestKey = uiStore.messageListScrollRequestKey();

    uiStore.toggleThinking();
    flushSolid();
    uiStore.requestComposerFocus();
    uiStore.requestOpenAttentionSessions();
    uiStore.requestOpenCompletedSessions();
    uiStore.requestMessageListScrollToBottom();
    flushSolid();

    expect(uiStore.showThinking()).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEYS.showThinking)).toBe('false');
    expect(uiStore.composerFocusKey()).toBe(composerFocusKey + 1);
    expect(uiStore.openAttentionSessionsKey()).toBe(openAttentionSessionsKey + 1);
    expect(uiStore.openCompletedSessionsKey()).toBe(openCompletedSessionsKey + 1);
    expect(uiStore.messageListScrollRequestKey()).toBe(messageListScrollRequestKey + 1);
  });

  it('tracks loading lifecycle timestamps', () => {
    uiStore.markLoadingActivity(50);
    flushSolid();
    expect(uiStore.isLoading()).toBe(false);
    expect(uiStore.loadingStartedAt()).toBeNull();

    uiStore.startLoading(100);
    flushSolid();
    uiStore.markLoadingActivity(150);
    flushSolid();
    uiStore.startLoading(200);
    flushSolid();

    expect(uiStore.isLoading()).toBe(true);
    expect(uiStore.loadingStartedAt()).toBe(100);
    expect(uiStore.loadingLastActivityAt()).toBe(200);

    uiStore.stopLoading();
    flushSolid();

    expect(uiStore.isLoading()).toBe(false);
    expect(uiStore.loadingStartedAt()).toBeNull();
    expect(uiStore.loadingLastActivityAt()).toBeNull();
  });
});
