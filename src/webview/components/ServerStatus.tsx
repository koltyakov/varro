import { Match, Show, Switch, createMemo, createSignal, onCleanup } from 'solid-js';
import { OPENCODE_UPDATE_REQUIRED_PREFIX } from '../../shared/opencode-compatibility';
import {
  OPENCODE_INSTALL_COMMAND,
  OPENCODE_INSTALL_DOCS_URL,
  OPENCODE_UPGRADE_COMMAND,
} from '../../shared/opencode-install';
import type { ServerErrorDetail } from '../../shared/protocol';
import { postMessage } from '../lib/bridge';
import { openProviderSetup } from '../lib/provider-setup';
import { defaultAppState } from '../lib/state';
import { writeClipboard } from '../lib/write-clipboard';

function openExternal(url: string) {
  postMessage({ type: 'vscode/open-external', payload: { url } });
}

function restartServer() {
  postMessage({ type: 'server/restart' });
}

function showOutput() {
  postMessage({ type: 'vscode/show-output' });
}

function openSettings(query: string) {
  postMessage({ type: 'vscode/open-settings', payload: { query } });
}

function runInTerminal(command: string, title: string) {
  postMessage({ type: 'terminal/run', payload: { command, title } });
}

function SetupCommandCard(props: { label: string; command: string }) {
  const [copied, setCopied] = createSignal(false);
  let copyTimeout: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => clearTimeout(copyTimeout));

  const handleCopy = async () => {
    if (!(await writeClipboard(props.command))) return;
    setCopied(true);
    clearTimeout(copyTimeout);
    copyTimeout = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div class="w-full px-4">
      <div class="w-full rounded-md border border-vscode-border-soft bg-vscode-card px-3 py-2 text-left">
        <div class="flex items-center justify-between gap-2">
          <p class="text-[10px] font-medium uppercase tracking-wide text-vscode-muted">
            {props.label}
          </p>
          <button
            type="button"
            class="shrink-0 text-vscode-muted transition-colors hover:text-vscode-fg"
            title={copied() ? 'Copied' : `Copy: ${props.command}`}
            aria-label={copied() ? 'Copied' : `Copy command: ${props.command}`}
            onClick={() => void handleCopy()}
          >
            <Show
              when={copied()}
              fallback={
                <svg
                  class="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect width="14" height="14" x="8" y="8" rx="2" />
                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                </svg>
              }
            >
              <svg
                class="h-3.5 w-3.5 text-vscode-success"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </Show>
          </button>
        </div>
        <code class="mt-1 block break-all font-mono text-[12px] text-vscode-fg">
          {props.command}
        </code>
      </div>
    </div>
  );
}

function SecondaryButton(props: { label: string; onClick: () => void }) {
  return (
    <button type="button" class="server-status-secondary-button" onClick={props.onClick}>
      {props.label}
    </button>
  );
}

/**
 * Every error state offers a way out without leaving the panel — except where
 * restarting is the destructive act the state exists to prevent: a restart
 * stops the running server unconditionally, which is exactly what the
 * active-sessions gate refused to do.
 */
function RecoveryActions(props: {
  settingId?: string;
  showOutput?: boolean;
  allowRestart?: boolean;
}) {
  return (
    <div class="flex flex-wrap items-center justify-center gap-2 px-4">
      <Show when={props.allowRestart !== false}>
        <SecondaryButton label="Restart Server" onClick={restartServer} />
      </Show>
      <Show when={props.settingId}>
        <SecondaryButton
          label="Open Settings"
          onClick={() => openSettings(props.settingId || '')}
        />
      </Show>
      <Show when={props.showOutput}>
        <SecondaryButton label="Show Output" onClick={showOutput} />
      </Show>
    </div>
  );
}

function WarningIcon() {
  return (
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
  );
}

function UpdateIcon() {
  return (
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
  );
}

function WaitingIcon() {
  return (
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
  );
}

