import { createMemo, createSignal, For, onMount, Show, createEffect } from 'solid-js';
import { getVisibleProviders, setShowSettings, state } from '../lib/state';
import { formatVariantLabel as formatThinkingLabel, formatContextLimit } from '../lib/format';
import {
  modelSupportsTools,
  modelSupportsVariants,
  modelSupportsVision,
} from '../lib/model-capabilities';

interface ModelSelection {
  providerID?: string;
  modelID?: string;
  variant?: string;
}

export function ModelPicker(props: {
  onSelect: (sel: ModelSelection) => void;
  onClose: () => void;
  popoverRef?: (el: HTMLDivElement) => void;
}) {
  let menuRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;
  const visibleProviders = createMemo(() => getVisibleProviders(state.providers));

  const [query, setQuery] = createSignal('');
  const normalizedQuery = () => query().trim().toLocaleLowerCase();

  const totalModelCount = createMemo(() =>
    visibleProviders().reduce((acc, p) => acc + Object.keys(p.models).length, 0)
  );
  const showSearch = createMemo(() => totalModelCount() > 10);

  const filteredProviders = createMemo(() => {
    const search = normalizedQuery();
    return visibleProviders()
      .map((provider) => {
        const models = Object.values(provider.models).toSorted((a, b) =>
          a.name.localeCompare(b.name)
        );
        if (!search) return { provider, models };
        const providerMatches = [provider.name, provider.id].some((v) =>
          v.toLocaleLowerCase().includes(search)
        );
        return {
          provider,
          models: providerMatches
            ? models
            : models.filter((m) =>
                [m.name, m.id].some((v) => v.toLocaleLowerCase().includes(search))
              ),
        };
      })
      .filter((entry) => entry.models.length > 0);
  });

  const flatItems = createMemo(() => {
    const items: Array<{
      providerID: string;
      modelID: string;
      name: string;
      contextLimit?: number;
    }> = [];
    for (const { provider, models } of filteredProviders()) {
      for (const model of models) {
        items.push({
          providerID: provider.id,
          modelID: model.id,
          name: model.name,
          contextLimit: model.limit?.context,
        });
      }
    }
    return items;
  });

  const initialIndex = () => {
    const sel = state.selectedModel;
    if (!sel) return 0;
    const idx = flatItems().findIndex(
      (i) => i.providerID === sel.providerID && i.modelID === sel.modelID
    );
    return idx >= 0 ? idx : 0;
  };

  const [focusIndex, setFocusIndex] = createSignal(0);

  createEffect(() => {
    if (normalizedQuery()) {
      setFocusIndex(0);
      return;
    }
    setFocusIndex(initialIndex());
  });

  const isSelected = (providerID: string, modelID: string) => {
    const sel = state.selectedModel;
    return sel?.providerID === providerID && sel?.modelID === modelID;
  };

  function handleKeyDown(e: KeyboardEvent) {
    const items = flatItems();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIndex((cur) => {
        const next = cur + (e.key === 'ArrowDown' ? 1 : -1);
        if (next < 0) return items.length - 1;
        if (next >= items.length) return 0;
        return next;
      });
      scrollFocusedIntoView();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[focusIndex()];
      if (item) {
        props.onSelect({ providerID: item.providerID, modelID: item.modelID });
        props.onClose();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  }

  function scrollFocusedIntoView() {
    queueMicrotask(() => {
      menuRef?.querySelector('.dropdown-item.keyboard-focus')?.scrollIntoView({ block: 'nearest' });
    });
  }

  onMount(() => {
    if (showSearch()) {
      searchInputRef?.focus();
    } else {
      menuRef?.focus();
    }
  });

  const getItemIndex = (providerID: string, modelID: string) => {
    return flatItems().findIndex((i) => i.providerID === providerID && i.modelID === modelID);
  };

  return (
    <div class="absolute inset-x-0 bottom-full z-50 mb-1 px-3" onClick={props.onClose}>
      <div
        ref={(el) => {
          menuRef = el;
          props.popoverRef?.(el);
        }}
        class="dropdown-menu w-full"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
        style={{ outline: 'none' }}
      >
        <Show when={showSearch()}>
          <div class="dropdown-search">
            <input
              ref={(el) => {
                searchInputRef = el;
              }}
              type="text"
              class="dropdown-search-input"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search models"
              aria-label="Search models"
              spellcheck={false}
            />
            <Show when={query().length > 0}>
              <button
                type="button"
                class="dropdown-search-clear"
                onClick={() => {
                  setQuery('');
                  searchInputRef?.focus();
                }}
                aria-label="Clear search"
                title="Clear search"
                tabIndex={-1}
              >
                <svg viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.22 3.22a.75.75 0 011.06 0L8 6.94l3.72-3.72a.75.75 0 111.06 1.06L9.06 8l3.72 3.72a.75.75 0 11-1.06 1.06L8 9.06l-3.72 3.72a.75.75 0 01-1.06-1.06L6.94 8 3.22 4.28a.75.75 0 010-1.06z" />
                </svg>
              </button>
            </Show>
          </div>
        </Show>

        <div class="max-h-[280px] overflow-y-auto py-1">
          <Show
            when={visibleProviders().length > 0}
            fallback={
              <div class="px-3 py-4 text-center text-[11px] text-vscode-muted">
                No models available
              </div>
            }
          >
            <Show
              when={filteredProviders().length > 0}
              fallback={
                <div class="px-3 py-4 text-center text-[11px] text-vscode-muted">
                  No matching models
                </div>
              }
            >
              <For each={filteredProviders()}>
                {({ provider, models }) => (
                  <>
                    <div class="dropdown-group-header">{provider.name}</div>
                    <For each={models}>
                      {(model) => {
                        const myIndex = () => getItemIndex(provider.id, model.id);
                        const supportsTools = () =>
                          modelSupportsTools(provider.id, model.id, state.providers);
                        const supportsVariants = () =>
                          modelSupportsVariants(provider.id, model.id, state.providers);
                        const supportsVision = () =>
                          modelSupportsVision(provider.id, model.id, state.providers);
                        return (
                          <button
                            class={`dropdown-item ${isSelected(provider.id, model.id) ? 'selected' : ''} ${focusIndex() === myIndex() ? 'keyboard-focus' : ''}`}
                            onClick={() => {
                              props.onSelect({ providerID: provider.id, modelID: model.id });
                              props.onClose();
                            }}
                            onMouseEnter={() => setFocusIndex(myIndex())}
                          >
                            <span class="dropdown-name-wrap">
                              <span class="dropdown-name">{model.name}</span>
                              <span class="dropdown-check">
                                <Show when={isSelected(provider.id, model.id)}>
                                  <svg
                                    class="h-3 w-3 text-vscode-accent"
                                    viewBox="0 0 16 16"
                                    fill="currentColor"
                                  >
                                    <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                                  </svg>
                                </Show>
                              </span>
                            </span>
                            <Show
                              when={
                                supportsTools() ||
                                supportsVariants() ||
                                supportsVision() ||
                                model.limit?.context
                              }
                            >
                              <span class="dropdown-meta">
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
                                  <span class="dropdown-hint">
                                    {formatContextLimit(model.limit!.context)}
                                  </span>
                                </Show>
                              </span>
                            </Show>
                          </button>
                        );
                      }}
                    </For>
                  </>
                )}
              </For>
            </Show>
          </Show>
        </div>

        <div class="dropdown-footer">
          <button
            class="dropdown-item"
            onClick={() => {
              setShowSettings(true);
              props.onClose();
            }}
          >
            <span class="dropdown-footer-icon">
              <svg
                class="h-3.5 w-3.5 text-vscode-muted"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M2.5 4h7" />
                <path d="M12.5 4h1" />
                <circle cx="11" cy="4" r="1.4" fill="currentColor" />
                <path d="M2.5 8h2" />
                <path d="M7 8h6.5" />
                <circle cx="5.5" cy="8" r="1.4" fill="currentColor" />
                <path d="M2.5 12h5" />
                <path d="M10 12h3.5" />
                <circle cx="8.5" cy="12" r="1.4" fill="currentColor" />
              </svg>
            </span>
            <span class="text-vscode-muted">Manage Models</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function getVariantsForModel(
  providerID: string | null,
  modelID: string | null,
  providers: { id: string; models: { [key: string]: { variants?: { [key: string]: unknown } } } }[]
): string[] {
  if (!providerID || !modelID) return [];
  const provider = providers.find((p) => p.id === providerID);
  const model = provider?.models[modelID];
  if (!model?.variants) return [];
  return Object.keys(model.variants);
}

export { formatThinkingLabel, formatContextLimit };
