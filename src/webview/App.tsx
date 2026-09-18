import { ErrorBoundary, Show, onCleanup, onMount } from 'solid-js';
import { useOpenCode } from './hooks/useOpenCode';
import { createOpenCodeRuntime, installOpenCodeRuntime } from './hooks/runtime/useOpenCode.runtime';
import { connectionInitialized, defaultAppState } from './lib/state';
import { Chat } from './components/Chat';
import { ServerStatus } from './components/ServerStatus';
import { SessionActionFeedback } from './components/chat/SessionActionFeedback';
import { RestartBlocked } from './components/RestartBlocked';
import { ralphRunner } from './components/ralph/ralph-runner';
import { cleanupBridge, postMessage } from './lib/bridge';
import { logError } from './lib/log';
import { asRecord, getString, isString } from './lib/runtime-values';
import { ralphStore } from './lib/stores/ralph-store';
import { observeSurfaceContrast } from './lib/theme';
import { folderIcon, warningCircleSolidIcon, wifiIcon } from './lib/ui-icons';
import { UiIcon } from './components/UiIcon';
import { RalphForm } from './components/ralph/RalphForm';

export function AppRoot() {
  onCleanup(cleanupBridge);
  return (
    <ErrorBoundary fallback={renderErrorFallback}>
      <InitializedApp />
    </ErrorBoundary>
  );
}

function InitializedApp() {
  const restoreOpenCodeRuntime = installOpenCodeRuntime(createOpenCodeRuntime());
  onCleanup(restoreOpenCodeRuntime);

  return <App />;
}

const showChat = () =>
  (defaultAppState.state.serverStatus.state === 'running' ||
    defaultAppState.state.serverReconnecting) &&
  !(defaultAppState.state.providersLoaded && defaultAppState.state.providers.length === 0);

const isRestoringWorkspace = () =>
  defaultAppState.state.serverStatus.state === 'running' &&
  !defaultAppState.state.serverReconnecting &&
  !connectionInitialized();

const isReconnecting = () => defaultAppState.state.serverReconnecting && !connectionInitialized();

const hasNoOpenFolder = () => defaultAppState.state.editorContext.workspaceFolders?.length === 0;

function renderErrorFallback(err: Error) {
  logError('app:error-boundary', describeError(err));
  return <ErrorFallback err={err} />;
}

function describeError(err: Error): string {
  const detail = err.stack || err.message || err.name;
  return hasWrappedCause(err) && err.cause !== err
    ? `${detail}\nCause: ${describeThrownValue(err.cause)}`
    : detail;
}

function describeThrownValue<T>(err: T): string {
  if (err instanceof Error) return err.stack || err.message || err.name;
  if (isString(err)) return err;
  const record = asRecord(err);
  const name = getString(record?.name);
  const message = getString(record?.message);
  const stack = getString(record?.stack);
  if (stack) return stack;
  if (name || message) return name && message ? `${name}: ${message}` : name || message;
  try {
    const serialized = JSON.stringify(err) ?? String(err);
    return serialized === '{}' ? Object.prototype.toString.call(err) : serialized;
  } catch {
    return String(err);
  }
}

function getErrorMessage(err: Error): string {
  if (hasWrappedCause(err) && err.cause !== err) return describeThrownValue(err.cause);
  return err.message || err.name;
}

function hasWrappedCause(err: Error): err is Error & { cause: unknown } {
  return err.message === 'Unknown error' && 'cause' in err;
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
                <div class="contents" inert={isReconnecting()}>
                  <Chat />
                </div>
              </Show>
            }
          >
            <RestartBlocked />
          </Show>
        </Show>
      </Show>
      <Show when={ralphStore.showRalphForm()}>
        <RalphForm />
      </Show>
      <SessionActionFeedback
        error={defaultAppState.error}
        errorRetry={defaultAppState.errorRetry}
        onDismissError={() => defaultAppState.setError(null)}
        status={() =>
          isReconnecting()
            ? { message: 'Reconnecting to server', icon: wifiIcon, tone: 'warning' }
            : null
        }
      />
    </div>
  );
}

function NoFolderOpen() {
  return (
    <div class="server-status-surface">
      <div class="server-status-content">
        <UiIcon
          source={folderIcon}
          class="h-10 w-10 text-vscode-muted"
          width={40}
          height={40}
          aria-hidden="true"
        />
        <div class="w-full">
          <p class="text-[13px] font-medium text-vscode-fg">Open a folder to use Varro</p>
          <p class="mt-1.5 text-[12px] leading-relaxed text-vscode-muted">
            Varro needs a workspace folder to understand and work with your project.
          </p>
        </div>
        <button
          type="button"
          class="server-status-action-button"
          onClick={() => postMessage({ type: 'vscode/open-folder' })}
        >
          Open Folder
        </button>
      </div>
    </div>
  );
}

function WorkspaceLoading() {
  return (
    <div class="server-status-surface" role="status" aria-label="Loading workspace">
      <div class="flex items-center gap-[8px]" aria-hidden="true">
        <span class="h-[8px] w-[8px] rounded-full bg-vscode-accent animate-pulse-soft" />
        <span
          class="h-[8px] w-[8px] rounded-full bg-vscode-accent animate-pulse-soft"
          style={{ 'animation-delay': '0.3s' }}
        />
        <span
          class="h-[8px] w-[8px] rounded-full bg-vscode-accent animate-pulse-soft"
          style={{ 'animation-delay': '0.6s' }}
        />
      </div>
    </div>
  );
}

function ErrorFallback(props: { err: Error }) {
  return (
    <div class="server-status-surface h-full">
      <div class="server-status-content">
        <UiIcon
          source={warningCircleSolidIcon}
          class="h-8 w-8 text-vscode-error"
          width={32}
          height={32}
        />
        <p class="text-sm text-vscode-error">Something went wrong</p>
        <p class="text-xs text-vscode-muted">{getErrorMessage(props.err)}</p>
        <button
          class="server-status-action-button"
          onClick={() => postMessage({ type: 'webview/reload' })}
        >
          Reload sidebar
        </button>
      </div>
    </div>
  );
}
