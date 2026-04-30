import {
  consumeInterruptedSessionIds,
  defaultAppState,
  resetDefaultAppState,
  setState,
  state,
} from '../state';

export const appStore = {
  defaultAppState,
  state,
  setState,
  resetDefaultAppState,
  consumeInterruptedSessionIds,
};

export type AppStore = typeof appStore;
