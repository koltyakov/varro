import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { asRecord } from '../../shared/type-utils';
import {
  isModelPinned,
  isModelVisible,
  getListedProviderModels,
  getModelDisplayName,
  hasManagedModelCatalog,
  isLargeModelCatalog,
  setModelsAdded,
  setModelDisplayName,
  setModelPinned,
  setModelVisible,
  setModelsVisible,
  setProviderVisible,
  setShowModels,
  setState,
  state,
} from '../lib/state';
import { formatContextLimit, formatModelReleaseDate } from '../lib/format';
import {
  modelSupportsAudio,
  modelSupportsPdf,
  modelSupportsTools,
  modelSupportsVariants,
  modelSupportsVideo,
  modelSupportsVision,
} from '../lib/model-capabilities';
import { compareProviders, sortProviderModels } from '../lib/model-ordering';
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
import { Tooltip } from './Tooltip';
import { isString } from '../lib/runtime-values';
import {
  calendarIcon,
  menuIcon,
  navArrowRightIcon,
  pinIcon,
  warningCircleIcon,
  xmarkIcon,
} from '../lib/ui-icons';
import { NavArrowLeftControlIcon } from './ControlIcons';
import { UiIcon } from './UiIcon';

type ModelProvider = (typeof state.providers)[number];
type ProviderModel = ModelProvider['models'][string];
type ModelContextMenuState = {
  x: number;
  y: number;
  providerID: string;
  modelID: string;
};
type ModelRenameState = {
  providerID: string;
  modelID: string;
  originalName: string;
  displayName: string;
};
type ModelRouteTag = {
  kind: 'agent' | 'small' | 'approve' | 'commit';
  text: string;
  label: string;
  change?: 'old' | 'new' | 'removed';
};

