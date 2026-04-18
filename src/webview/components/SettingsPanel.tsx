import { For, Show, createSignal, createEffect } from 'solid-js';
import {
  isModelVisible,
  isProviderVisible,
  resetModelVisibility,
  setModelVisible,
  setProviderVisible,
  setShowSettings,
  state,
} from '../lib/state';

export function SettingsPanel() {
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
        <button class="settings-reset-btn" onClick={resetModelVisibility} title="Reset all">
          Reset
        </button>
      </div>

      <div class="settings-body">
        <Show
          when={state.providers.length > 0}
          fallback={<div class="settings-empty">No providers configured</div>}
        >
          <For each={state.providers}>{(provider) => <ProviderSection provider={provider} />}</For>
        </Show>
      </div>
    </div>
  );
}

function ProviderSection(props: { provider: (typeof state.providers)[0] }) {
  const [expanded, setExpanded] = createSignal(true);

  const models = () =>
    Object.values(props.provider.models).sort((a, b) => a.name.localeCompare(b.name));

  const enabledCount = () => models().filter((m) => isModelVisible(props.provider.id, m.id)).length;

  const allEnabled = () =>
    isProviderVisible(props.provider.id) && enabledCount() === models().length;
  const someEnabled = () =>
    isProviderVisible(props.provider.id) && enabledCount() > 0 && !allEnabled();

  function toggleProvider() {
    if (allEnabled()) {
      setProviderVisible(props.provider.id, false);
    } else {
      setProviderVisible(props.provider.id, true);
      for (const model of models()) {
        setModelVisible(props.provider.id, model.id, true);
      }
    }
  }

  return (
    <div class="settings-provider">
      <div class="settings-provider-header">
        <button class="settings-provider-toggle" onClick={() => setExpanded((v) => !v)}>
          <svg
            class={`settings-chevron ${expanded() ? 'expanded' : ''}`}
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M6 4l4 4-4 4z" />
          </svg>
          <span class="settings-provider-name">{props.provider.name}</span>
          <span class="settings-provider-count">
            {enabledCount()}/{models().length}
          </span>
        </button>
        <ProviderCheckbox
          checked={allEnabled()}
          indeterminate={someEnabled()}
          onChange={toggleProvider}
        />
      </div>

      <Show when={expanded()}>
        <div class="settings-model-list">
          <For each={models()}>
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

function formatContextLimit(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
