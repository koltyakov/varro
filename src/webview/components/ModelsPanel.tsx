import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import {
  isModelVisible,
  setModelVisible,
  setProviderVisible,
  setState,
  setShowSettings,
  state,
} from '../lib/state';
import { formatContextLimit } from '../lib/format';
import {
  modelSupportsTools,
  modelSupportsVariants,
  modelSupportsVision,
} from '../lib/model-capabilities';
import { openProviderSetup } from '../lib/provider-setup';
import { client } from '../lib/client';
import { refreshRoutingState } from '../hooks/useOpenCode';
import type { OpenCodeModelRouting } from '../types';

type SettingsProvider = (typeof state.providers)[number];
type SettingsModel = SettingsProvider['models'][string];
type ModelContextMenuState = {
  x: number;
  y: number;
  providerID: string;
  modelID: string;
};

export function ModelsPanel() {
  const [query, setQuery] = createSignal('');
  const [routing, setRouting] = createSignal<OpenCodeModelRouting>(createEmptyRouting());
  const [contextMenu, setContextMenu] = createSignal<ModelContextMenuState | null>(null);
  const [isSaving, setIsSaving] = createSignal(false);
  let bodyRef: HTMLDivElement | undefined;

  const workspaceStatusText = createMemo(() =>
    state.workspaceStatuses.map((entry) => `${entry.workspaceID} (${entry.status})`).join(', ')
  );

  const routableAgents = () => state.allAgents.filter((agent) => agent.mode === 'subagent');

  const normalizedQuery = createMemo(() => query().trim().toLocaleLowerCase());

  const filteredProviders = createMemo(() => {
    const search = normalizedQuery();

    return state.providers
      .map((provider) => {
        const models = Object.values(provider.models).toSorted((a, b) =>
          a.name.localeCompare(b.name)
        );

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

  async function loadCompatibilityState() {
    try {
      setState('providerAuthMethods', await client.config.providerAuth());
    } catch {
      setState('providerAuthMethods', {});
    }

    try {
      setState('workspaceStatuses', await client.config.workspaceStatus());
    } catch {
      setState('workspaceStatuses', []);
    }
  }

  async function saveRouting(body: {
    target: 'small_model' | 'agent';
    providerID: string;
    modelID: string;
    agentName?: string;
  }) {
    setIsSaving(true);
    try {
      const nextRouting = normalizeModelRouting(await client.varro.saveModelRouting(body));
      setRouting(nextRouting);
      await refreshRoutingState();
    } finally {
      setIsSaving(false);
      setContextMenu(null);
    }
  }

  function closeContextMenu() {
    setContextMenu(null);
  }

  onMount(() => {
    updateScrollbarInset();
    void loadRouting();
    void loadCompatibilityState();
    if (!bodyRef) return;
    const observer = new ResizeObserver(() => updateScrollbarInset());
    observer.observe(bodyRef);
    onCleanup(() => observer.disconnect());
  });

  onMount(() => {
    const onPointerDown = () => closeContextMenu();
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeContextMenu();
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
          <button
            type="button"
            class="chat-header-btn"
            onClick={openProviderSetup}
            title="Add provider"
            aria-label="Add provider"
          >
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 2.25a.75.75 0 01.75.75v4.25H13a.75.75 0 010 1.5H8.75V13a.75.75 0 01-1.5 0V8.75H3a.75.75 0 010-1.5h4.25V3A.75.75 0 018 2.25z" />
            </svg>
          </button>
        </div>
      </div>

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
                    forceExpanded={normalizedQuery().length > 0}
                    routing={routing()}
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
                  })
                }
              >
                Use for small_model
              </button>
              <For each={routableAgents()}>
                {(agent) => (
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
                      })
                    }
                  >
                    Use for agent: {agent.name}
                  </button>
                )}
              </For>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  );
}

function ProviderSection(props: {
  provider: SettingsProvider;
  models: SettingsModel[];
  forceExpanded: boolean;
  routing: OpenCodeModelRouting;
  onOpenContextMenu: (menu: ModelContextMenuState) => void;
}) {
  const [expanded, setExpanded] = createSignal(true);

  const allModels = () =>
    Object.values(props.provider.models).sort((a, b) => a.name.localeCompare(b.name));

  const enabledCount = () =>
    props.models.filter((m) => isModelVisible(props.provider.id, m.id)).length;

  const allEnabled = () => props.models.length > 0 && enabledCount() === props.models.length;
  const someEnabled = () => enabledCount() > 0 && !allEnabled();
  const isFullProviderView = () => props.models.length === allModels().length;
  const isExpanded = () => props.forceExpanded || expanded();

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
            {enabledCount()}/{props.models.length}
          </span>
        </button>
        <ProviderCheckbox
          checked={allEnabled()}
          indeterminate={someEnabled()}
          onChange={toggleProvider}
        />
      </div>

      <Show when={isExpanded()}>
        <div class="settings-model-list">
          <For each={props.models}>
            {(model) => {
              const supportsTools = () =>
                modelSupportsTools(props.provider.id, model.id, state.providers);
              const supportsVariants = () =>
                modelSupportsVariants(props.provider.id, model.id, state.providers);
              const supportsVision = () =>
                modelSupportsVision(props.provider.id, model.id, state.providers);
              const routeTags = () => getModelRouteTags(props.routing, props.provider.id, model.id);

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
                  <span class="settings-model-name">{model.name}</span>
                  <Show
                    when={
                      supportsTools() ||
                      supportsVariants() ||
                      supportsVision() ||
                      model.limit?.context ||
                      routeTags().length > 0
                    }
                  >
                    <span class="settings-model-meta">
                      <For each={routeTags()}>
                        {(tag) => (
                          <span class="model-capability-tag settings-route-tag">{tag}</span>
                        )}
                      </For>
                      <Show when={supportsTools()}>
                        <span class="model-capability-tag model-capability-tag-tools">Tools</span>
                      </Show>
                      <Show when={supportsVariants()}>
                        <span class="model-capability-tag model-capability-tag-variants">
                          Variants
                        </span>
                      </Show>
                      <Show when={supportsVision()}>
                        <span class="model-capability-tag model-capability-tag-vision">Vision</span>
                      </Show>
                      <Show when={model.limit?.context}>
                        <span class="settings-model-ctx">
                          {formatContextLimit(model.limit!.context)}
                        </span>
                      </Show>
                    </span>
                  </Show>
                </label>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}

function getModelRouteTags(routing: OpenCodeModelRouting, providerID: string, modelID: string) {
  const tags: string[] = [];

  if (routing.smallModel?.providerID === providerID && routing.smallModel.modelID === modelID) {
    tags.push('small_model');
  }

  for (const [agentName, route] of Object.entries(routing.agentModels ?? {})) {
    if (route.providerID === providerID && route.modelID === modelID) {
      tags.push(`agent: ${agentName}`);
    }
  }

  return tags;
}

function createEmptyRouting(): OpenCodeModelRouting {
  return {
    smallModel: null,
    agentModels: {},
  };
}

function normalizeModelRouting(value: unknown): OpenCodeModelRouting {
  const record = asRecord(value);
  if (!record) return createEmptyRouting();

  // preview.html proxies directly to OpenCode, which may expose raw opencode.json keys.
  const smallModel = parseModelRoute(record.smallModel) ?? parseModelRoute(record.small_model);
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

  return { smallModel, agentModels };
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
