import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { asRecord } from '../../shared/type-utils';
import {
  isModelVisible,
  setModelVisible,
  setProviderVisible,
  setShowSettings,
  state,
} from '../lib/state';
import { formatContextLimit, formatModelReleaseDate } from '../lib/format';
import {
  modelSupportsTools,
  modelSupportsVariants,
  modelSupportsVision,
} from '../lib/model-capabilities';
import { sortProviderModels } from '../lib/model-ordering';
import { isRunningSessionStatus } from '../lib/session-event-reducer';
import { openProviderLogout, openProviderSetup } from '../lib/provider-setup';
import {
  providerRequiresReconnection,
  requestProviderConnection,
} from '../lib/provider-connection-state';
import { client } from '../lib/client';
import { postMessage } from '../lib/bridge';
import { refreshRoutingState } from '../hooks/useOpenCode';
import type { OpenCodeModelRouting, Provider } from '../types';
import { FormattedModelName } from './chat-input/ToolbarPickers';
import { ProviderConnectionDialog } from './ProviderConnectionDialog';
import { ProviderDisconnectionDialog } from './ProviderDisconnectionDialog';

type SettingsProvider = (typeof state.providers)[number];
type SettingsModel = SettingsProvider['models'][string];
type ModelContextMenuState = {
  x: number;
  y: number;
  providerID: string;
  modelID: string;
};
type ModelRouteTag = {
  kind: 'agent' | 'small' | 'approve' | 'commit';
  text: string;
  label: string;
  change?: 'old' | 'new' | 'removed';
};

const MIN_RELOAD_INDICATOR_MS = 500;

function routableAgents() {
  return state.allAgents.filter((agent) => agent.mode === 'subagent');
}

