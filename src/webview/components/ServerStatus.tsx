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
import {
  brainWarningIcon,
  checkIcon,
  clockIcon,
  copyIcon,
  downloadIcon,
  warningCircleSolidIcon,
  warningTriangleIcon,
} from '../lib/ui-icons';
import { writeClipboard } from '../lib/write-clipboard';
import { Tooltip } from './Tooltip';
import { UiIcon } from './UiIcon';

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
          <Tooltip content={copied() ? 'Copied' : `Copy: ${props.command}`} delay={500}>
            <button
              type="button"
              class="shrink-0 text-vscode-muted transition-colors hover:text-vscode-fg"
              aria-label={copied() ? 'Copied' : `Copy command: ${props.command}`}
              onClick={() => void handleCopy()}
            >
              <Show
                when={copied()}
                fallback={<UiIcon source={copyIcon} class="h-3.5 w-3.5" width={14} height={14} />}
              >
                <UiIcon
                  source={checkIcon}
                  class="h-3.5 w-3.5 text-vscode-success"
                  width={14}
                  height={14}
                />
              </Show>
            </button>
          </Tooltip>
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
 * Every error state offers a way out without leaving the panel - except where
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
      <UiIcon
        source={warningTriangleIcon}
        class="h-5 w-5 text-vscode-warning"
        width={20}
        height={20}
      />
    </div>
  );
}

function UpdateIcon() {
  return (
    <div class="flex h-10 w-10 items-center justify-center rounded-full bg-vscode-warning/10">
      <UiIcon source={downloadIcon} class="h-5 w-5 text-vscode-warning" width={20} height={20} />
    </div>
  );
}

function WaitingIcon() {
  return (
    <div class="flex h-10 w-10 items-center justify-center rounded-full bg-vscode-accent/10">
      <UiIcon source={clockIcon} class="h-5 w-5 text-vscode-accent" width={20} height={20} />
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
        <div role="status" aria-label="Detecting OpenCode server">
          <Show when={defaultAppState.state.emptyStateLogoUri}>
            <img
              class="server-status-detecting-logo animate-pulse-soft"
              src={defaultAppState.state.emptyStateLogoUri}
              alt="Varro"
            />
          </Show>
        </div>
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
            <UiIcon source={brainWarningIcon} width={20} height={20} class="text-vscode-accent" />
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
        Already installed? Varro could not find it on PATH - set the full path in{' '}
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
  const title = () =>
    isWaiting()
      ? 'Waiting to update OpenCode'
      : props.detail.kind === 'update-failed'
        ? 'OpenCode update failed'
        : 'OpenCode update required';

  return (
    <div class="flex w-full max-w-90 flex-col items-center gap-4 text-center">
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

      <RecoveryActions settingId={props.detail.settingId} showOutput allowRestart={!isWaiting()} />
    </div>
  );
}

function GenericErrorState(props: { message: string }) {
  return (
    <div class="flex w-full max-w-75 flex-col items-center gap-4 text-center">
      <div class="flex h-10 w-10 items-center justify-center rounded-full bg-vscode-error/10">
        <UiIcon
          source={warningCircleSolidIcon}
          class="h-5 w-5 text-vscode-error"
          width={20}
          height={20}
        />
      </div>
      <div class="flex flex-col gap-1.5 px-4">
        <p class="text-[13px] font-medium text-vscode-fg">OpenCode could not start</p>
        <p class="text-[12px] leading-normal text-vscode-muted">{props.message}</p>
      </div>
      <RecoveryActions showOutput />
    </div>
  );
}
