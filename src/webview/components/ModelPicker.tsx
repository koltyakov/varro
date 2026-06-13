import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { getVisibleProviders, setShowSettings, state } from '../lib/state';
import { formatVariantLabel as formatThinkingLabel, formatContextLimit } from '../lib/format';
import { observePopupViewport, placeDropdownAnchor } from '../lib/popup-position';
import {
  modelSupportsTools,
  modelSupportsVariants,
  modelSupportsVision,
} from '../lib/model-capabilities';
import { normalizeModelVariant } from '../lib/model-variants';

interface ModelSelection {
  providerID?: string;
  modelID?: string;
  variant?: string;
}

export function ModelPicker(props: {
  onSelect: (sel: ModelSelection) => void;
  onClose: () => void;
  popoverRef?: (el: HTMLDivElement) => void;
  currentSelection?: { providerID?: string | null; modelID?: string | null } | null;
  showManageModels?: boolean;
  popupGap?: number;
}) {
  const currentSelection = () =>
    props.currentSelection !== undefined ? props.currentSelection : state.selectedModel;
  let anchorRef: HTMLDivElement | undefined;
  let menuRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;
  const visibleProviders = createMemo(() => getVisibleProviders(state.providers));
  type VisibleProvider = ReturnType<typeof visibleProviders>[number];
  type FlatItem = {
    providerID: string;
    modelID: string;
    name: string;
    contextLimit?: number;
  };
  type ModelEntry = {
    item: FlatItem;
    model: VisibleProvider['models'][string];
    searchText: string;
  };
  type ProviderEntry = {
    provider: VisibleProvider;
    searchText: string;
    models: ModelEntry[];
  };

  const [query, setQuery] = createSignal('');
  const normalizedQuery = createMemo(() => query().trim().toLocaleLowerCase());

  const providerEntries = createMemo<ProviderEntry[]>(() =>
    visibleProviders().map((provider) => ({
      provider,
      searchText: `${provider.name}\n${provider.id}`.toLocaleLowerCase(),
      models: Object.values(provider.models)
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((model) => ({
          item: {
            providerID: provider.id,
            modelID: model.id,
            name: model.name,
            contextLimit: model.limit?.context,
          },
          model,
          searchText: `${model.name}\n${model.id}`.toLocaleLowerCase(),
        })),
    }))
  );

  const totalModelCount = createMemo(() =>
    providerEntries().reduce((acc, provider) => acc + provider.models.length, 0)
  );
  const showSearch = createMemo(() => totalModelCount() > 10);

  const filteredProviders = createMemo<ProviderEntry[]>(() => {
    const search = normalizedQuery();
    if (!search) return providerEntries();

    const filtered: ProviderEntry[] = [];
    for (const providerEntry of providerEntries()) {
      if (providerEntry.searchText.includes(search)) {
        filtered.push(providerEntry);
        continue;
      }
      const models = providerEntry.models.filter((model) => model.searchText.includes(search));
      if (models.length > 0) {
        filtered.push({
          provider: providerEntry.provider,
          searchText: providerEntry.searchText,
          models,
        });
      }
    }
    return filtered;
  });

  const flatItems = createMemo<FlatItem[]>(() => {
    const items: FlatItem[] = [];
    for (const { models } of filteredProviders()) {
      for (const model of models) {
        items.push(model.item);
      }
    }
    return items;
  });

  const initialIndex = () => {
    const sel = currentSelection();
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
    const sel = currentSelection();
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
    const reposition = () => {
      if (anchorRef && menuRef) {
        const editBanner = anchorRef
          .closest('.interactive-input-part')
          ?.querySelector<HTMLElement>('.composer-edit-banner');
        placeDropdownAnchor(anchorRef, menuRef, props.popupGap ?? 10, 8, editBanner);
      }
    };

    if (showSearch()) {
      searchInputRef?.focus();
    } else {
      menuRef?.focus();
    }

    if (!menuRef) return;
    onCleanup(observePopupViewport(menuRef, reposition));
  });

  const getItemIndex = (providerID: string, modelID: string) => {
    return flatItems().findIndex((i) => i.providerID === providerID && i.modelID === modelID);
  };

  return (
    <div
      ref={(el) => {
        anchorRef = el;
      }}
      class="dropdown-anchor absolute inset-x-0 z-50"
      onClick={props.onClose}
      style={{ bottom: '100%', 'padding-bottom': `${props.popupGap ?? 10}px` }}
    >
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
        <div class="dropdown-header">Models</div>

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

        <div class="model-picker-list overflow-y-auto py-1">
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
                      {(entry) => {
                        const model = entry.model;
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

        <Show when={props.showManageModels ?? true}>
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
                  class="block h-[18px] w-[18px] text-vscode-muted"
                  viewBox="0 0 32 32"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M10 20c-1.657 0-3 1.343-3 3s1.343 3 3 3 3-1.343 3-3-1.343-3-3-3zm0 4c-.551 0-1-.449-1-1s.449-1 1-1 1 .449 1 1-.449 1-1 1z" />
                  <circle cx="10" cy="16" r="3" />
                  <path d="M10 6C8.343 6 7 7.343 7 9s1.343 3 3 3 3-1.343 3-3-1.343-3-3-3zm0 4c-.551 0-1-.449-1-1s.449-1 1-1 1 .449 1 1-.449 1-1 1z" />
                  <rect x="15" y="8" width="10" height="2" />
                  <rect x="15" y="15" width="10" height="2" />
                  <rect x="15" y="22" width="10" height="2" />
                </svg>
              </span>
              <span class="dropdown-footer-label text-vscode-muted">Manage Models</span>
            </button>
          </div>
        </Show>
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
  return Array.from(
    new Set(Object.keys(model.variants).map((variant) => normalizeModelVariant(modelID, variant)))
  ).filter((variant): variant is string => !!variant);
}

export { formatThinkingLabel, formatContextLimit };