const MIN_RELOAD_INDICATOR_MS = 500;
const CONTEXT_MENU_VIEWPORT_MARGIN = 8;
const MODEL_CATALOG_RESULT_LIMIT = 50;

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
  const [renameDialog, setRenameDialog] = createSignal<ModelRenameState | null>(null);
  const [modelCatalogProvider, setModelCatalogProvider] = createSignal<ModelProvider | null>(null);
  const [showProviderActions, setShowProviderActions] = createSignal(false);
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
  let providerActionsButtonRef: HTMLButtonElement | undefined;
  let providerActionsMenuRef: HTMLDivElement | undefined;
  let renameInputRef: HTMLInputElement | undefined;
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
        const models = sortProviderModels(getListedProviderModels(provider));

        if (!search) return { provider, models };

        const providerMatches = [provider.name, provider.id].some((value) =>
          value.toLocaleLowerCase().includes(search)
        );

        return {
          provider,
          models: providerMatches
            ? models
            : models.filter((model) =>
                [getModelDisplayName(provider.id, model.id, model.name), model.name, model.id].some(
                  (value) => value.toLocaleLowerCase().includes(search)
                )
              ),
        };
      })
      .filter(
        (entry) =>
          entry.models.length > 0 ||
          isLargeModelCatalog(entry.provider) ||
          hasManagedModelCatalog(entry.provider.id)
      )
      .toSorted((a, b) => compareProviders(a.provider, b.provider));
  });
  const maxCapabilityCount = createMemo(() =>
    Math.max(
      0,
      ...filteredProviders().flatMap(({ provider, models }) =>
        models.map(
          (model) =>
            [
              modelSupportsTools(provider.id, model.id, state.providers),
              modelSupportsVariants(provider.id, model.id, state.providers),
              modelSupportsVision(provider.id, model.id, state.providers),
              modelSupportsPdf(provider.id, model.id, state.providers),
              modelSupportsAudio(provider.id, model.id, state.providers),
              modelSupportsVideo(provider.id, model.id, state.providers),
            ].filter(Boolean).length
        )
      )
    )
  );

  function updateScrollbarInset() {
    if (!bodyRef) return;
    const scrollbarInset = Math.max(0, bodyRef.offsetWidth - bodyRef.clientWidth);
    bodyRef.parentElement?.style.setProperty('--models-scrollbar-inset', `${scrollbarInset}px`);
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

  function hideModel(providerID: string, modelID: string) {
    const provider = state.providers.find((item) => item.id === providerID);
    if (provider) {
      setModelsAdded(
        providerID,
        getListedProviderModels(provider)
          .map((model) => model.id)
          .filter((id) => id !== modelID)
      );
    }
    closeContextMenu();
  }

  function positionContextMenu(element: HTMLDivElement, x: number, y: number) {
    queueMicrotask(() => {
      const maximumLeft = Math.max(
        CONTEXT_MENU_VIEWPORT_MARGIN,
        window.innerWidth - element.offsetWidth - CONTEXT_MENU_VIEWPORT_MARGIN
      );
      const maximumTop = Math.max(
        CONTEXT_MENU_VIEWPORT_MARGIN,
        window.innerHeight - element.offsetHeight - CONTEXT_MENU_VIEWPORT_MARGIN
      );
      element.style.left = `${Math.min(Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, x), maximumLeft)}px`;
      element.style.top = `${Math.min(Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, y), maximumTop)}px`;
    });
  }

  function renameModel(providerID: string, modelID: string) {
    const model = state.providers.find((provider) => provider.id === providerID)?.models[modelID];
    if (!model) return;
    setRenameDialog({
      providerID,
      modelID,
      originalName: model.name,
      displayName: getModelDisplayName(providerID, modelID, model.name),
    });
    closeContextMenu();
  }

  function saveModelName() {
    const rename = renameDialog();
    if (!rename) return;
    setModelDisplayName(
      rename.providerID,
      rename.modelID,
      renameInputRef?.value.trim() === rename.originalName ? '' : renameInputRef?.value || ''
    );
    setRenameDialog(null);
  }

  function reloadProviders() {
    if (isReloading()) return;
    setIsReloading(true);
    reloadIndicatorTimer = setTimeout(() => {
      setIsReloading(false);
    }, MIN_RELOAD_INDICATOR_MS);
    postMessage({ type: 'providers/refresh' });
  }

  function focusFirstProviderAction() {
    queueMicrotask(() =>
      providerActionsMenuRef?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    );
  }

  function handleProviderActionsKeyDown(event: KeyboardEvent) {
    const items = Array.from(
      providerActionsMenuRef?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []
    );
    if (!items.length) return;
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    let nextIndex: number | undefined;
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length;
    if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + items.length) % items.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = items.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    items[nextIndex]?.focus();
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
    const onPointerDown = () => {
      closeContextMenu();
      setShowProviderActions(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (!contextMenu() && !showProviderActions())) return;
      event.preventDefault();
      if (showProviderActions()) providerActionsButtonRef?.focus();
      closeContextMenu();
      setShowProviderActions(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onEscape);
    onCleanup(() => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onEscape);
    });
  });

  return (
    <div class="models-panel">
      <div class="models-header">
        <div class="models-header-inner">
          <div class="models-header-left">
            <Tooltip content="Back">
              <button
                class="chat-header-btn"
                onClick={() => setShowModels(false)}
                aria-label="Back"
              >
                <NavArrowLeftControlIcon class="models-header-back-icon" />
              </button>
            </Tooltip>
            <span class="models-header-title">Models</span>
          </div>
          <div class="models-header-actions">
            <Tooltip content="Provider actions">
              <button
                ref={(element) => (providerActionsButtonRef = element)}
                type="button"
                class="chat-header-btn"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setShowProviderActions((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowDown') return;
                  event.preventDefault();
                  setShowProviderActions(true);
                  focusFirstProviderAction();
                }}
                aria-label="Provider actions"
                aria-haspopup="menu"
                aria-expanded={showProviderActions()}
                aria-busy={isReloading()}
              >
                <UiIcon
                  source={menuIcon}
                  class="models-provider-actions-icon"
                  width={16}
                  height={16}
                />
              </button>
            </Tooltip>
            <Show when={showProviderActions()}>
              <div
                ref={(element) => (providerActionsMenuRef = element)}
                class="models-provider-actions-menu"
                role="menu"
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={handleProviderActionsKeyDown}
              >
                <button
                  type="button"
                  class="models-context-menu-item"
                  role="menuitem"
                  onClick={(event) => {
                    setShowProviderActions(false);
                    if (event.altKey) openProviderSetup();
                    else void openProviderConnection();
                  }}
                >
                  Add provider
                </button>
                <button
                  type="button"
                  class="models-context-menu-item"
                  role="menuitem"
                  onClick={(event) => {
                    setShowProviderActions(false);
                    if (event.altKey) openProviderLogout();
                    else void openProviderDisconnection();
                  }}
                >
                  Remove provider
                </button>
                <button
                  type="button"
                  class="models-context-menu-item"
                  role="menuitem"
                  disabled={isReloading()}
                  onClick={() => {
                    setShowProviderActions(false);
                    reloadProviders();
                  }}
                >
                  {isReloading() ? 'Refreshing list' : 'Refresh list'}
                </button>
              </div>
            </Show>
          </div>
        </div>
      </div>

      <Show when={state.providerRefreshPending && runningAgentCount() > 0}>
        <div class="models-provider-refresh-notice" role="status">
          <UiIcon source={warningCircleIcon} width={14} height={14} aria-hidden="true" />
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
        <div class="models-toolbar">
          <div class="models-toolbar-inner flex flex-wrap items-center gap-2">
            <Show when={state.workspaceStatuses.length > 0}>
              <div class="text-[11px] text-vscode-muted">Workspaces: {workspaceStatusText()}</div>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={state.providers.length > 0}>
        <div class="models-toolbar">
          <div class="models-toolbar-inner">
            <div class="models-search">
              <input
                type="text"
                class="models-search-input"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                placeholder="Filter providers or models"
                aria-label="Filter providers or models"
                spellcheck={false}
              />
              <Show when={query().length > 0}>
                <Tooltip content="Clear filter">
                  <button
                    type="button"
                    class="models-search-clear"
                    onClick={() => setQuery('')}
                    aria-label="Clear filter"
                  >
                    <UiIcon source={xmarkIcon} width={12} height={12} />
                  </button>
                </Tooltip>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <div class="models-body" ref={(el) => (bodyRef = el)}>
        <div class="models-body-inner">
          <Show
            when={state.providers.length > 0}
            fallback={<div class="models-empty">No providers configured</div>}
          >
            <Show
              when={filteredProviders().length > 0}
              fallback={<div class="models-empty">No matching models</div>}
            >
              <For each={filteredProviders()}>
                {({ provider, models }) => (
                  <ProviderSection
                    provider={provider}
                    models={models}
                    maxCapabilityCount={maxCapabilityCount()}
                    reconnectRequired={providerRequiresReconnection(provider.id)}
                    forceExpanded={normalizedQuery().length > 0}
                    routing={routing()}
                    previousRouting={state.providerRefreshPending ? previousRouting() : null}
                    onOpenContextMenu={(next) => setContextMenu(next)}
                    onOpenModelCatalog={() => setModelCatalogProvider(provider)}
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
              ref={(element) => positionContextMenu(element, menu.x, menu.y)}
              class="models-context-menu"
              style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                class="models-context-menu-item"
                onClick={() => {
                  setModelPinned(
                    menu.providerID,
                    menu.modelID,
                    !isModelPinned(menu.providerID, menu.modelID)
                  );
                  closeContextMenu();
                }}
              >
                {isModelPinned(menu.providerID, menu.modelID) ? 'Unpin' : 'Pin'} model
              </button>
              <button
                type="button"
                class="models-context-menu-item"
                onClick={() => renameModel(menu.providerID, menu.modelID)}
              >
                Rename model
              </button>
              <Show when={state.modelDisplayNames[`${menu.providerID}:${menu.modelID}`]}>
                <button
                  type="button"
                  class="models-context-menu-item"
                  onClick={() => {
                    setModelDisplayName(menu.providerID, menu.modelID, '');
                    closeContextMenu();
                  }}
                >
                  Reset model name
                </button>
              </Show>
              <button
                type="button"
                class="models-context-menu-item"
                onClick={() => hideModel(menu.providerID, menu.modelID)}
              >
                Hide model
              </button>
              <div class="models-context-menu-separator" role="separator" />
              <button
                type="button"
                class="models-context-menu-item"
                disabled={isSaving()}
                onClick={() =>
                  void saveRouting({
                    target: 'small_model',
                    providerID: menu.providerID,
                    modelID: menu.modelID,
                    unset: isModelRoute(routing().smallModel, menu.providerID, menu.modelID)
                      ? true
                      : undefined,
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
                class="models-context-menu-item"
                disabled={isSaving()}
                onClick={() =>
                  void saveRouting({
                    target: 'commit_message',
                    providerID: menu.providerID,
                    modelID: menu.modelID,
                    unset: isModelRoute(routing().commitMessageModel, menu.providerID, menu.modelID)
                      ? true
                      : undefined,
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
                class="models-context-menu-item"
                disabled={isSaving()}
                onClick={() =>
                  void saveRouting({
                    target: 'auto_approve',
                    providerID: menu.providerID,
                    modelID: menu.modelID,
                    unset: isModelRoute(routing().autoApproveModel, menu.providerID, menu.modelID)
                      ? true
                      : undefined,
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
                      class="models-context-menu-item"
                      disabled={isSaving()}
                      onClick={() =>
                        void saveRouting({
                          target: 'agent',
                          agentName: agent.name,
                          providerID: menu.providerID,
                          modelID: menu.modelID,
                          unset: isAssigned() ? true : undefined,
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
      <Show when={renameDialog()}>
        {(rename) => (
          <Portal>
            <div
              class="provider-connect-overlay"
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                setRenameDialog(null);
              }}
            >
              <form
                class="provider-connect-dialog models-model-rename-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="models-model-rename-title"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveModelName();
                }}
              >
                <div class="provider-connect-header">
                  <div>
                    <div id="models-model-rename-title" class="provider-connect-title">
                      Rename model
                    </div>
                    <div class="provider-connect-subtitle">{rename().originalName}</div>
                  </div>
                  <button
                    type="button"
                    class="provider-connect-close"
                    onClick={() => setRenameDialog(null)}
                    aria-label="Close"
                  >
                    <UiIcon source={xmarkIcon} width={16} height={16} aria-hidden="true" />
                  </button>
                </div>
                <div class="provider-connect-body">
                  <div class="provider-connect-form">
                    <label class="provider-connect-field">
                      Display name
                      <input
                        ref={(element) => {
                          renameInputRef = element;
                          queueMicrotask(() => element.select());
                        }}
                        class="provider-connect-input"
                        value={rename().displayName}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter') return;
                          event.preventDefault();
                          saveModelName();
                        }}
                        aria-label="Model display name"
                        autocomplete="off"
                      />
                    </label>
                    <div class="models-model-rename-hint">
                      Leave blank to restore the original model name.
                    </div>
                    <div class="provider-connect-actions">
                      <button
                        type="button"
                        class="provider-connect-secondary"
                        onClick={() => setRenameDialog(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        class="provider-connect-primary"
                        onClick={saveModelName}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                </div>
              </form>
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
      <Show when={modelCatalogProvider()} keyed>
        {(provider) => (
          <ModelCatalogDialog provider={provider} onClose={() => setModelCatalogProvider(null)} />
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

function ModelCatalogDialog(props: { provider: ModelProvider; onClose: () => void }) {
  const [query, setQuery] = createSignal('');
  const [catalogProvider, setCatalogProvider] = createSignal<ModelProvider>(props.provider);
  const [isLoading, setIsLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal('');
  const allModels = createMemo(() => sortProviderModels(Object.values(catalogProvider().models)));
  const initialModelIDs = new Set(getListedProviderModels(props.provider).map((model) => model.id));
  const [selectedModelIDs, setSelectedModelIDs] = createSignal(new Set(initialModelIDs));
  const normalizedQuery = createMemo(() => query().trim().toLocaleLowerCase());
  const hasChanges = createMemo(() => {
    const selected = selectedModelIDs();
    return (
      selected.size !== initialModelIDs.size ||
      [...selected].some((modelID) => !initialModelIDs.has(modelID))
    );
  });
  const changeCount = createMemo(() => {
    const selected = selectedModelIDs();
    let count = 0;
    for (const modelID of selected) {
      if (!initialModelIDs.has(modelID)) count += 1;
    }
    for (const modelID of initialModelIDs) {
      if (!selected.has(modelID)) count += 1;
    }
    return count;
  });
  const matchingModels = createMemo(() => {
    const search = normalizedQuery();
    let models: ProviderModel[];
    if (!search) {
      models = !isLargeModelCatalog(catalogProvider())
        ? allModels()
        : allModels().filter(
            (model) => initialModelIDs.has(model.id) || selectedModelIDs().has(model.id)
          );
    } else {
      models = allModels().filter((model) =>
        [model.name, model.id].some((value) => value.toLocaleLowerCase().includes(search))
      );
    }

    const selected = selectedModelIDs();
    return models.toSorted((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)));
  });
  const visibleModels = createMemo(() => matchingModels().slice(0, MODEL_CATALOG_RESULT_LIMIT));
  let searchInputRef: HTMLInputElement | undefined;

  onMount(() => {
    let active = true;
    void (async () => {
      try {
        const result = await client.config.providers();
        if (!active) return;
        const refreshedProvider = result.providers.find(
          (provider) => provider.id === props.provider.id
        );
        if (!refreshedProvider) {
          throw new Error(`${props.provider.name} is no longer available`);
        }
        setCatalogProvider(refreshedProvider);
        setState(
          'providers',
          state.providers.map((provider) =>
            provider.id === refreshedProvider.id ? refreshedProvider : provider
          )
        );
        setState('providerDefaults', { ...state.providerDefaults, ...result.default });
      } catch (error) {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      }
      if (!active) return;
      setIsLoading(false);
      queueMicrotask(() => searchInputRef?.focus());
    })();
    onCleanup(() => {
      active = false;
    });
  });

  function toggleModel(modelID: string, selected: boolean) {
    setSelectedModelIDs((current) => {
      const next = new Set(current);
      if (selected) next.add(modelID);
      else next.delete(modelID);
      return next;
    });
  }

  function saveChanges() {
    if (!hasChanges()) return;
    setModelsAdded(props.provider.id, [...selectedModelIDs()]);
    props.onClose();
  }

  return (
    <Portal>
      <div
        class="provider-connect-overlay"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          props.onClose();
        }}
      >
        <div
          class="provider-connect-dialog models-model-catalog-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="models-model-catalog-title"
        >
          <div class="provider-connect-header">
            <div>
              <div id="models-model-catalog-title" class="provider-connect-title">
                Manage {props.provider.name} models
              </div>
              <div class="provider-connect-subtitle">
                {isLoading()
                  ? 'Refreshing available models...'
                  : `Search ${allModels().length} available models. Added models appear in model pickers.`}
              </div>
            </div>
            <button
              type="button"
              class="provider-connect-close"
              onClick={props.onClose}
              aria-label="Close"
            >
              <UiIcon source={xmarkIcon} width={16} height={16} aria-hidden="true" />
            </button>
          </div>
          <div class="models-model-catalog-search">
            <input
              ref={(element) => (searchInputRef = element)}
              type="text"
              class="models-search-input"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search models by name or ID"
              aria-label={`Search ${props.provider.name} models`}
              autocomplete="off"
              spellcheck={false}
              disabled={isLoading()}
            />
          </div>
          <div class="provider-connect-body models-model-catalog-body">
            <Show
              when={!isLoading()}
              fallback={
                <div class="models-model-catalog-loading" role="status">
                  Refreshing model catalog...
                </div>
              }
            >
              <Show when={loadError()}>
                {(message) => (
                  <div class="provider-connect-error models-model-catalog-error" role="alert">
                    Could not refresh the catalog: {message()}. Showing cached models.
                  </div>
                )}
              </Show>
              <Show
                when={visibleModels().length > 0}
                fallback={
                  <div class="provider-connect-empty models-model-catalog-empty">
                    {normalizedQuery() ? 'No matching models' : 'Search the catalog to add models.'}
                  </div>
                }
              >
                <div class="models-model-catalog-list">
                  <For each={visibleModels()}>
                    {(model) => (
                      <label class="models-model-catalog-row">
                        <input
                          type="checkbox"
                          class="models-checkbox"
                          checked={selectedModelIDs().has(model.id)}
                          onChange={(event) => toggleModel(model.id, event.currentTarget.checked)}
                        />
                        <span class="models-model-catalog-name">
                          <FormattedModelName name={model.name} />
                          <span class="models-model-catalog-id">({model.id})</span>
                        </span>
                      </label>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
          <div class="models-model-catalog-footer">
            <span class="models-model-catalog-status">
              {hasChanges()
                ? `${changeCount()} unsaved ${changeCount() === 1 ? 'change' : 'changes'}`
                : matchingModels().length > MODEL_CATALOG_RESULT_LIMIT
                  ? `Showing ${MODEL_CATALOG_RESULT_LIMIT} of ${matchingModels().length} matches`
                  : `${selectedModelIDs().size} ${selectedModelIDs().size === 1 ? 'model' : 'models'} selected`}
            </span>
            <div class="provider-connect-actions models-model-catalog-actions">
              <button type="button" class="provider-connect-secondary" onClick={props.onClose}>
                Cancel
              </button>
              <button
                type="button"
                class="provider-connect-primary"
                disabled={isLoading() || !hasChanges()}
                onClick={saveChanges}
              >
                Save changes
              </button>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function ProviderSection(props: {
  provider: ModelProvider;
  models: ProviderModel[];
  maxCapabilityCount: number;
  reconnectRequired: boolean;
  forceExpanded: boolean;
  routing: OpenCodeModelRouting;
  previousRouting: OpenCodeModelRouting | null;
  onOpenContextMenu: (menu: ModelContextMenuState) => void;
  onOpenModelCatalog: () => void;
}) {
  const enabledCount = () =>
    props.models.filter((m) => isModelVisible(props.provider.id, m.id)).length;

  const [expanded, setExpanded] = createSignal(enabledCount() > 0);

  const allEnabled = () => props.models.length > 0 && enabledCount() === props.models.length;
  const someEnabled = () => enabledCount() > 0 && !allEnabled();
  const isFullProviderView = () => !isLargeModelCatalog(props.provider);
  const isExpanded = () => props.forceExpanded || props.reconnectRequired || expanded();
  function toggleProvider() {
    const visible = !allEnabled();

    if (isFullProviderView()) {
      setProviderVisible(props.provider.id, visible);
    }
    setModelsVisible(
      props.provider.id,
      props.models.map((model) => model.id),
      visible
    );
  }

  return (
    <div class="models-provider">
      <div class="models-provider-header">
        <button
          class="models-provider-toggle"
          onClick={() => !props.forceExpanded && setExpanded((v) => !v)}
        >
          <UiIcon
            source={navArrowRightIcon}
            class={`models-chevron ${isExpanded() ? 'expanded' : ''}`}
            width={12}
            height={12}
          />
          <span class="models-provider-name">{props.provider.name}</span>
          <span class="models-provider-count">
            {props.reconnectRequired
              ? 'Reconnect'
              : isLargeModelCatalog(props.provider)
                ? `${props.models.length} added`
                : `${enabledCount()}/${props.models.length}`}
          </span>
        </button>
        <Show when={!props.reconnectRequired}>
          <Show
            when={isLargeModelCatalog(props.provider) || hasManagedModelCatalog(props.provider.id)}
          >
            <button
              type="button"
              class="models-provider-models-button"
              onClick={props.onOpenModelCatalog}
            >
              Add models
            </button>
          </Show>
          <Show when={props.models.length > 0}>
            <ProviderCheckbox
              checked={allEnabled()}
              indeterminate={someEnabled()}
              onChange={toggleProvider}
            />
          </Show>
        </Show>
      </div>

      <Show when={isExpanded()}>
        <Show
          when={!props.reconnectRequired}
          fallback={
            <div class="models-provider-auth-required">
              <span>Authentication is required to load available models.</span>
              <button type="button" onClick={() => requestProviderConnection(props.provider.id)}>
                Re-authenticate
              </button>
            </div>
          }
        >
          <div
            class="models-model-list"
            style={{ '--models-capability-count': props.maxCapabilityCount }}
          >
            <For each={props.models}>
              {(model) => {
                const supportsTools = () =>
                  modelSupportsTools(props.provider.id, model.id, state.providers);
                const supportsVariants = () =>
                  modelSupportsVariants(props.provider.id, model.id, state.providers);
                const supportsVision = () =>
                  modelSupportsVision(props.provider.id, model.id, state.providers);
                const supportsPdf = () =>
                  modelSupportsPdf(props.provider.id, model.id, state.providers);
                const supportsAudio = () =>
                  modelSupportsAudio(props.provider.id, model.id, state.providers);
                const supportsVideo = () =>
                  modelSupportsVideo(props.provider.id, model.id, state.providers);
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
                    class="models-model-row"
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
                      class="models-checkbox"
                      checked={isModelVisible(props.provider.id, model.id)}
                      onChange={(e) =>
                        setModelVisible(props.provider.id, model.id, e.currentTarget.checked)
                      }
                    />
                    <span class="models-model-name-wrap">
                      <span class="models-model-name">
                        <FormattedModelName
                          name={getModelDisplayName(props.provider.id, model.id, model.name)}
                        />
                      </span>
                      <Show when={state.modelDisplayNames[`${props.provider.id}:${model.id}`]}>
                        <Tooltip content={`Original name: ${model.name}`}>
                          <span
                            class="models-model-renamed-marker"
                            aria-label={`Renamed model. Original name: ${model.name}`}
                          >
                            renamed
                          </span>
                        </Tooltip>
                      </Show>
                      <Show when={isModelPinned(props.provider.id, model.id)}>
                        <Tooltip content="Pinned model">
                          <span class="models-model-pinned-marker" aria-label="Pinned model">
                            <UiIcon source={pinIcon} width={12} height={12} aria-hidden="true" />
                          </span>
                        </Tooltip>
                      </Show>
                      <Show when={routeTags().length > 0}>
                        <span class="models-model-routes">
                          <For each={routeTags()}>{(tag) => <ModelRouteBadge tag={tag} />}</For>
                        </span>
                      </Show>
                      <Show when={state.providerDefaults[props.provider.id] === model.id}>
                        <span class="model-default-label">(default)</span>
                      </Show>
                    </span>
                    <span class="models-model-meta">
                      <span class="models-model-date-cell">
                        <Show when={releaseDate()}>
                          {(date) => (
                            <Tooltip content={`Released ${date()}`}>
                              <span class="model-release-date" aria-label={`Released ${date()}`}>
                                <UiIcon
                                  source={calendarIcon}
                                  width={13}
                                  height={13}
                                  aria-hidden="true"
                                />
                                {date()}
                              </span>
                            </Tooltip>
                          )}
                        </Show>
                      </span>
                      <span class="models-model-badges">
                        <Show when={supportsTools()}>
                          <ModelCapabilityBadge capability="tools" label="Tools" />
                        </Show>
                        <Show when={supportsVariants()}>
                          <ModelCapabilityBadge
                            capability="variants"
                            label="Variants / reasoning"
                          />
                        </Show>
                        <Show when={supportsVision()}>
                          <ModelCapabilityBadge capability="vision" label="Vision" />
                        </Show>
                        <Show when={supportsPdf()}>
                          <ModelCapabilityBadge capability="pdf" label="PDF" />
                        </Show>
                        <Show when={supportsAudio()}>
                          <ModelCapabilityBadge capability="audio" label="Audio" />
                        </Show>
                        <Show when={supportsVideo()}>
                          <ModelCapabilityBadge capability="video" label="Video" />
                        </Show>
                      </span>
                      <span class="models-model-ctx">
                        <Show when={model.limit?.context}>
                          {formatContextLimit(model.limit!.context)}
                        </Show>
                      </span>
                    </span>
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

type ModelCapability = 'tools' | 'variants' | 'vision' | 'pdf' | 'audio' | 'video';

function ModelCapabilityBadge(props: { capability: ModelCapability; label: string }) {
  return (
    <Tooltip content={props.label}>
      <span
        class={`model-capability-tag model-capability-tag-${props.capability}`}
        aria-label={props.label}
      >
        <span class="models-capability-icon" aria-hidden="true">
          <CapabilityIcon capability={props.capability} />
        </span>
        <span class="models-capability-label">
          {props.capability === 'variants' ? 'Variants' : props.label}
        </span>
      </span>
    </Tooltip>
  );
}

function CapabilityIcon(props: { capability: ModelCapability }) {
  return (
    <Show
      when={props.capability === 'pdf'}
      fallback={
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <Show when={props.capability === 'vision'}>
            <path d="M21 3.6V20.4C21 20.7314 20.7314 21 20.4 21H3.6C3.26863 21 3 20.7314 3 20.4V3.6C3 3.26863 3.26863 3 3.6 3H20.4C20.7314 3 21 3.26863 21 3.6Z" />
            <path d="M3 16L10 13L21 18" />
            <path d="M16 10C14.8954 10 14 9.10457 14 8C14 6.89543 14.8954 6 16 6C17.1046 6 18 6.89543 18 8C18 9.10457 17.1046 10 16 10Z" />
          </Show>
          <Show when={props.capability === 'video'}>
            <path d="M21 3.6V20.4C21 20.7314 20.7314 21 20.4 21H3.6C3.26863 21 3 20.7314 3 20.4V3.6C3 3.26863 3.26863 3 3.6 3H20.4C20.7314 3 21 3.26863 21 3.6Z" />
            <path d="M9.89768 8.51296C9.49769 8.28439 9 8.57321 9 9.03391V14.9661C9 15.4268 9.49769 15.7156 9.89768 15.487L15.0883 12.5209C15.4914 12.2906 15.4914 11.7094 15.0883 11.4791L9.89768 8.51296Z" />
          </Show>
          <Show when={props.capability === 'tools'}>
            <path d="M10.0503 10.6066L2.97923 17.6777C2.19818 18.4587 2.19818 19.7251 2.97923 20.5061C3.76027 21.2872 5.0266 21.2872 5.80765 20.5061L12.8787 13.4351" />
            <path d="M17.1927 13.7994L21.071 17.6777C21.8521 18.4587 21.8521 19.7251 21.071 20.5061C20.29 21.2872 19.0236 21.2872 18.2426 20.5061L12.0341 14.2977" />
            <path d="M6.73267 5.90381L4.61135 6.61092L2.49003 3.07539L3.90424 1.66117L7.43978 3.78249L6.73267 5.90381ZM6.73267 5.90381L9.5629 8.73404" />
            <path d="M10.0503 10.6066C9.2065 8.45359 9.37147 5.62861 11.111 3.8891C12.8505 2.14958 16.0607 1.76778 17.8285 2.82844L14.7878 5.86911L14.5052 8.98015L17.6162 8.69754L20.6569 5.65686C21.7176 7.42463 21.3358 10.6349 19.5963 12.3744C17.8567 14.1139 15.0318 14.2789 12.8788 13.435" />
          </Show>
          <Show when={props.capability === 'variants'}>
            <path d="M7 14C5.34315 14 4 15.3431 4 17C4 18.6569 5.34315 20 7 20C7.35064 20 7.68722 19.9398 8 19.8293" />
            <path d="M4.26392 15.6046C2.9243 14.9582 2 13.587 2 12C2 10.7883 2.53873 9.70251 3.38974 8.96898" />
            <path d="M3.42053 8.8882C3.1549 8.49109 3 8.01363 3 7.5C3 6.11929 4.11929 5 5.5 5C6.06291 5 6.58237 5.18604 7.00024 5.5" />
            <path d="M7.23769 5.56533C7.08524 5.24215 7 4.88103 7 4.5C7 3.11929 8.11929 2 9.5 2C10.8807 2 12 3.11929 12 4.5V20M8 20C8 21.1046 8.89543 22 10 22C11.1046 22 12 21.1046 12 20M12 7C12 8.65685 13.3431 10 15 10" />
            <path d="M17 14C18.6569 14 20 15.3431 20 17C20 18.6569 18.6569 20 17 20C16.6494 20 16.3128 19.9398 16 19.8293" />
            <path d="M19.7361 15.6046C21.0757 14.9582 22 13.587 22 12C22 10.7883 21.4612 9.70251 20.6102 8.96898" />
            <path d="M20.5795 8.8882C20.8451 8.49109 21 8.01363 21 7.5C21 6.11929 19.8807 5 18.5 5C17.9371 5 17.4176 5.18604 16.9998 5.5" />
            <path d="M12 4.5C12 3.11929 13.1193 2 14.5 2C15.8807 2 17 3.11929 17 4.5C17 4.88103 16.9148 5.24215 16.7623 5.56533M16 20C16 21.1046 15.1046 22 14 22C12.8954 22 12 21.1046 12 20" />
          </Show>
          <Show when={props.capability === 'audio'}>
            <path d="M12 3C10.3431 3 9 4.34315 9 6V12C9 13.6569 10.3431 15 12 15C13.6569 15 15 13.6569 15 12V6C15 4.34315 13.6569 3 12 3Z" />
            <path d="M5 11V12C5 15.866 8.13401 19 12 19C15.866 19 19 15.866 19 12V11M12 19V22M9 22H15" />
          </Show>
        </svg>
      }
    >
      <svg viewBox="0 0 24 24" fill="none">
        <g transform="translate(1.5 1.5) scale(1.4)">
          <path
            d="M2.5 6.5V6H2V6.5H2.5ZM6.5 6.5V6H6V6.5H6.5ZM6.5 10.5H6V11H6.5V10.5ZM13.5 3.5H14V3.29289L13.8536 3.14645L13.5 3.5ZM10.5 0.5L10.8536 0.146447L10.7071 0H10.5V0.5ZM2.5 7H3.5V6H2.5V7ZM3 11V8.5H2V11H3ZM3 8.5V6.5H2V8.5H3ZM3.5 8H2.5V9H3.5V8ZM4 7.5C4 7.77614 3.77614 8 3.5 8V9C4.32843 9 5 8.32843 5 7.5H4ZM3.5 7C3.77614 7 4 7.22386 4 7.5H5C5 6.67157 4.32843 6 3.5 6V7ZM6 6.5V10.5H7V6.5H6ZM6.5 11H7.5V10H6.5V11ZM9 9.5V7.5H8V9.5H9ZM7.5 6H6.5V7H7.5V6ZM9 7.5C9 6.67157 8.32843 6 7.5 6V7C7.77614 7 8 7.22386 8 7.5H9ZM7.5 11C8.32843 11 9 10.3284 9 9.5H8C8 9.77614 7.77614 10 7.5 10V11ZM10 6V11H11V6H10ZM10.5 7H13V6H10.5V7ZM10.5 9H12V8H10.5V9ZM2 5V1.5H1V5H2ZM13 3.5V5H14V3.5H13ZM2.5 1H10.5V0H2.5V1ZM10.1464 0.853553L13.1464 3.85355L13.8536 3.14645L10.8536 0.146447L10.1464 0.853553ZM2 1.5C2 1.22386 2.22386 1 2.5 1V0C1.67157 0 1 0.671573 1 1.5H2ZM1 12V13.5H2V12H1ZM2.5 15H12.5V14H2.5V15ZM14 13.5V12H13V13.5H14ZM12.5 15C13.3284 15 14 14.3284 14 13.5H13C13 13.7761 12.7761 14 12.5 14V15ZM1 13.5C1 14.3284 1.67157 15 2.5 15V14C2.22386 14 2 13.7761 2 13.5H1Z"
            fill="currentColor"
            stroke="none"
          />
        </g>
      </svg>
    </Show>
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
    <Tooltip content={props.tag.label}>
      <span
        class={`model-capability-tag models-route-tag models-route-tag-${props.tag.kind}${
          props.tag.change ? ` models-route-tag-${props.tag.change}` : ''
        }`}
        aria-label={props.tag.label}
      >
        {props.tag.text}
        <Show when={props.tag.change !== 'removed' ? props.tag.change : undefined}>
          {(change) => <span class="models-route-tag-change">{change()}</span>}
        </Show>
      </span>
    </Tooltip>
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

function normalizeModelRouting<T>(value: T): OpenCodeModelRouting {
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

function parseModelRoute<T>(value: T): OpenCodeModelRouting['smallModel'] {
  if (isString(value)) {
    const separatorIndex = value.indexOf('/');
    if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null;
    return {
      providerID: value.slice(0, separatorIndex),
      modelID: value.slice(separatorIndex + 1),
    };
  }

  const record = asRecord(value);
  if (!record) return null;

  const providerID = isString(record.providerID) ? record.providerID.trim() : '';
  const modelID = isString(record.modelID) ? record.modelID.trim() : '';

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
    <label class="models-checkbox-label">
      <input
        ref={ref}
        type="checkbox"
        class="models-checkbox"
        checked={props.checked}
        onChange={props.onChange}
      />
    </label>
  );
}
