import { Match, Show, Switch, createMemo, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import { OPENCODE_UPDATE_REQUIRED_PREFIX } from '../../shared/opencode-compatibility';
import {
  OPENCODE_INSTALL_COMMAND,
  OPENCODE_INSTALL_DOCS_URL,
  OPENCODE_UPGRADE_COMMAND,
} from '../../shared/opencode-install';
import type { ServerErrorDetail } from '../../shared/protocol';
import { postMessage } from '../lib/bridge';
import { client } from '../lib/client';
import { defaultAppState } from '../lib/state';
import { statusIcons } from '../lib/status-icons';
import { checkIcon, copyIcon, playIcon, terminalIcon } from '../lib/ui-icons';
import { writeClipboard } from '../lib/write-clipboard';
import type { Provider } from '../types';
import { ProviderConnectionDialog } from './ProviderConnectionDialog';
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

function SetupCommandCard(props: { label: string; command: string; onRun: () => void }) {
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
    <div class="server-status-command">
      <p class="text-[10px] font-medium uppercase tracking-wide text-vscode-muted">
        {props.label}
        <span class="ml-1 font-normal normal-case tracking-normal opacity-70">
          (run in terminal)
        </span>
      </p>
      <div class="server-status-command-field" role="group" aria-label={`${props.label} command`}>
        <UiIcon source={terminalIcon} class="shrink-0 text-vscode-muted" width={16} height={16} />
        <pre class="server-status-command-text" title={props.command}>
          {props.command}
        </pre>
        <div class="flex shrink-0 items-center gap-1">
          <Tooltip content="Run in terminal" delay={500}>
            <button
              type="button"
              class="server-status-command-button"
              aria-label={`Run ${props.label.toLowerCase()} command in terminal`}
              onClick={props.onRun}
            >
              <UiIcon source={playIcon} width={14} height={14} />
            </button>
          </Tooltip>
          <Tooltip content={copied() ? 'Copied' : `Copy: ${props.command}`} delay={500}>
            <button
              type="button"
              class="server-status-command-button"
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
      </div>
    </div>
  );
}

function ServiceButton(props: { label: string; onClick: () => void }) {
  return (
    <button type="button" class="server-status-secondary-button" onClick={props.onClick}>
      {props.label}
    </button>
  );
}

function ServiceHeading(props: { icon: JSX.Element; title: string; description?: string }) {
  return (
    <div class="server-status-heading">
      {props.icon}
      <div class="flex w-full flex-col gap-1.5">
        <p class="text-[13px] font-medium text-vscode-fg">{props.title}</p>
        <Show when={props.description}>
          <p class="whitespace-pre-line text-[12px] leading-normal text-vscode-muted">
            {props.description}
          </p>
        </Show>
      </div>
    </div>
  );
}

/**
 * Only offer restart when the CLI is available and restarting is safe.
 * In particular, preserve the active-sessions gate that refused to stop it.
 */
function RecoveryActions(props: {
  settingId?: string;
  showOutput?: boolean;
  allowRestart?: boolean;
  checkAgain?: boolean;
}) {
  return (
    <div class="flex flex-wrap items-center justify-center gap-2">
      <Show when={props.checkAgain}>
        <ServiceButton label="Check Again" onClick={restartServer} />
      </Show>
      <Show when={props.allowRestart !== false}>
        <ServiceButton label="Restart Server" onClick={restartServer} />
      </Show>
      <Show when={props.settingId}>
        <ServiceButton label="Open Settings" onClick={() => openSettings(props.settingId || '')} />
      </Show>
      <Show when={props.showOutput}>
        <ServiceButton label="Show Output" onClick={showOutput} />
      </Show>
    </div>
  );
}

function WarningIcon() {
  return (
    <UiIcon
      source={statusIcons.warningTriangle}
      class="h-6 w-6 shrink-0 text-vscode-warning"
      width={24}
      height={24}
    />
  );
}

function UpdateIcon() {
  return (
    <UiIcon
      source={statusIcons.download}
      class="h-6 w-6 shrink-0 text-vscode-warning"
      width={24}
      height={24}
    />
  );
}

function WaitingIcon() {
  return (
    <UiIcon
      source={statusIcons.clock}
      class="h-6 w-6 shrink-0 text-vscode-accent"
      width={24}
      height={24}
    />
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
    <div class="server-status-surface">
      <Show when={serverStatus().state === 'starting'}>
        <div class="flex items-center gap-2">
          <span class="loading-dot" />
          <span class="loading-dot" style={{ 'animation-delay': '0.3s' }} />
          <span class="loading-dot" style={{ 'animation-delay': '0.6s' }} />
        </div>
        <div>
          <p class="text-[13px] font-medium text-vscode-fg">Connecting to OpenCode...</p>
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
            <InvalidPathState detail={errorDetail()} />
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
        <NoProvidersState />
      </Show>
    </div>
  );
}

