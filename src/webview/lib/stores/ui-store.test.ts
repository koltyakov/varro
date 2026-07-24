import { beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from '../state-storage';
import { resetDefaultAppState } from '../state';
import { uiStore } from './ui-store';

describe('uiStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetDefaultAppState();
  });

  it('persists UI preferences and request counters', () => {
    const composerFocusKey = uiStore.composerFocusKey();
    const openAttentionSessionsKey = uiStore.openAttentionSessionsKey();
    const messageListScrollRequestKey = uiStore.messageListScrollRequestKey();

    uiStore.toggleThinking();
    uiStore.setExpandThinkingByDefaultPreference(true);
    uiStore.requestComposerFocus();
    uiStore.requestOpenAttentionSessions();
    uiStore.requestMessageListScrollToBottom();

    expect(uiStore.showThinking()).toBe(false);
    expect(uiStore.expandThinkingByDefault()).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEYS.showThinking)).toBe('false');
    expect(window.localStorage.getItem(STORAGE_KEYS.expandThinkingByDefault)).toBe('true');
    expect(uiStore.composerFocusKey()).toBe(composerFocusKey + 1);
    expect(uiStore.openAttentionSessionsKey()).toBe(openAttentionSessionsKey + 1);
    expect(uiStore.messageListScrollRequestKey()).toBe(messageListScrollRequestKey + 1);
  });

  it('tracks loading lifecycle timestamps', () => {
    uiStore.markLoadingActivity(50);
    expect(uiStore.isLoading()).toBe(false);
    expect(uiStore.loadingStartedAt()).toBeNull();

    uiStore.startLoading(100);
    uiStore.markLoadingActivity(150);
    uiStore.startLoading(200);

    expect(uiStore.isLoading()).toBe(true);
    expect(uiStore.loadingStartedAt()).toBe(100);
    expect(uiStore.loadingLastActivityAt()).toBe(200);

    uiStore.stopLoading();

    expect(uiStore.isLoading()).toBe(false);
    expect(uiStore.loadingStartedAt()).toBeNull();
    expect(uiStore.loadingLastActivityAt()).toBeNull();
  });
});
