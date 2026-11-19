import {
  applyPinnedSessionsSync,
  consumeInterruptedSessionIds,
  defaultAppState,
  resetDefaultAppState,
  setState,
  state,
} from '../state';

export const appStore = {
  applyPinnedSessionsSync,
  defaultAppState,
  state,
  setState,
  resetDefaultAppState,
  consumeInterruptedSessionIds,
};

export type AppStore = typeof appStore;
