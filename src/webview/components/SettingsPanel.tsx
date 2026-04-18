import { For, Show } from 'solid-js';
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
    <div class="absolute inset-0 z-50 flex flex-col bg-vscode-sidebar animate-fade-in">
      {/* Header */}
      <div class="flex h-[36px] shrink-0 items-center justify-between px-3">
        <div class="flex items-center gap-2">
          <button
            class="flex h-[22px] w-[22px] items-center justify-center rounded text-vscode-muted transition-colors hover:bg-vscode-hover hover:text-vscode-fg"
            onClick={() => setShowSettings(false)}
            title="Back"
          >
            <svg class="h-[14px] w-[14px]" viewBox="0 0 16 16" fill="currentColor">
              <path d="M5.7 8l4.65-4.65a.5.5 0 00-.7-.7l-5 5a.5.5 0 000 .7l5 5a.5.5 0 00.7-.7L5.7 8z" />
            </svg>
          </button>
          <span class="text-[12px] font-medium text-vscode-fg">Model Visibility</span>
        </div>
        <button
          class="rounded px-2 py-0.5 text-[11px] text-vscode-muted transition-colors hover:bg-vscode-hover hover:text-vscode-fg"
          onClick={resetModelVisibility}
          title="Reset all visibility"
        >
          Reset
        </button>
      </div>

      {/* Provider list */}
      <div class="min-h-0 flex-1 overflow-y-auto border-t border-vscode-border/20">
        <Show
          when={state.providers.length > 0}
          fallback={
            <div class="px-4 py-8 text-center text-[12px] text-vscode-muted">
              No providers configured
            </div>
          }
        >
          <For each={state.providers}>
            {(provider) => {
              const models = () => Object.values(provider.models);

              return (
                <div class="border-b border-vscode-border/15 last:border-b-0">
                  {/* Provider row */}
                  <label class="flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors hover:bg-vscode-hover">
                    <input
                      type="checkbox"
                      checked={isProviderVisible(provider.id)}
                      onChange={(e) => setProviderVisible(provider.id, e.currentTarget.checked)}
                      class="accent-vscode-accent"
                    />
                    <span class="text-[12px] font-medium text-vscode-fg">{provider.name}</span>
                    <span class="text-[11px] text-vscode-muted/50">{models().length}</span>
                  </label>

                  {/* Model rows */}
                  <For each={models()}>
                    {(model) => (
                      <label class="flex cursor-pointer items-center gap-2.5 py-1.5 pl-8 pr-3 transition-colors hover:bg-vscode-hover">
                        <input
                          type="checkbox"
                          checked={isModelVisible(provider.id, model.id)}
                          disabled={!isProviderVisible(provider.id)}
                          onChange={(e) =>
                            setModelVisible(provider.id, model.id, e.currentTarget.checked)
                          }
                          class="accent-vscode-accent"
                        />
                        <span class="min-w-0 flex-1 truncate text-[12px] text-vscode-fg">
                          {model.name}
                        </span>
                        <Show when={model.limit?.context}>
                          <span class="shrink-0 text-[10px] text-vscode-muted/40">
                            {formatContextLimit(model.limit!.context)}
                          </span>
                        </Show>
                      </label>
                    )}
                  </For>
                </div>
              );
            }}
          </For>
        </Show>
      </div>
    </div>
  );
}

function formatContextLimit(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}
