import {
  isLoading,
  loadingStartedAt,
  setComposerFocusKey,
  setExpandThinkingByDefault,
  setIsLoading,
  setLoadingLastActivityAt,
  setLoadingStartedAt,
  setMessageListScrollRequestKey,
  setOpenAttentionSessionsKey,
  setSessionSearchFocusKey,
  setShowThinking,
  showThinking,
} from './app-state';
import { STORAGE_KEYS, writeStored } from './state-storage';

export function toggleThinking() {
  const next = !showThinking();
  setShowThinkingPreference(next);
}

export function setShowThinkingPreference(next: boolean) {
  setShowThinking(next);
  writeStored(STORAGE_KEYS.showThinking, next);
}

export function setExpandThinkingByDefaultPreference(next: boolean) {
  setExpandThinkingByDefault(next);
  writeStored(STORAGE_KEYS.expandThinkingByDefault, next);
}

export function startLoading(now = Date.now()) {
  if (!isLoading()) {
    setLoadingStartedAt(now);
  } else if (loadingStartedAt() === null) {
    setLoadingStartedAt(now);
  }
  setLoadingLastActivityAt(now);
  setIsLoading(true);
}

export function stopLoading() {
  setIsLoading(false);
  setLoadingStartedAt(null);
  setLoadingLastActivityAt(null);
}

export function markLoadingActivity(now = Date.now()) {
  if (!isLoading()) return;
  if (loadingStartedAt() === null) {
    setLoadingStartedAt(now);
  }
  setLoadingLastActivityAt(now);
}

export function requestComposerFocus() {
  setComposerFocusKey((value) => value + 1);
}

export function requestOpenAttentionSessions() {
  setOpenAttentionSessionsKey((value) => value + 1);
}

export function requestSessionSearchFocus() {
  setSessionSearchFocusKey((value) => value + 1);
}

export function requestMessageListScrollToBottom() {
  setMessageListScrollRequestKey((value) => value + 1);
}
