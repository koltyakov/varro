import { ErrorBoundary, Show, Suspense, lazy, onCleanup, onMount } from 'solid-js';
import { useOpenCode } from './hooks/useOpenCode';
import { createOpenCodeRuntime, installOpenCodeRuntime } from './hooks/runtime/useOpenCode.runtime';
import { connectionInitialized, defaultAppState } from './lib/state';
import { Chat } from './components/Chat';
import { ServerStatus } from './components/ServerStatus';
import { SessionActionFeedback } from './components/chat/SessionActionFeedback';
import { RestartBlocked } from './components/RestartBlocked';
import { ralphRunner } from './components/ralph/ralph-runner';
import { cleanupBridge, postMessage } from './lib/bridge';
import { ralphStore } from './lib/stores/ralph-store';
import { observeSurfaceContrast } from './lib/theme';

const LazyRalphForm = lazy(() =>
  import('./components/ralph/RalphForm').then((module) => ({ default: module.RalphForm }))
);

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

const hasNoOpenFolder = () => defaultAppState.state.editorContext.workspaceFolders?.length === 0;

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
      <Show when={!hasNoOpenFolder()} fallback={<NoFolderOpen />}>
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
      </Show>
      <Show when={ralphStore.showRalphForm()}>
        <Suspense>
          <LazyRalphForm />
        </Suspense>
      </Show>
      <SessionActionFeedback
        error={defaultAppState.error}
        errorRetry={defaultAppState.errorRetry}
        onDismissError={() => defaultAppState.setError(null)}
      />
    </div>
  );
}

function NoFolderOpen() {
  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-4 px-8 py-10 text-center">
      <svg
        class="h-10 w-10 text-vscode-muted"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M3.75 6.75A2.25 2.25 0 0 1 6 4.5h3.19c.6 0 1.17.24 1.59.66l1.06 1.06c.42.42.99.66 1.59.66H18A2.25 2.25 0 0 1 20.25 9v8.25A2.25 2.25 0 0 1 18 19.5H6a2.25 2.25 0 0 1-2.25-2.25V6.75Z"
        />
      </svg>
      <div>
        <p class="text-[13px] font-medium text-vscode-fg">Open a folder to use Varro</p>
        <p class="mt-1.5 max-w-64 text-[12px] leading-relaxed text-vscode-muted">
          Varro needs a workspace folder to understand and work with your project.
        </p>
      </div>
      <button
        type="button"
        class="rounded bg-vscode-button-bg px-3 py-1.5 text-[12px] font-medium text-vscode-button-fg hover:bg-vscode-button-hover"
        onClick={() => postMessage({ type: 'vscode/open-folder' })}
      >
        Open Folder
      </button>
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
