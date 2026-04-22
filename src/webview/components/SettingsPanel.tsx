import { For, Show, createEffect, createSignal } from 'solid-js';
import {
  isModelVisible,
  setModelVisible,
  setProviderVisible,
  setShowSettings,
  state,
} from '../lib/state';
import { formatContextLimit } from '../lib/format';

type SettingsProvider = (typeof state.providers)[number];
type SettingsModel = SettingsProvider['models'][string];

export function SettingsPanel() {
  const [query, setQuery] = createSignal('');

  const normalizedQuery = () => query().trim().toLocaleLowerCase();

  const filteredProviders = () => {
    const search = normalizedQuery();

    return state.providers
      .map((provider) => {
        const models = Object.values(provider.models).toSorted((a, b) => a.name.localeCompare(b.name));

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

  return (
    <div class="settings-panel">
      <div class="settings-header">
        <div class="settings-header-left">
          <button class="chat-header-btn" onClick={() => setShowSettings(false)} title="Back">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M5.928 7.976l4.357-4.357-.618-.62L4.69 7.976l4.977 4.977.618-.618z" />
            </svg>
          </button>
          <span class="settings-header-title">Models</span>
        </div>
      </div>

      <Show when={state.providers.length > 0}>
        <div class="settings-toolbar">
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
      </Show>

      <div class="settings-body">
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

  const enabledCount = () => props.models.filter((m) => isModelVisible(props.provider.id, m.id)).length;

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
            {(model) => (
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
                <Show when={model.limit?.context}>
                  <span class="settings-model-ctx">{formatContextLimit(model.limit!.context)}</span>
                </Show>
              </label>
            )}
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