function NoProvidersState() {
  const [connectionData, setConnectionData] = createSignal<{
    providers: Provider[];
    error: string;
    loading: boolean;
  } | null>(null);
  onCleanup(() => setConnectionData(null));

  async function openProviders() {
    if (connectionData()) return;
    const loadingState = { providers: [], error: '', loading: true };
    setConnectionData(loadingState);
    try {
      const catalog = await client.config.providerCatalog();
      if (connectionData() !== loadingState) return;
      setConnectionData({ providers: catalog.all, error: '', loading: false });
    } catch (error) {
      if (connectionData() !== loadingState) return;
      setConnectionData({
        providers: [],
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      });
    }
  }

  return (
    <>
      <div class="server-status-content">
        <ServiceHeading
          icon={
            <UiIcon
              source={statusIcons.brainWarning}
              width={24}
              height={24}
              class="h-6 w-6 shrink-0 text-vscode-accent"
            />
          }
          title="No providers configured"
          description="OpenCode is running, but it does not have any providers configured yet. Connect a provider in Varro."
        />
        <ServiceButton label="Open Providers" onClick={() => void openProviders()} />
      </div>
      <Show when={connectionData()}>
        {(data) => (
          <ProviderConnectionDialog
            catalogProviders={data().providers}
            providerLoadError={data().error}
            isLoadingProviders={data().loading}
            onClose={() => setConnectionData(null)}
          />
        )}
      </Show>
    </>
  );
}

function MissingCliState() {
  return (
    <div class="server-status-content">
      <ServiceHeading icon={<WarningIcon />} title="OpenCode is not installed" />
      <SetupCommandCard
        label="Install"
        command={OPENCODE_INSTALL_COMMAND}
        onRun={() => runInTerminal(OPENCODE_INSTALL_COMMAND, 'OpenCode Install')}
      />
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

function InvalidPathState(props: { detail: ServerErrorDetail }) {
  return (
    <div class="server-status-content">
      <ServiceHeading
        icon={<WarningIcon />}
        title="Configured OpenCode path not found"
        description="Update the configured path or clear it to search PATH."
      />
      <Show when={props.detail.configuredCommand}>
        <SetupCommandCard
          label="Configured path"
          command={props.detail.configuredCommand || ''}
          onRun={() => runInTerminal(props.detail.configuredCommand || '', 'OpenCode Command')}
        />
      </Show>
      <RecoveryActions
        settingId={props.detail.settingId || 'varro.server.command'}
        showOutput
        allowRestart={false}
      />
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
  const description = () => {
    if (isWaiting()) {
      return 'The server has active sessions and was not stopped to avoid interrupting work.';
    }
    if (props.detail.kind === 'update-failed') return 'The automatic update failed.';
    const message = props.message.startsWith(OPENCODE_UPDATE_REQUIRED_PREFIX)
      ? props.message.slice(OPENCODE_UPDATE_REQUIRED_PREFIX.length).trim()
      : props.message;
    return message
      .replace(
        /(Varro requires OpenCode \S+ or newer), but the (?:installed CLI|running server) is \S+\./,
        '$1.'
      )
      .replace('. Automatic updates', '.\nAutomatic updates');
  };

  return (
    <div class="server-status-content">
      <ServiceHeading
        icon={
          <Show when={isWaiting()} fallback={<UpdateIcon />}>
            <WaitingIcon />
          </Show>
        }
        title={title()}
        description={description()}
      />

      <Show when={!isWaiting() && allowsUpdateCommand() && props.detail.suggestedCommand}>
        <SetupCommandCard
          label="Update"
          command={props.detail.suggestedCommand || ''}
          onRun={() => runInTerminal(props.detail.suggestedCommand || '', 'OpenCode Update')}
        />
      </Show>

      <RecoveryActions showOutput allowRestart={!isWaiting()} checkAgain={isWaiting()} />
    </div>
  );
}

function GenericErrorState(props: { message: string }) {
  return (
    <div class="server-status-content">
      <ServiceHeading
        icon={
          <UiIcon
            source={statusIcons.warningCircle}
            class="h-6 w-6 shrink-0 text-vscode-error"
            width={24}
            height={24}
          />
        }
        title="OpenCode is unavailable"
        description={props.message.replace('. The server', '.\nThe server')}
      />
      <RecoveryActions settingId="varro.server" showOutput />
    </div>
  );
}
