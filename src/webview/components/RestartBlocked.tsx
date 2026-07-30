import { For, Show, createSignal, onCleanup } from 'solid-js';
import { postMessage } from '../lib/bridge';
import { defaultAppState } from '../lib/state';

const RECHECK_INTERVAL_MS = 3000;
const blockers = () => defaultAppState.state.restartBlocked;
let nextCheckId = 1;

export function RestartBlocked() {
  const [forcing, setForcing] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let forceResetTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleCheck = () => {
    timer = setTimeout(() => {
      if (document.visibilityState === 'visible') {
        postMessage({ type: 'server/restart/check', payload: { checkId: nextCheckId++ } });
      }
      scheduleCheck();
    }, RECHECK_INTERVAL_MS);
  };
  scheduleCheck();
  onCleanup(() => {
    clearTimeout(timer);
    clearTimeout(forceResetTimer);
  });

  const forceRestart = () => {
    setForcing(true);
    postMessage({ type: 'server/restart', payload: { force: true } });
    forceResetTimer = setTimeout(() => setForcing(false), 5000);
  };

  return (
    <div class="server-status-surface relative flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-8">
      <button
        type="button"
        class="chat-image-preview-close server-status-close"
        aria-label="Close restart status"
        title="Close"
        onClick={() => defaultAppState.setState('restartBlocked', null)}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          aria-hidden="true"
        >
          <path d="m4 4 8 8" stroke-linecap="round" />
          <path d="m12 4-8 8" stroke-linecap="round" />
        </svg>
      </button>

      <div class="mx-auto flex w-full max-w-90 flex-col items-center gap-4 text-center">
        <div class="flex h-10 w-10 items-center justify-center rounded-full bg-vscode-accent/10">
          <svg
            class="h-5 w-5 text-vscode-accent"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        </div>

        <div class="px-3">
          <p class="text-[13px] font-medium text-vscode-fg">Waiting to restart OpenCode</p>
          <p class="mt-1.5 text-[12px] leading-normal text-vscode-muted">
            {blockers()?.totalSessionCount ?? 0}{' '}
            {(blockers()?.totalSessionCount ?? 0) === 1 ? 'session is' : 'sessions are'} still
            running. Varro will restart automatically when they finish.
          </p>
        </div>

        <div
          class="flex w-full flex-col gap-2 text-left"
          aria-label="Running sessions by directory"
        >
          <For each={blockers()?.directories ?? []}>
            {(row) => (
              <div class="flex items-center gap-3 rounded-md border border-vscode-border-soft bg-vscode-card px-3 py-2.5">
                <code class="min-w-0 flex-1 break-all font-mono text-[11px] leading-relaxed text-vscode-fg">
                  {row.directory ?? 'Unknown directory'}
                </code>
                <span
                  class="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-vscode-badge-bg px-1.5 text-[11px] font-medium text-vscode-badge-fg"
                  aria-label={`${row.sessionCount} ${row.sessionCount === 1 ? 'session' : 'sessions'}`}
                >
                  {row.sessionCount}
                </span>
              </div>
            )}
          </For>
        </div>

        <p class="px-3 text-[11px] leading-normal text-vscode-muted">
          Force restart stops the server immediately and may interrupt active work.
        </p>
        <button
          type="button"
          class="server-status-secondary-button"
          disabled={forcing()}
          onClick={forceRestart}
        >
          <Show when={!forcing()} fallback="Restarting...">
            Force Restart
          </Show>
        </button>
      </div>
    </div>
  );
}
