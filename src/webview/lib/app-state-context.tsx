import { createContext, onCleanup, useContext } from 'solid-js';
import type { ParentProps } from 'solid-js';
import { createAppState, installAppState, type AppStateInstance } from './state';

const AppStateContext = createContext<AppStateInstance>();

export function AppStateProvider(props: ParentProps<{ value?: AppStateInstance }>) {
  const appState = props.value ?? createAppState();
  const restoreAppState = installAppState(appState);

  onCleanup(() => {
    restoreAppState();
  });

  return <AppStateContext.Provider value={appState}>{props.children}</AppStateContext.Provider>;
}

export function useAppState() {
  const appState = useContext(AppStateContext);
  if (!appState) {
    throw new Error('AppStateProvider is required');
  }
  return appState;
}
