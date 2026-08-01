import { ErrorBoundary, Show, onCleanup, onMount } from 'solid-js';
import { useOpenCode } from './hooks/useOpenCode';
import { createOpenCodeRuntime, installOpenCodeRuntime } from './hooks/runtime/useOpenCode.runtime';
import { connectionInitialized, defaultAppState } from './lib/state';
import { Chat } from './components/Chat';
import { ServerStatus } from './components/ServerStatus';
import { RalphForm } from './components/ralph/RalphForm';
import { SessionActionFeedback } from './components/chat/SessionActionFeedback';
import { RestartBlocked } from './components/RestartBlocked';
import { ralphRunner } from './components/ralph/ralph-runner';
import { cleanupBridge } from './lib/bridge';
import { observeSurfaceContrast } from './lib/theme';

export function AppRoot() {
  return (
    <ErrorBoundary fallback={renderErrorFallback}>
      <InitializedApp />
    </ErrorBoundary>
  );
}

function InitializedApp() {
  const restoreOpenCodeRuntime = installOpenCodeRuntime(createOpenCodeRuntime());

  onCleanup(() => {
    try {
      restoreOpenCodeRuntime();
    } finally {
      cleanupBridge();
    }
  });

  return <App />;
}

const showChat = () =>
  defaultAppState.state.serverStatus.state === 'running' &&
  !(defaultAppState.state.providersLoaded && defaultAppState.state.providers.length === 0);

const isRestoringWorkspace = () =>
  defaultAppState.state.serverStatus.state === 'running' && !connectionInitialized();

function renderErrorFallback(err: Error) {
  return <ErrorFallback err={err} />;
}

export function App() {
  useOpenCode();

  onMount(() => {
    ralphRunner.reattachAll();
    const stopObservingSurfaceContrast = observeSurfaceContrast();
    onCleanup(stopObservingSurfaceContrast);
  });

  return (
    <div class="relative flex h-full min-h-0 flex-col bg-vscode-sidebar text-vscode-fg">
      <Show when={!isRestoringWorkspace()} fallback={<WorkspaceLoading />}>
        <Show
          when={defaultAppState.state.restartBlocked}
          fallback={
            <Show when={showChat()} fallback={<ServerStatus />}>
              <Chat />
            </Show>
          }
        >
          <RestartBlocked />
        </Show>
      </Show>
      <RalphForm />
      <SessionActionFeedback
        error={defaultAppState.error}
        errorRetry={defaultAppState.errorRetry}
        onDismissError={() => defaultAppState.setError(null)}
      />
    </div>
  );
}

function WorkspaceLoading() {
  return (
    <div
      class="flex flex-1 flex-col items-center justify-center gap-4 px-8 py-10 text-center"
      role="status"
      aria-label="Loading workspace"
    >
      <div class="flex items-center gap-2" aria-hidden="true">
        <span class="h-2 w-2 rounded-full bg-vscode-accent animate-pulse-soft" />
        <span
          class="h-2 w-2 rounded-full bg-vscode-accent animate-pulse-soft"
          style={{ 'animation-delay': '0.3s' }}
        />
        <span
          class="h-2 w-2 rounded-full bg-vscode-accent animate-pulse-soft"
          style={{ 'animation-delay': '0.6s' }}
        />
      </div>
      <div>
        <p class="text-[13px] font-medium text-vscode-fg">Loading workspace...</p>
        <p class="mt-1.5 text-[12px] text-vscode-muted">Restoring your recent view</p>
      </div>
    </div>
  );
}

function ErrorFallback(props: { err: Error }) {
  return (
    <div class="flex flex-col items-center justify-center gap-3 p-6 text-center">
      <svg class="h-8 w-8 text-vscode-error" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.5 3h1v5h-1V4zm.5 8a.75.75 0 110-1.5.75.75 0 010 1.5z" />
      </svg>
      <p class="text-sm text-vscode-error">Something went wrong</p>
      <p class="max-w-full break-words text-xs text-vscode-muted">
        {props.err?.message || 'Unknown error'}
      </p>
      <button
        class="rounded bg-vscode-button-bg px-3 py-1 text-xs text-vscode-button-fg hover:bg-vscode-button-hover"
        onClick={() => window.location.reload()}
      >
        Reload sidebar
      </button>
    </div>
  );
}
