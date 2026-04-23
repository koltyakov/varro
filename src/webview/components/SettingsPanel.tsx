import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import {
  expandThinkingAndCommandsByDefault,
  isModelVisible,
  setModelVisible,
  setExpandThinkingAndCommandsByDefaultPreference,
  setProviderVisible,
  setShowSettings,
  setShowStickyUserPromptPreference,
  showStickyUserPrompt,
  state,
} from '../lib/state';
import { formatContextLimit } from '../lib/format';
import { postMessage } from '../lib/bridge';
import {
  modelSupportsTools,
  modelSupportsVariants,
  modelSupportsVision,
} from '../lib/model-capabilities';
import { openProviderSetup } from '../lib/provider-setup';

type SettingsProvider = (typeof state.providers)[number];
type SettingsModel = SettingsProvider['models'][string];

export function SettingsPanel() {
  const [query, setQuery] = createSignal('');
  let bodyRef: HTMLDivElement | undefined;

  const normalizedQuery = () => query().trim().toLocaleLowerCase();

  const filteredProviders = () => {
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
  };

  function updateScrollbarInset() {
    if (!bodyRef) return;
    const scrollbarInset = Math.max(0, bodyRef.offsetWidth - bodyRef.clientWidth);
    bodyRef.parentElement?.style.setProperty('--settings-scrollbar-inset', `${scrollbarInset}px`);
  }

  onMount(() => {
    updateScrollbarInset();
    if (!bodyRef) return;
    const observer = new ResizeObserver(() => updateScrollbarInset());
    observer.observe(bodyRef);
    onCleanup(() => observer.disconnect());
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
            <span class="settings-header-title">Settings</span>
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
          <div class="settings-section">
            <div class="settings-section-header">
              <span class="settings-section-title">Interface</span>
            </div>
            <label class="settings-option-row">
              <span class="settings-option-copy">
                <span class="settings-option-label">Expand thinking by default</span>
                <span class="settings-option-description">
                  New thinking blocks start expanded. Tool calls stay collapsed.
                </span>
              </span>
              <input
                type="checkbox"
                class="settings-checkbox"
                checked={expandThinkingAndCommandsByDefault()}
                onChange={(e) => {
                  const checked = e.currentTarget.checked;
                  setExpandThinkingAndCommandsByDefaultPreference(checked);
                  postMessage({
                    type: 'config/update',
                    payload: {
                      expandThinkingAndCommandsByDefault: checked,
                      showStickyUserPrompt: showStickyUserPrompt(),
                    },
                  });
                }}
              />
            </label>
            <label class="settings-option-row">
              <span class="settings-option-copy">
                <span class="settings-option-label">Show sticky user prompt</span>
                <span class="settings-option-description">
                  Keep the latest relevant prompt visible while you scroll long responses.
                </span>
              </span>
              <input
                type="checkbox"
                class="settings-checkbox"
                checked={showStickyUserPrompt()}
                onChange={(e) => {
                  const checked = e.currentTarget.checked;
                  setShowStickyUserPromptPreference(checked);
                  postMessage({
                    type: 'config/update',
                    payload: {
                      expandThinkingAndCommandsByDefault: expandThinkingAndCommandsByDefault(),
                      showStickyUserPrompt: checked,
                    },
                  });
                }}
              />
            </label>
          </div>

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
                  />
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}

function ProviderSection(props: {
  provider: SettingsProvider;
  models: SettingsModel[];
  forceExpanded: boolean;
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

              return (
                <label class="settings-model-row">
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
                      model.limit?.context
                    }
                  >
                    <span class="settings-model-meta">
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
