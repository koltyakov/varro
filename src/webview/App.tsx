import {
  Errored,
  Show,
  createEffect,
  createMemo,
  onCleanup,
  onSettled,
  type Accessor,
} from 'solid-js';
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
import { statusIcons } from './lib/status-icons';
import { wifiIcon } from './lib/ui-icons';
import { UiIcon } from './components/UiIcon';
import { RalphForm } from './components/ralph/RalphForm';

function renderAppError(error: Accessor<unknown>) {
  return <AppErrorFallback error={error} />;
}

export function AppRoot() {
  onCleanup(cleanupBridge);
  return (
    <Errored fallback={renderAppError}>
      <InitializedApp />
    </Errored>
  );
}

function InitializedApp() {
  const restoreOpenCodeRuntime = installOpenCodeRuntime(createOpenCodeRuntime());
  onCleanup(restoreOpenCodeRuntime);

  return <App />;
}

const showChat = () =>
  defaultAppState.state.serverStatus.state === 'running' ||
  defaultAppState.state.serverReconnecting;

const isRestoringWorkspace = () =>
  defaultAppState.state.serverStatus.state === 'running' &&
  !defaultAppState.state.serverReconnecting &&
  !connectionInitialized();

const isReconnecting = () => defaultAppState.state.serverReconnecting && !connectionInitialized();

function AppErrorFallback(props: { error: Accessor<unknown> }) {
  const error = createMemo(() => {
    const value = props.error();
    return value instanceof Error ? value : new Error('Unknown error', { cause: value });
  });
  createEffect(error, (err) => {
    logError('app:error-boundary', describeError(err));
  });
  return <ErrorFallback err={error()} />;
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

  onSettled(() => {
    const cleanups: Array<() => void> = [];

    ralphRunner.reattachAll();
    postMessage({ type: 'warming/sync' });
    const stopObservingSurfaceContrast = observeSurfaceContrast();
    cleanups.push(stopObservingSurfaceContrast);

    return () => {
      for (const cleanup of cleanups.toReversed()) cleanup();
    };
  });

  return (
    <div class="relative flex h-full min-h-0 flex-col bg-vscode-sidebar text-vscode-fg">
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
      <Show when={ralphStore.showRalphForm()}>
        <RalphForm />
      </Show>
      <SessionActionFeedback
        error={defaultAppState.error}
        errorRetry={defaultAppState.errorRetry}
        onDismissError={() => defaultAppState.setError(null)}
        status={() =>
          isReconnecting() && defaultAppState.startupWaitingForPlugins()
            ? { message: 'Waiting for OpenCode plugins to activate', icon: statusIcons.clock }
            : isReconnecting()
              ? { message: 'Reconnecting to server', icon: wifiIcon, tone: 'warning' }
              : null
        }
      />
    </div>
  );
}

function WorkspaceLoading() {
  return (
    <div class="server-status-surface" role="status" aria-label="Loading workspace">
      <div class="flex items-center gap-[8px]" aria-hidden="true">
        <span class="loading-dot" />
        <span class="loading-dot" style={{ 'animation-delay': '0.3s' }} />
        <span class="loading-dot" style={{ 'animation-delay': '0.6s' }} />
      </div>
      <Show when={defaultAppState.startupWaitingForPlugins()}>
        <p class="text-[12px] text-vscode-muted">Waiting for OpenCode plugins to activate</p>
        <p class="max-w-[420px] px-4 text-center text-[12px] text-vscode-muted">
          {defaultAppState.startupAddonWarning() ??
            'OpenCode has not identified which addon is delaying activation. Check its server log for details.'}
        </p>
      </Show>
    </div>
  );
}

function ErrorFallback(props: { err: Error }) {
  return (
    <div class="server-status-surface h-full">
      <div class="server-status-content">
        <UiIcon
          source={statusIcons.warningCircle}
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
