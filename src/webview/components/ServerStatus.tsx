import { Show } from 'solid-js';
import { postMessage } from '../lib/bridge';
import { state } from '../lib/state';

export function ServerStatus() {
  const status = () => state.serverStatus;
  const noProvidersConfigured = () => status().state === 'running' && state.providersLoaded && state.providers.length === 0;

  const openProviderSetup = () => {
    postMessage({
      type: 'terminal/run',
      payload: { command: 'opencode auth login', title: 'OpenCode Provider Setup' },
    });
  };

  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-4 px-8 py-10 text-center">
      <Show when={status().state === 'starting'}>
        <div class="flex items-center gap-2">
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
          <p class="text-[13px] font-medium text-vscode-fg">Starting OpenCode...</p>
          <p class="mt-1.5 text-[12px] text-vscode-muted/70">Spawning the local server</p>
        </div>
      </Show>

      <Show when={status().state === 'stopped'}>
        <div class="h-1.5 w-1.5 rounded-full bg-vscode-muted/30" />
        <div>
          <p class="text-[13px] font-medium text-vscode-fg">Server not running</p>
          <p class="mt-1 text-[12px] text-vscode-muted">Waiting to connect...</p>
        </div>
      </Show>

      <Show when={status().state === 'error'}>
        <div class="flex w-full max-w-62.5 flex-col items-center gap-4 text-center">
          <div class="flex h-10 w-10 items-center justify-center rounded-full bg-vscode-accent/10">
            <svg
              class="h-5 w-5 text-vscode-accent"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <polyline points="7.5 4.21 12 6.81 16.5 4.21" />
              <polyline points="7.5 19.79 7.5 14.6 3 12" />
              <polyline points="21 12 16.5 14.6 16.5 19.79" />
              <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
              <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
          </div>
          <div class="flex flex-col gap-1.5 px-4">
            <p class="text-[13px] font-medium text-vscode-fg">OpenCode is not installed</p>
            <p class="text-[12px] leading-normal text-vscode-muted">
              Varro gives{' '}
              <a
                href="https://opencode.ai"
                class="text-vscode-link hover:text-vscode-link-active hover:underline"
              >
               OpenCode
              </a>
              {' '}a native UI.
              <br />
              Install the CLI to get started.
            </p>
          </div>
          <div class="w-full px-4">
            <div class="w-full rounded-md border border-vscode-border-soft bg-vscode-card px-3 py-2 text-left">
            <p class="text-[10px] font-medium uppercase tracking-wide text-vscode-muted/70">
              Install
            </p>
            <code class="mt-1 block font-mono text-[12px] text-vscode-fg">
              npm i -g opencode-ai
            </code>
            </div>
          </div>
          <a
            href="https://opencode.ai"
            class="text-[11px] text-vscode-link hover:text-vscode-link-active hover:underline"
          >
            Learn more at opencode.ai
          </a>
        </div>
      </Show>

      <Show when={noProvidersConfigured()}>
        <div class="flex w-full max-w-75 flex-col items-center gap-4 text-center">
          <div
            class="flex shrink-0 items-center justify-center rounded-full bg-vscode-accent/10"
            style={{ width: '40px', height: '40px', 'aspect-ratio': '1 / 1' }}
          >
            <svg
              width="20"
              height="20"
              class="text-vscode-accent"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 8V4H8" />
              <rect width="16" height="12" x="4" y="8" rx="2" />
              <path d="M2 14h2" />
              <path d="M20 14h2" />
              <path d="M15 13v2" />
              <path d="M9 13v2" />
            </svg>
          </div>
          <div class="flex flex-col gap-1.5 px-4">
            <p class="text-[13px] font-medium text-vscode-fg">No providers configured</p>
            <p class="text-[12px] leading-normal text-vscode-muted">
              OpenCode is running, but it does not have any providers configured yet.
              <br />
              Add one with the provider login command, then restart Varro if models still do not appear.
            </p>
          </div>
          <div class="w-full px-4">
            <div class="w-full rounded-md border border-vscode-border-soft bg-vscode-card px-3 py-2 text-left">
              <p class="text-[10px] font-medium uppercase tracking-wide text-vscode-muted/70">
                Setup
              </p>
              <code class="mt-1 block font-mono text-[12px] text-vscode-fg">
                opencode auth login
              </code>
            </div>
          </div>
          <button
            type="button"
            class="server-status-action-button"
            onClick={openProviderSetup}
          >
            Open terminal and add a provider
          </button>
          <a
            href="https://opencode.ai/docs/providers"
            class="text-[11px] text-vscode-link hover:text-vscode-link-active hover:underline"
          >
            Provider setup docs
          </a>
        </div>
      </Show>
    </div>
  );
}