const serverStatus = () => defaultAppState.state.serverStatus;

/**
 * Older hosts (and the e2e harness scenarios that predate structured detail)
 * only send a message string, so keep classifying those the way they always
 * were rather than dropping them into the generic state.
 */
function inferDetail(message: string): ServerErrorDetail {
  if (message.includes('not found at the configured path')) {
    return { kind: 'cli-path-invalid', settingId: 'varro.server.command' };
  }
  if (message.includes('OpenCode CLI not found')) {
    return { kind: 'cli-missing', suggestedCommand: OPENCODE_INSTALL_COMMAND };
  }
  if (message.startsWith(OPENCODE_UPDATE_REQUIRED_PREFIX)) {
    return { kind: 'update-required', suggestedCommand: OPENCODE_UPGRADE_COMMAND };
  }
  return { kind: 'generic' };
}

export function ServerStatus() {
  const noProvidersConfigured = () =>
    serverStatus().state === 'running' &&
    defaultAppState.state.providersLoaded &&
    defaultAppState.state.providers.length === 0;

  const errorMessage = () => {
    const currentStatus = serverStatus();
    return currentStatus.state === 'error' ? currentStatus.message.trim() : '';
  };
  // Always resolves to a detail so the branches below never need a keyed
  // <Show> accessor, which would be read during unmount as the state changes.
  const errorDetail = createMemo<ServerErrorDetail>(() => {
    const currentStatus = serverStatus();
    if (currentStatus.state !== 'error') return { kind: 'generic' };
    return currentStatus.detail ?? inferDetail(currentStatus.message.trim());
  });
  const errorKind = () => errorDetail().kind;

  return (
    <div class="server-status-surface flex min-h-0 flex-1 flex-col items-center gap-4 overflow-y-auto px-8 py-10 text-center">
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
          <p class="mt-1.5 text-[12px] text-vscode-muted">Spawning the local server</p>
        </div>
      </Show>

      <Show when={serverStatus().state === 'stopped'}>
        <div class="h-1.5 w-1.5 rounded-full bg-vscode-muted/30" />
        <div>
          <p class="text-[13px] font-medium text-vscode-fg">Server not running</p>
          <p class="mt-1 text-[12px] text-vscode-muted">
            Install or update OpenCode if needed, then restart the server.
          </p>
        </div>
        <SecondaryButton label="Restart Server" onClick={restartServer} />
      </Show>

      <Show when={serverStatus().state === 'error'}>
        <Switch fallback={<GenericErrorState message={errorMessage()} />}>
          <Match when={errorKind() === 'cli-missing'}>
            <MissingCliState />
          </Match>
          <Match when={errorKind() === 'cli-path-invalid'}>
            <InvalidPathState message={errorMessage()} detail={errorDetail()} />
          </Match>
          <Match
            when={
              errorKind() === 'update-required' ||
              errorKind() === 'update-blocked' ||
              errorKind() === 'update-failed'
            }
          >
            <UpdateState message={errorMessage()} detail={errorDetail()} />
          </Match>
        </Switch>
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
          <SetupCommandCard label="Setup" command="opencode auth login" />
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

function MissingCliState() {
  return (
    <div class="flex w-full max-w-62.5 flex-col items-center gap-4 text-center">
      <WarningIcon />
      <div class="flex flex-col gap-1.5">
        <p class="text-[13px] font-medium text-vscode-fg">OpenCode is not installed</p>
        <p class="text-[12px] leading-normal text-vscode-muted">
          Varro gives{' '}
          <button
            type="button"
            class="text-vscode-link hover:text-vscode-link-active hover:underline"
            onClick={() => openExternal(OPENCODE_INSTALL_DOCS_URL)}
          >
            OpenCode
          </button>{' '}
          a native UI.
          <br />
          Install the CLI to get started.
        </p>
      </div>
      <SetupCommandCard label="Install" command={OPENCODE_INSTALL_COMMAND} />
      <button
        type="button"
        class="server-status-action-button"
        onClick={() => runInTerminal(OPENCODE_INSTALL_COMMAND, 'OpenCode Install')}
      >
        Open terminal and install
      </button>
      <RecoveryActions />
      {/* Installs under a Node version manager land outside the directories
          Varro can scan, so point at the escape hatch instead of insisting
          OpenCode is missing. */}
      <p class="px-4 text-[11px] leading-normal text-vscode-muted">
        Already installed? Varro could not find it on PATH — set the full path in{' '}
        <button
          type="button"
          class="text-vscode-link hover:text-vscode-link-active hover:underline"
          onClick={() => openSettings('varro.server.command')}
        >
          varro.server.command
        </button>
        .
      </p>
      <button
        type="button"
        class="text-[11px] text-vscode-link hover:text-vscode-link-active hover:underline"
        onClick={() => openExternal(OPENCODE_INSTALL_DOCS_URL)}
      >
        Learn more at opencode.ai
      </button>
    </div>
  );
}

function InvalidPathState(props: { message: string; detail: ServerErrorDetail }) {
  return (
    <div class="flex w-full max-w-75 flex-col items-center gap-4 text-center">
      <WarningIcon />
      <div class="flex flex-col gap-1.5 px-4">
        <p class="text-[13px] font-medium text-vscode-fg">Configured OpenCode path not found</p>
        <p class="text-[12px] leading-normal text-vscode-muted">{props.message}</p>
      </div>
      <Show when={props.detail.configuredCommand}>
        <SetupCommandCard label="Configured path" command={props.detail.configuredCommand || ''} />
      </Show>
      <button
        type="button"
        class="server-status-action-button"
        onClick={() => openSettings(props.detail.settingId || 'varro.server.command')}
      >
        Open settings
      </button>
      <RecoveryActions showOutput />
    </div>
  );
}

function UpdateState(props: { message: string; detail: ServerErrorDetail }) {
  const isWaiting = () => props.detail.blockedBy === 'active-sessions';
  const allowsUpdateCommand = () =>
    props.detail.kind !== 'update-blocked' ||
    props.detail.blockedBy === 'auto-update-disabled' ||
    props.detail.blockedBy === 'auto-start-disabled';
  const blocksRestart = () => props.detail.blockedBy === 'foreign-owner';
  const title = () =>
    isWaiting()
      ? 'Waiting to update OpenCode'
      : props.detail.kind === 'update-failed'
        ? 'OpenCode update failed'
        : 'OpenCode update required';

  return (
    <div class="flex w-full max-w-75 flex-col items-center gap-4 text-center">
      <Show when={isWaiting()} fallback={<UpdateIcon />}>
        <WaitingIcon />
      </Show>
      <div class="flex flex-col gap-1.5 px-4">
        <p class="text-[13px] font-medium text-vscode-fg">{title()}</p>
        <p class="text-[12px] leading-normal text-vscode-muted">{props.message}</p>
      </div>

      <Show when={!isWaiting() && allowsUpdateCommand() && props.detail.suggestedCommand}>
        <SetupCommandCard label="Update" command={props.detail.suggestedCommand || ''} />
        <button
          type="button"
          class="server-status-action-button"
          onClick={() => runInTerminal(props.detail.suggestedCommand || '', 'OpenCode Update')}
        >
          Open terminal and update
        </button>
      </Show>

      <Show when={isWaiting()}>
        <p class="px-4 text-[11px] leading-normal text-vscode-muted">
          Varro will check again and only restart after the server is idle.
        </p>
        <SecondaryButton label="Check Again" onClick={restartServer} />
      </Show>

      <RecoveryActions
        settingId={props.detail.settingId}
        showOutput
        allowRestart={!isWaiting() && !blocksRestart()}
      />
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
      <RecoveryActions showOutput />
    </div>
  );
}
