import { Show } from 'solid-js';
import { OPENCODE_UPDATE_REQUIRED_PREFIX } from '../../shared/opencode-compatibility';
import { postMessage } from '../lib/bridge';
import { openProviderSetup } from '../lib/provider-setup';
import { defaultAppState } from '../lib/state';

function openExternal(url: string) {
  postMessage({ type: 'vscode/open-external', payload: { url } });
}

const serverStatus = () => defaultAppState.state.serverStatus;

export function ServerStatus() {
  const noProvidersConfigured = () =>
    serverStatus().state === 'running' &&
    defaultAppState.state.providersLoaded &&
    defaultAppState.state.providers.length === 0;
  const serverErrorMessage = () => {
    const currentStatus = serverStatus();
    return currentStatus.state === 'error' ? currentStatus.message.trim() : '';
  };
  const isMissingCliError = () => serverErrorMessage().includes('OpenCode CLI not found');
  const isUpdateRequiredError = () =>
    serverErrorMessage().startsWith(OPENCODE_UPDATE_REQUIRED_PREFIX);

  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-4 px-8 py-10 text-center">
      <Show when={serverStatus().state === 'starting'}>
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

      <Show when={serverStatus().state === 'stopped'}>
        <div class="h-1.5 w-1.5 rounded-full bg-vscode-muted/30" />
        <div>
          <p class="text-[13px] font-medium text-vscode-fg">Server not running</p>
          <p class="mt-1 text-[12px] text-vscode-muted">Waiting to connect...</p>
        </div>
      </Show>

      <Show when={serverStatus().state === 'error'}>
        <Show
          when={isMissingCliError()}
          fallback={
            <Show
              when={isUpdateRequiredError()}
              fallback={<GenericErrorState message={serverErrorMessage()} />}
            >
              <UpdateRequiredState message={serverErrorMessage()} />
            </Show>
          }
        >
          <div class="flex w-full max-w-62.5 flex-col items-center gap-4 text-center">
            <div class="flex h-10 w-10 items-center justify-center rounded-full bg-vscode-warning/10">
              <svg
                class="h-5 w-5 text-vscode-warning"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>
            <div class="flex flex-col gap-1.5 px-4">
              <p class="text-[13px] font-medium text-vscode-fg">OpenCode is not installed</p>
              <p class="text-[12px] leading-normal text-vscode-muted">
                Varro gives{' '}
                <button
                  type="button"
                  class="text-vscode-link hover:text-vscode-link-active hover:underline"
                  onClick={() => openExternal('https://opencode.ai')}
                >
                  OpenCode
                </button>{' '}
                a native UI.
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
            <button
              type="button"
              class="text-[11px] text-vscode-link hover:text-vscode-link-active hover:underline"
              onClick={() => openExternal('https://opencode.ai')}
            >
              Learn more at opencode.ai
            </button>
          </div>
        </Show>
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
              Add one with the provider login command. Varro will refresh the provider list
              automatically when setup completes.
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
          <button type="button" class="server-status-action-button" onClick={openProviderSetup}>
            Open terminal and add a provider
          </button>
          <button
            type="button"
            class="text-[11px] text-vscode-link hover:text-vscode-link-active hover:underline"
            onClick={() => openExternal('https://opencode.ai/docs/providers')}
          >
            Provider setup docs
          </button>
        </div>
      </Show>
    </div>
  );
}

function UpdateRequiredState(props: { message: string }) {
  return (
    <div class="flex w-full max-w-75 flex-col items-center gap-4 text-center">
      <div class="flex h-10 w-10 items-center justify-center rounded-full bg-vscode-warning/10">
        <svg
          class="h-5 w-5 text-vscode-warning"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
      </div>
      <div class="flex flex-col gap-1.5 px-4">
        <p class="text-[13px] font-medium text-vscode-fg">OpenCode update required</p>
        <p class="text-[12px] leading-normal text-vscode-muted">{props.message}</p>
      </div>
      <div class="w-full px-4">
        <div class="w-full rounded-md border border-vscode-border-soft bg-vscode-card px-3 py-2 text-left">
          <p class="text-[10px] font-medium uppercase tracking-wide text-vscode-muted/70">Update</p>
          <code class="mt-1 block font-mono text-[12px] text-vscode-fg">opencode upgrade</code>
        </div>
      </div>
      <p class="px-4 text-[11px] leading-normal text-vscode-muted/80">
        Then run <span class="font-medium text-vscode-fg">Varro: Restart Server</span> from the
        Command Palette.
      </p>
    </div>
  );
}

function GenericErrorState(props: { message: string }) {
  return (
    <div class="flex w-full max-w-75 flex-col items-center gap-4 text-center">
      <div class="flex h-10 w-10 items-center justify-center rounded-full bg-vscode-error/10">
        <svg
          class="h-5 w-5 text-vscode-error"
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.5 3h1v5h-1V4zm.5 8a.75.75 0 110-1.5.75.75 0 010 1.5z" />
        </svg>
      </div>
      <div class="flex flex-col gap-1.5 px-4">
        <p class="text-[13px] font-medium text-vscode-fg">OpenCode could not start</p>
        <p class="text-[12px] leading-normal text-vscode-muted">{props.message}</p>
      </div>
      <button
        type="button"
        class="rounded-md border border-vscode-border px-3 py-1.5 text-[12px] text-vscode-fg hover:bg-vscode-hover"
        onClick={() => postMessage({ type: 'vscode/show-output' })}
      >
        Show Output
      </button>
    </div>
  );
}
