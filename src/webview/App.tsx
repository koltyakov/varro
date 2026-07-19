import { ErrorBoundary, Show, onCleanup, onMount } from 'solid-js';
import { useOpenCode } from './hooks/useOpenCode';
import { createOpenCodeRuntime, installOpenCodeRuntime } from './hooks/runtime/useOpenCode.runtime';
import { connectionInitialized, defaultAppState } from './lib/state';
import { Chat } from './components/Chat';
import { ServerStatus } from './components/ServerStatus';
import { RalphForm } from './components/ralph/RalphForm';
import { ralphRunner } from './components/ralph/ralph-runner';
import { cleanupBridge } from './lib/bridge';

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
  });

  return (
    <div class="relative flex h-full min-h-0 flex-col bg-vscode-sidebar text-vscode-fg">
      <Show when={!isRestoringWorkspace()} fallback={<WorkspaceLoading />}>
        <Show when={showChat()} fallback={<ServerStatus />}>
          <Chat />
        </Show>
      </Show>
      <RalphForm />
      <Show when={defaultAppState.error()}>
        <div class="flex items-start justify-between gap-2 border-t border-vscode-error/30 bg-vscode-error/6 px-4 py-2 text-[11px] text-vscode-error">
          <span class="break-words leading-relaxed">{defaultAppState.error()}</span>
          <button
            class="shrink-0 px-1 text-vscode-error/60 transition-colors hover:text-vscode-error"
            onClick={() => defaultAppState.setError(null)}
            title="Dismiss"
          >
            <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
            </svg>
          </button>
        </div>
      </Show>
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
