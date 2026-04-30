import { createContext, useContext } from 'solid-js';
import type { ParentProps } from 'solid-js';
import { defaultAppState, resetDefaultAppState, type AppStateInstance } from './state';

const AppStateContext = createContext<AppStateInstance>();

export function AppStateProvider(props: ParentProps<{ value?: AppStateInstance }>) {
  if (!props.value) {
    resetDefaultAppState();
  }
  const appState = props.value ?? defaultAppState;

  return <AppStateContext.Provider value={appState}>{props.children}</AppStateContext.Provider>;
}

export function useAppState() {
  return useContext(AppStateContext) ?? defaultAppState;
}