export function ModelsPanel() {
  onMount(() => {
    void refreshRoutingState();
  });

  const [query, setQuery] = createSignal('');
  const [routing, setRouting] = createSignal<OpenCodeModelRouting>(createEmptyRouting());
  const [previousRouting, setPreviousRouting] = createSignal<OpenCodeModelRouting | null>(null);
  const [contextMenu, setContextMenu] = createSignal<ModelContextMenuState | null>(null);
  const [isSaving, setIsSaving] = createSignal(false);
  const [isReloading, setIsReloading] = createSignal(false);
  const [providerConnectionData, setProviderConnectionData] = createSignal<{
    providers: Provider[];
    error: string;
    loading: boolean;
    initialProviderID: string | null;
  } | null>(null);
  const [providerDisconnectionData, setProviderDisconnectionData] = createSignal<{
    providers: Provider[];
    connected: string[];
    error: string;
    loading: boolean;
  } | null>(null);
  let bodyRef: HTMLDivElement | undefined;
  let reloadIndicatorTimer: ReturnType<typeof setTimeout> | undefined;

  const workspaceStatusText = createMemo(() =>
    state.workspaceStatuses.map((entry) => `${entry.workspaceID} (${entry.status})`).join(', ')
  );
  const runningAgentCount = createMemo(() => {
    const parentSessionIds = new Set(
      state.sessions.filter((session) => !session.parentID).map((session) => session.id)
    );
    return Object.entries(state.sessionStatus).filter(
      ([sessionId, status]) => parentSessionIds.has(sessionId) && isRunningSessionStatus(status)
    ).length;
  });
  let refreshWasPending = state.providerRefreshPending;

  createEffect(() => {
    const refreshIsPending = state.providerRefreshPending;
    if (refreshWasPending && !refreshIsPending) setPreviousRouting(null);
    refreshWasPending = refreshIsPending;
  });

  const normalizedQuery = createMemo(() => query().trim().toLocaleLowerCase());

  const filteredProviders = createMemo(() => {
    const search = normalizedQuery();

    return state.providers
      .map((provider) => {
        const models = sortProviderModels(Object.values(provider.models));

        if (!search) return { provider, models };

        const providerMatches = [provider.name, provider.id].some((value) =>
          value.toLocaleLowerCase().includes(search)
        );

        return {
          provider,
          models: providerMatches
            ? models
            : models.filter((model) =>
                [model.name, model.id].some((value) => value.toLocaleLowerCase().includes(search))
              ),
        };
      })
      .filter((entry) => entry.models.length > 0);
  });

  function updateScrollbarInset() {
    if (!bodyRef) return;
    const scrollbarInset = Math.max(0, bodyRef.offsetWidth - bodyRef.clientWidth);
    bodyRef.parentElement?.style.setProperty('--settings-scrollbar-inset', `${scrollbarInset}px`);
  }

  async function loadRouting() {
    try {
      setRouting(normalizeModelRouting(await client.varro.openCodeConfig()));
    } catch {
      setRouting(createEmptyRouting());
    }
  }

  async function saveRouting(body: {
    target: 'small_model' | 'agent' | 'commit_message' | 'auto_approve';
    providerID: string;
    modelID: string;
    agentName?: string;
    unset?: boolean;
  }) {
    const updatesOpenCodeConfig = body.target === 'small_model' || body.target === 'agent';
    if (updatesOpenCodeConfig && !previousRouting()) setPreviousRouting(routing());
    setIsSaving(true);
    try {
      const nextRouting = normalizeModelRouting(await client.varro.saveModelRouting(body));
      setRouting(nextRouting);
      if (updatesOpenCodeConfig && !state.providerRefreshPending) setPreviousRouting(null);
      await refreshRoutingState();
    } catch (error) {
      if (updatesOpenCodeConfig && !state.providerRefreshPending) setPreviousRouting(null);
      throw error;
    } finally {
      setIsSaving(false);
      setContextMenu(null);
    }
  }

  function closeContextMenu() {
    setContextMenu(null);
  }

  function reloadProviders() {
    if (isReloading()) return;
    setIsReloading(true);
    reloadIndicatorTimer = setTimeout(() => {
      setIsReloading(false);
    }, MIN_RELOAD_INDICATOR_MS);
    postMessage({ type: 'providers/refresh' });
  }

  async function openProviderConnection(initialProviderID: string | null = null) {
    if (providerConnectionData()) return;
    const loadingState = { providers: [], error: '', loading: true, initialProviderID };
    setProviderConnectionData(loadingState);
    try {
      const catalog = await client.config.providerCatalog();
      if (providerConnectionData() !== loadingState) return;
      setProviderConnectionData({
        providers: catalog.all,
        error: '',
        loading: false,
        initialProviderID,
      });
    } catch (error) {
      if (providerConnectionData() !== loadingState) return;
      setProviderConnectionData({
        providers: [],
        error: error instanceof Error ? error.message : String(error),
        loading: false,
        initialProviderID,
      });
    }
  }

  async function openProviderDisconnection() {
    if (providerDisconnectionData()) return;
    const loadingState = { providers: [], connected: [], error: '', loading: true };
    setProviderDisconnectionData(loadingState);
    try {
      const catalog = await client.config.providerCatalog();
      if (providerDisconnectionData() !== loadingState) return;
      setProviderDisconnectionData({
        providers: catalog.all,
        connected: catalog.connected,
        error: '',
        loading: false,
      });
    } catch (error) {
      if (providerDisconnectionData() !== loadingState) return;
      setProviderDisconnectionData({
        providers: [],
        connected: [],
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      });
    }
  }

  onCleanup(() => clearTimeout(reloadIndicatorTimer));

  onMount(() => {
    updateScrollbarInset();
    void loadRouting();
    if (!bodyRef) return;
    const observer = new ResizeObserver(() => updateScrollbarInset());
    observer.observe(bodyRef);
    onCleanup(() => observer.disconnect());
  });

  onMount(() => {
    const onPointerDown = () => closeContextMenu();
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !contextMenu()) return;
      event.preventDefault();
      closeContextMenu();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onEscape);
    onCleanup(() => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onEscape);
    });
  });

  return (
    <div class="settings-panel">
      <div class="settings-header">
        <div class="settings-header-inner">
          <div class="settings-header-left">
            <button class="chat-header-btn" onClick={() => setShowSettings(false)} title="Back">
              <svg viewBox="0 0 16 16" fill="currentColor">
                <path d="M5.928 7.976l4.357-4.357-.618-.62L4.69 7.976l4.977 4.977.618-.618z" />
              </svg>
            </button>
            <span class="settings-header-title">Models</span>
          </div>
          <div class="settings-header-actions">
            <button
              type="button"
              class={`chat-header-btn ${isReloading() ? 'is-loading' : ''}`}
              onClick={reloadProviders}
              title={isReloading() ? 'Reloading providers' : 'Reload providers'}
              aria-label={isReloading() ? 'Reloading providers' : 'Reload providers'}
              aria-busy={isReloading()}
              disabled={isReloading()}
            >
              <svg
                class="settings-reload-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M21.8883 13.5C21.1645 18.3113 17.013 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C16.1006 2 19.6248 4.46819 21.1679 8" />
                <path d="M17 8H21.4C21.7314 8 22 7.73137 22 7.4V3" />
              </svg>
            </button>
            <button
              type="button"
              class="chat-header-btn"
              onClick={(event) =>
                event.altKey ? openProviderLogout() : void openProviderDisconnection()
              }
              title="Disconnect provider (Option-click for terminal manager)"
              aria-label="Remove provider"
            >
              <svg viewBox="0 0 16 16" fill="currentColor">
                <path d="M3 7.25h10a.75.75 0 010 1.5H3a.75.75 0 010-1.5z" />
              </svg>
            </button>
            <button
              type="button"
              class="chat-header-btn"
              onClick={(event) =>
                event.altKey ? openProviderSetup() : void openProviderConnection()
              }
              title="Connect provider (Option-click for terminal setup)"
              aria-label="Add provider"
            >
              <svg viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 2.25a.75.75 0 01.75.75v4.25H13a.75.75 0 010 1.5H8.75V13a.75.75 0 01-1.5 0V8.75H3a.75.75 0 010-1.5h4.25V3A.75.75 0 018 2.25z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <Show when={state.providerRefreshPending && runningAgentCount() > 0}>
        <div class="settings-provider-refresh-notice" role="status">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 7L12 13" />
            <path d="M12 17.01L12.01 16.9989" />
            <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" />
          </svg>
          <span>
            <strong>Configuration update queued.</strong> Changes will appear automatically when{' '}
            {runningAgentCount()} running{' '}
            {runningAgentCount() === 1 ? 'agent finishes' : 'agents finish'}.
            <Show when={previousRouting()}>
              {' '}
              Old and new assignments are labeled in the model list.
            </Show>
          </span>
        </div>
      </Show>

      <Show when={state.workspaceStatuses.length > 0}>
        <div class="settings-toolbar">
          <div class="settings-toolbar-inner flex flex-wrap items-center gap-2">
            <Show when={state.workspaceStatuses.length > 0}>
              <div class="text-[11px] text-vscode-muted">Workspaces: {workspaceStatusText()}</div>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={state.providers.length > 0}>
        <div class="settings-toolbar">
          <div class="settings-toolbar-inner">
            <div class="settings-search">
              <input
                type="text"
                class="settings-search-input"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                placeholder="Filter providers or models"
                aria-label="Filter providers or models"
                spellcheck={false}
              />
              <Show when={query().length > 0}>
                <button
                  type="button"
                  class="settings-search-clear"
                  onClick={() => setQuery('')}
                  aria-label="Clear filter"
                  title="Clear filter"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor">
                    <path d="M3.22 3.22a.75.75 0 011.06 0L8 6.94l3.72-3.72a.75.75 0 111.06 1.06L9.06 8l3.72 3.72a.75.75 0 11-1.06 1.06L8 9.06l-3.72 3.72a.75.75 0 01-1.06-1.06L6.94 8 3.22 4.28a.75.75 0 010-1.06z" />
                  </svg>
                </button>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <div class="settings-body" ref={(el) => (bodyRef = el)}>
        <div class="settings-body-inner">
          <Show
            when={state.providers.length > 0}
            fallback={<div class="settings-empty">No providers configured</div>}
          >
            <Show
              when={filteredProviders().length > 0}
              fallback={<div class="settings-empty">No matching models</div>}
            >
              <For each={filteredProviders()}>
                {({ provider, models }) => (
                  <ProviderSection
                    provider={provider}
                    models={models}
                    reconnectRequired={providerRequiresReconnection(provider.id)}
                    forceExpanded={normalizedQuery().length > 0}
                    routing={routing()}
                    previousRouting={state.providerRefreshPending ? previousRouting() : null}
                    onOpenContextMenu={(next) => setContextMenu(next)}
                  />
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>

      <Show when={contextMenu()} keyed>
        {(menu) => (
          <Portal>
            <div
              class="settings-context-menu"
              style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                class="settings-context-menu-item"
                disabled={isSaving()}
                onClick={() =>
                  void saveRouting({
                    target: 'small_model',
                    providerID: menu.providerID,
                    modelID: menu.modelID,
                    ...(isModelRoute(routing().smallModel, menu.providerID, menu.modelID)
                      ? { unset: true }
                      : {}),
                  })
                }
              >
                {isModelRoute(routing().smallModel, menu.providerID, menu.modelID)
                  ? "Don't use as "
                  : 'Use as '}
                <strong>small</strong> model
              </button>
              <button
                type="button"
                class="settings-context-menu-item"
                disabled={isSaving()}
                onClick={() =>
                  void saveRouting({
                    target: 'commit_message',
                    providerID: menu.providerID,
                    modelID: menu.modelID,
                    ...(isModelRoute(routing().commitMessageModel, menu.providerID, menu.modelID)
                      ? { unset: true }
                      : {}),
                  })
                }
              >
                {isModelRoute(routing().commitMessageModel, menu.providerID, menu.modelID)
                  ? "Don't use for "
                  : 'Use for '}
                <strong>commit messages</strong>
              </button>
              <button
                type="button"
                class="settings-context-menu-item"
                disabled={isSaving()}
                onClick={() =>
                  void saveRouting({
                    target: 'auto_approve',
                    providerID: menu.providerID,
                    modelID: menu.modelID,
                    ...(isModelRoute(routing().autoApproveModel, menu.providerID, menu.modelID)
                      ? { unset: true }
                      : {}),
                  })
                }
              >
                {isModelRoute(routing().autoApproveModel, menu.providerID, menu.modelID)
                  ? "Don't use for "
                  : 'Use for '}
                <strong>auto-approve</strong>
              </button>
              <For each={routableAgents()}>
                {(agent) => {
                  const isAssigned = () =>
                    isModelRoute(routing().agentModels[agent.name], menu.providerID, menu.modelID);
                  return (
                    <button
                      type="button"
                      class="settings-context-menu-item"
                      disabled={isSaving()}
                      onClick={() =>
                        void saveRouting({
                          target: 'agent',
                          agentName: agent.name,
                          providerID: menu.providerID,
                          modelID: menu.modelID,
                          ...(isAssigned() ? { unset: true } : {}),
                        })
                      }
                    >
                      {isAssigned() ? "Don't use for " : 'Use for '}
                      <strong>{agent.name}</strong> agent
                    </button>
                  );
                }}
              </For>
            </div>
          </Portal>
        )}
      </Show>
      <Show when={providerConnectionData()}>
        {(data) => (
          <ProviderConnectionDialog
            catalogProviders={data().providers}
            providerLoadError={data().error}
            isLoadingProviders={data().loading}
            initialProviderID={data().initialProviderID}
            onClose={() => setProviderConnectionData(null)}
          />
        )}
      </Show>
      <Show when={providerDisconnectionData()}>
        {(data) => (
          <ProviderDisconnectionDialog
            catalogProviders={data().providers}
            connectedProviderIDs={data().connected}
            providerLoadError={data().error}
            isLoadingProviders={data().loading}
            onClose={() => setProviderDisconnectionData(null)}
          />
        )}
      </Show>
    </div>
  );
}

function ProviderSection(props: {
  provider: SettingsProvider;
  models: SettingsModel[];
  reconnectRequired: boolean;
  forceExpanded: boolean;
  routing: OpenCodeModelRouting;
  previousRouting: OpenCodeModelRouting | null;
  onOpenContextMenu: (menu: ModelContextMenuState) => void;
}) {
  const allModels = () => Object.values(props.provider.models);

  const enabledCount = () =>
    props.models.filter((m) => isModelVisible(props.provider.id, m.id)).length;

  const [expanded, setExpanded] = createSignal(enabledCount() > 0);

  const allEnabled = () => props.models.length > 0 && enabledCount() === props.models.length;
  const someEnabled = () => enabledCount() > 0 && !allEnabled();
  const isFullProviderView = () => props.models.length === allModels().length;
  const isExpanded = () => props.forceExpanded || props.reconnectRequired || expanded();

  function toggleProvider() {
    const visible = !allEnabled();

    if (isFullProviderView()) {
      setProviderVisible(props.provider.id, visible);
    }

    for (const model of props.models) {
      setModelVisible(props.provider.id, model.id, visible);
    }
  }

  return (
    <div class="settings-provider">
      <div class="settings-provider-header">
        <button
          class="settings-provider-toggle"
          onClick={() => !props.forceExpanded && setExpanded((v) => !v)}
        >
          <svg
            class={`settings-chevron ${isExpanded() ? 'expanded' : ''}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
          <span class="settings-provider-name">{props.provider.name}</span>
          <span class="settings-provider-count">
            {props.reconnectRequired ? 'Reconnect' : `${enabledCount()}/${props.models.length}`}
          </span>
        </button>
        <Show when={!props.reconnectRequired}>
          <ProviderCheckbox
            checked={allEnabled()}
            indeterminate={someEnabled()}
            onChange={toggleProvider}
          />
        </Show>
      </div>

      <Show when={isExpanded()}>
        <Show
          when={!props.reconnectRequired}
          fallback={
            <div class="settings-provider-auth-required">
              <span>Authentication is required to load available models.</span>
              <button type="button" onClick={() => requestProviderConnection(props.provider.id)}>
                Re-authenticate
              </button>
            </div>
          }
        >
          <div class="settings-model-list">
            <For each={props.models}>
              {(model) => {
                const supportsTools = () =>
                  modelSupportsTools(props.provider.id, model.id, state.providers);
                const supportsVariants = () =>
                  modelSupportsVariants(props.provider.id, model.id, state.providers);
                const supportsVision = () =>
                  modelSupportsVision(props.provider.id, model.id, state.providers);
                const routeTags = () =>
                  getModelRouteTags(
                    props.routing,
                    props.provider.id,
                    model.id,
                    props.previousRouting
                  );
                const releaseDate = () => formatModelReleaseDate(model.release_date);

                return (
                  <label
                    class="settings-model-row"
                    onContextMenu={(event) => {
                      event.preventDefault();
                      props.onOpenContextMenu({
                        x: event.clientX,
                        y: event.clientY,
                        providerID: props.provider.id,
                        modelID: model.id,
                      });
                    }}
                  >
                    <input
                      type="checkbox"
                      class="settings-checkbox"
                      checked={isModelVisible(props.provider.id, model.id)}
                      onChange={(e) =>
                        setModelVisible(props.provider.id, model.id, e.currentTarget.checked)
                      }
                    />
                    <span class="settings-model-name-wrap">
                      <span class="settings-model-name">
                        <FormattedModelName name={model.name} />
                      </span>
                      <Show when={state.providerDefaults[props.provider.id] === model.id}>
                        <span class="model-default-label">(default)</span>
                      </Show>
                    </span>
                    <Show
                      when={
                        supportsTools() ||
                        supportsVariants() ||
                        supportsVision() ||
                        model.limit?.context ||
                        releaseDate() ||
                        routeTags().length > 0
                      }
                    >
                      <span class="settings-model-meta">
                        <span class="model-release-date">
                          <Show when={releaseDate()}>{(date) => date()}</Show>
                        </span>
                        <span class="settings-model-badges">
                          <For each={routeTags()}>{(tag) => <ModelRouteBadge tag={tag} />}</For>
                          <Show when={supportsTools()}>
                            <span class="model-capability-tag model-capability-tag-tools">
                              Tools
                            </span>
                          </Show>
                          <Show when={supportsVariants()}>
                            <span class="model-capability-tag model-capability-tag-variants">
                              Variants
                            </span>
                          </Show>
                          <Show when={supportsVision()}>
                            <span class="model-capability-tag model-capability-tag-vision">
                              Vision
                            </span>
                          </Show>
                          <Show when={model.limit?.context}>
                            <span class="settings-model-ctx">
                              {formatContextLimit(model.limit!.context)}
                            </span>
                          </Show>
                        </span>
                      </span>
                    </Show>
                  </label>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}

function getModelRouteTags(
  routing: OpenCodeModelRouting,
  providerID: string,
  modelID: string,
  previousRouting: OpenCodeModelRouting | null
) {
  const tags: ModelRouteTag[] = [];

  if (previousRouting && !areModelRoutesEqual(previousRouting.smallModel, routing.smallModel)) {
    if (isModelRoute(previousRouting.smallModel, providerID, modelID)) {
      tags.push(
        routing.smallModel
          ? { kind: 'small', text: 'small', label: 'Small model (old)', change: 'old' }
          : {
              kind: 'small',
              text: 'small',
              label: 'Small model (will be removed)',
              change: 'removed',
            }
      );
    }
    if (isModelRoute(routing.smallModel, providerID, modelID)) {
      tags.push({ kind: 'small', text: 'small', label: 'Small model (new)', change: 'new' });
    }
  } else if (isModelRoute(routing.smallModel, providerID, modelID)) {
    tags.push({ kind: 'small', text: 'small', label: 'Small model' });
  }

  if (
    routing.commitMessageModel?.providerID === providerID &&
    routing.commitMessageModel.modelID === modelID
  ) {
    tags.push({ kind: 'commit', text: 'commit', label: 'Commit message model' });
  }

  if (
    routing.autoApproveModel?.providerID === providerID &&
    routing.autoApproveModel.modelID === modelID
  ) {
    tags.push({ kind: 'approve', text: 'approve', label: 'Auto-approve model' });
  }

  const agentNames = new Set([
    ...Object.keys(routing.agentModels ?? {}),
    ...Object.keys(previousRouting?.agentModels ?? {}),
  ]);
  for (const agentName of agentNames) {
    const route = routing.agentModels[agentName];
    const previousRoute = previousRouting?.agentModels[agentName];
    if (previousRouting && !areModelRoutesEqual(previousRoute, route)) {
      if (isModelRoute(previousRoute, providerID, modelID)) {
        tags.push({
          kind: 'agent',
          text: agentName,
          label: route
            ? `Agent model: ${agentName} (old)`
            : `Agent model: ${agentName} (will be removed)`,
          change: route ? 'old' : 'removed',
        });
      }
      if (isModelRoute(route, providerID, modelID)) {
        tags.push({
          kind: 'agent',
          text: agentName,
          label: `Agent model: ${agentName} (new)`,
          change: 'new',
        });
      }
    } else if (isModelRoute(route, providerID, modelID)) {
      tags.push({ kind: 'agent', text: agentName, label: `Agent model: ${agentName}` });
    }
  }

  return tags;
}

function isModelRoute(
  route: { providerID: string; modelID: string } | null | undefined,
  providerID: string,
  modelID: string
) {
  return route?.providerID === providerID && route.modelID === modelID;
}

function areModelRoutesEqual(
  left: { providerID: string; modelID: string } | null | undefined,
  right: { providerID: string; modelID: string } | null | undefined
) {
  if (!left || !right) return left == null && right == null;
  return left.providerID === right.providerID && left.modelID === right.modelID;
}

function ModelRouteBadge(props: { tag: ModelRouteTag }) {
  return (
    <span
      class={`model-capability-tag settings-route-tag settings-route-tag-${props.tag.kind}${
        props.tag.change ? ` settings-route-tag-${props.tag.change}` : ''
      }`}
      title={props.tag.label}
      aria-label={props.tag.label}
    >
      {props.tag.text}
      <Show when={props.tag.change !== 'removed' ? props.tag.change : undefined}>
        {(change) => <span class="settings-route-tag-change">{change()}</span>}
      </Show>
    </span>
  );
}

function createEmptyRouting(): OpenCodeModelRouting {
  return {
    smallModel: null,
    agentModels: {},
    commitMessageModel: null,
    autoApproveModel: null,
  };
}

function normalizeModelRouting(value: unknown): OpenCodeModelRouting {
  const record = asRecord(value);
  if (!record) return createEmptyRouting();

  // preview.html proxies directly to OpenCode, which may expose raw opencode.json keys.
  const smallModel = parseModelRoute(record.smallModel) ?? parseModelRoute(record.small_model);
  const commitMessageModel = parseModelRoute(record.commitMessageModel);
  const autoApproveModel = parseModelRoute(record.autoApproveModel);
  const agentModels: OpenCodeModelRouting['agentModels'] = {};
  const rawAgents = asRecord(record.agent);

  if (rawAgents) {
    for (const [agentName, rawAgent] of Object.entries(rawAgents)) {
      const route = parseModelRoute(asRecord(rawAgent)?.model);
      if (route) agentModels[agentName] = route;
    }
  }

  const rawAgentModels = asRecord(record.agentModels);

  if (rawAgentModels) {
    for (const [agentName, routeValue] of Object.entries(rawAgentModels)) {
      const route = parseModelRoute(routeValue);
      if (route) agentModels[agentName] = route;
    }
  }

  return { smallModel, agentModels, commitMessageModel, autoApproveModel };
}

function parseModelRoute(value: unknown): OpenCodeModelRouting['smallModel'] {
  if (typeof value === 'string') {
    const separatorIndex = value.indexOf('/');
    if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null;
    return {
      providerID: value.slice(0, separatorIndex),
      modelID: value.slice(separatorIndex + 1),
    };
  }

  const record = asRecord(value);
  if (!record) return null;

  const providerID = typeof record.providerID === 'string' ? record.providerID.trim() : '';
  const modelID = typeof record.modelID === 'string' ? record.modelID.trim() : '';

  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

function ProviderCheckbox(props: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
}) {
  // oxlint-disable-next-line no-unassigned-vars
  let ref: HTMLInputElement | undefined;

  createEffect(() => {
    if (ref) ref.indeterminate = props.indeterminate;
  });

  return (
    <label class="settings-checkbox-label" title="Toggle all">
      <input
        ref={ref}
        type="checkbox"
        class="settings-checkbox"
        checked={props.checked}
        onChange={props.onChange}
      />
    </label>
  );
}
