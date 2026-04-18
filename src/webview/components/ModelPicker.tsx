import { createMemo, For, Show } from 'solid-js';
import { getVisibleProviders, setShowSettings, state } from '../lib/state';

interface Selection {
  providerID?: string;
  modelID?: string;
  variant?: string;
}

export function ModelPicker(props: { onSelect: (sel: Selection) => void; onClose: () => void }) {
  const visibleProviders = createMemo(() => getVisibleProviders(state.providers));

  const isSelected = (providerID: string, modelID: string, variant?: string) => {
    const sel = state.selectedModel;
    if (!sel) return false;
    if (sel.providerID !== providerID || sel.modelID !== modelID) return false;
    return variant ? sel.variant === variant : !sel.variant;
  };

  return (
    <div class="absolute inset-x-0 bottom-full z-50 mb-1 px-3" onClick={props.onClose}>
      <div
        class="w-full overflow-hidden rounded-lg border border-vscode-border/50 bg-vscode-card shadow-[0_-4px_16px_rgba(0,0,0,0.3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="max-h-[320px] overflow-y-auto py-1">
          <Show
            when={visibleProviders().length > 0}
            fallback={
              <div class="px-3 py-6 text-center text-[11px] text-vscode-muted">
                No models available
              </div>
            }
          >
            <For each={visibleProviders()}>
              {(provider) => (
                <>
                  <div class="px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-vscode-muted/50 first:pt-1">
                    {provider.name}
                  </div>
                  <For each={Object.values(provider.models)}>
                    {(model) => {
                      const variants = () => Object.keys(model.variants || {});
                      const hasVariants = () => variants().length > 0;

                      return (
                        <>
                          {/* Model row — if it has variants, each variant gets its own row */}
                          <Show when={!hasVariants()}>
                            <button
                              class={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-vscode-hover ${
                                isSelected(provider.id, model.id) ? '' : ''
                              }`}
                              onClick={() => {
                                props.onSelect({ providerID: provider.id, modelID: model.id });
                                props.onClose();
                              }}
                            >
                              <Show when={isSelected(provider.id, model.id)}>
                                <svg
                                  class="h-3.5 w-3.5 shrink-0 text-vscode-accent"
                                  viewBox="0 0 16 16"
                                  fill="currentColor"
                                >
                                  <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                                </svg>
                              </Show>
                              <Show when={!isSelected(provider.id, model.id)}>
                                <div class="h-3.5 w-3.5 shrink-0" />
                              </Show>
                              <span class="min-w-0 flex-1 truncate text-vscode-fg">
                                {model.name}
                              </span>
                              <Show when={model.limit?.context}>
                                <span class="shrink-0 text-[10px] text-vscode-muted/40">
                                  {formatContextLimit(model.limit!.context)}
                                </span>
                              </Show>
                            </button>
                          </Show>
                          <Show when={hasVariants()}>
                            <For each={variants()}>
                              {(variant) => (
                                <button
                                  class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-vscode-hover"
                                  onClick={() => {
                                    props.onSelect({
                                      providerID: provider.id,
                                      modelID: model.id,
                                      variant,
                                    });
                                    props.onClose();
                                  }}
                                >
                                  <Show when={isSelected(provider.id, model.id, variant)}>
                                    <svg
                                      class="h-3.5 w-3.5 shrink-0 text-vscode-accent"
                                      viewBox="0 0 16 16"
                                      fill="currentColor"
                                    >
                                      <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                                    </svg>
                                  </Show>
                                  <Show when={!isSelected(provider.id, model.id, variant)}>
                                    <div class="h-3.5 w-3.5 shrink-0" />
                                  </Show>
                                  <span class="min-w-0 flex-1 truncate text-vscode-fg">
                                    {model.name}
                                    <span class="ml-1 text-vscode-muted/50">
                                      · {formatThinkingLabel(variant)}
                                    </span>
                                  </span>
                                  <Show when={model.limit?.context}>
                                    <span class="shrink-0 text-[10px] text-vscode-muted/40">
                                      {formatContextLimit(model.limit!.context)}
                                    </span>
                                  </Show>
                                </button>
                              )}
                            </For>
                          </Show>
                        </>
                      );
                    }}
                  </For>
                </>
              )}
            </For>
          </Show>
        </div>

        {/* Footer: link to manage models */}
        <div class="border-t border-vscode-border/30">
          <button
            class="flex w-full items-center gap-2 px-3 py-2 text-[12px] text-vscode-muted transition-colors hover:bg-vscode-hover hover:text-vscode-fg"
            onClick={() => {
              setShowSettings(true);
              props.onClose();
            }}
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
              <path d="M6 4l4 4-4 4z" />
            </svg>
            Other Models
          </button>
        </div>
      </div>
    </div>
  );
}

function formatContextLimit(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function formatThinkingLabel(variant: string) {
  return variant
    .split(/[-_]/g)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}
