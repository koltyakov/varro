import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import {
  getVisibleProviders,
  getModelDisplayName,
  isModelPinned,
  setModelPinned,
  setShowModels,
  state,
} from '../lib/state';
import { formatVariantLabel as formatThinkingLabel, formatContextLimit } from '../lib/format';
import { observePopupViewport, placeTriggerDropdownAnchor } from '../lib/popup-position';
import { modelSupportsVariants } from '../lib/model-capabilities';
import { compareProviders, sortProviderModels } from '../lib/model-ordering';
import { STORAGE_KEYS, readStored, writeStored } from '../lib/state-storage';
import { checkIcon, pinIcon, searchIcon, xmarkIcon } from '../lib/ui-icons';
import { FormattedModelName } from './chat-input/ToolbarPickers';
import { Tooltip } from './Tooltip';
import { UiIcon } from './UiIcon';

interface ModelSelection {
  providerID?: string;
  modelID?: string;
  variant?: string;
}

const DEBUG_ANIMATE_MANAGE_MODELS = false; // set to true to always animate the "Manage models" button when opening the model picker
const STACKED_DETAILS_MAX_WIDTH = 700;
const STACKED_DETAILS_HOVER_DELAY_MS = 2_000;

export function ModelPicker(props: {
  onSelect: (sel: ModelSelection) => void;
  onClose: () => void;
  popoverRef?: (el: HTMLDivElement) => void;
  currentSelection?: { providerID?: string | null; modelID?: string | null } | null;
  showManageModels?: boolean;
  popupGap?: number;
  matchTriggerWidth?: boolean;
}) {
  const currentSelection = () =>
    props.currentSelection !== undefined ? props.currentSelection : state.selectedModel;
  let anchorRef: HTMLDivElement | undefined;
  let menuRef: HTMLDivElement | undefined;
  let listRef: HTMLDivElement | undefined;
  let detailsRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;
  let repositionPopup: (() => void) | undefined;
  let detailsHoverTimer: ReturnType<typeof setTimeout> | undefined;
  const visibleProviders = createMemo(() =>
    getVisibleProviders(state.providers).toSorted(compareProviders)
  );
  type VisibleProvider = ReturnType<typeof visibleProviders>[number];
  type FlatItem = {
    providerID: string;
    modelID: string;
    name: string;
  };
  type ModelEntry = {
    item: FlatItem;
    provider: VisibleProvider;
    model: VisibleProvider['models'][string];
    searchText: string;
  };
  type ProviderEntry = {
    provider: VisibleProvider;
    searchText: string;
    models: ModelEntry[];
  };

  const [query, setQuery] = createSignal('');
  const [animateManageModels, setAnimateManageModels] = createSignal(false);
  const [detailsTop, setDetailsTop] = createSignal(36);
  const [hoveredEntry, setHoveredEntry] = createSignal<{
    provider: VisibleProvider;
    model: VisibleProvider['models'][string];
  } | null>(null);
  const [detailsPlacement, setDetailsPlacement] = createSignal<'right' | 'top' | null>(null);
  const [scrollMetrics, setScrollMetrics] = createSignal({
    clientHeight: 0,
    scrollHeight: 0,
    scrollTop: 0,
  });
  const normalizedQuery = createMemo(() => query().trim().toLocaleLowerCase());

  const providerEntries = createMemo<ProviderEntry[]>(() =>
    visibleProviders().map((provider) => ({
      provider,
      searchText: `${provider.name}\n${provider.id}`.toLocaleLowerCase(),
      models: sortProviderModels(Object.values(provider.models)).map((model) => {
        const displayName = getModelDisplayName(provider.id, model.id, model.name);
        return {
          item: {
            providerID: provider.id,
            modelID: model.id,
            name: displayName,
          },
          provider,
          model,
          searchText: `${displayName}\n${model.name}\n${model.id}`.toLocaleLowerCase(),
        };
      }),
    }))
  );

  const filteredGroups = createMemo(() => {
    const search = normalizedQuery();
    const pinnedByKey = new Map<string, ModelEntry>();
    for (const providerEntry of providerEntries()) {
      for (const entry of providerEntry.models) {
        if (isModelPinned(entry.item.providerID, entry.item.modelID)) {
          pinnedByKey.set(`${entry.item.providerID}:${entry.item.modelID}`, entry);
        }
      }
    }
    const pinnedModels = state.pinnedModels
      .map((key) => pinnedByKey.get(key))
      .filter((entry): entry is ModelEntry => Boolean(entry))
      .filter(
        (entry) =>
          !search ||
          entry.searchText.includes(search) ||
          `${entry.provider.name}\n${entry.provider.id}`.toLocaleLowerCase().includes(search)
      );

    const filtered: ProviderEntry[] = [];
    for (const providerEntry of providerEntries()) {
      const unpinnedModels = providerEntry.models.filter(
        (entry) => !isModelPinned(entry.item.providerID, entry.item.modelID)
      );
      if (providerEntry.searchText.includes(search)) {
        if (unpinnedModels.length > 0) filtered.push({ ...providerEntry, models: unpinnedModels });
        continue;
      }
      const models = unpinnedModels.filter((model) => model.searchText.includes(search));
      if (models.length > 0) {
        filtered.push({
          provider: providerEntry.provider,
          searchText: providerEntry.searchText,
          models,
        });
      }
    }
    return [
      ...(pinnedModels.length > 0 ? [{ name: 'Pinned', models: pinnedModels }] : []),
      ...filtered.map((entry) => ({ name: entry.provider.name, models: entry.models })),
    ];
  });

  const [focusIndex, setFocusIndex] = createSignal(0);
  const flatItems = createMemo<FlatItem[]>(() => {
    const items: FlatItem[] = [];
    for (const { models } of filteredGroups()) {
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
    if (props.showManageModels ?? true) {
      const isFirstOpen = readStored<boolean>(STORAGE_KEYS.modelPickerOpened) !== true;
      if (isFirstOpen) writeStored(STORAGE_KEYS.modelPickerOpened, true);
      setAnimateManageModels(
        DEBUG_ANIMATE_MANAGE_MODELS ||
          (isFirstOpen && state.hiddenProviders.length === 0 && state.hiddenModels.length === 0)
      );
    }

    const reposition = () => {
      if (!anchorRef || !menuRef) return;
      const host = anchorRef.offsetParent;
      const button = host?.querySelector<HTMLElement>('.model-picker-btn');
      if (!(host instanceof HTMLElement) || !button) return;

      const hostBox = host.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      const gap = props.popupGap ?? 6;
      const viewportMargin = 8;
      const defaultMenuWidth = props.matchTriggerWidth ? buttonBox.width : 256.5;
      const minimumMenuWidth = 220;
      const boundaryLeft = Math.max(viewportMargin, hostBox.left);
      const boundaryRight = Math.min(window.innerWidth - viewportMargin, hostBox.right);
      const boundaryWidth = Math.max(0, boundaryRight - boundaryLeft);
      const maximumMenuWidth = Math.min(defaultMenuWidth, boundaryWidth);
      const triggerLeft = Math.max(boundaryLeft, buttonBox.left);
      const availableRightWidth = boundaryRight - triggerLeft;
      const canRemainRightOpening =
        availableRightWidth >= Math.min(minimumMenuWidth, maximumMenuWidth);
      const menuWidth = canRemainRightOpening
        ? Math.min(maximumMenuWidth, availableRightWidth)
        : maximumMenuWidth;
      const viewportLeft = canRemainRightOpening
        ? triggerLeft
        : Math.max(boundaryLeft, Math.min(buttonBox.right - menuWidth, boundaryRight - menuWidth));
      anchorRef.style.width = `${menuWidth}px`;
      anchorRef.style.left = `${Math.round(viewportLeft - hostBox.left)}px`;
      anchorRef.style.right = 'auto';
      anchorRef.style.paddingBottom = '0px';
      const editBanner = anchorRef
        .closest('.interactive-input-part')
        ?.querySelector<HTMLElement>('.composer-edit-banner');
      const availableHeight = placeTriggerDropdownAnchor(
        anchorRef,
        menuRef,
        button,
        gap,
        viewportMargin,
        editBanner
      );
      const detailsHeight = detailsPlacement() === 'top' ? (detailsRef?.offsetHeight ?? 0) + 7 : 0;
      const menuHeight = Math.min(396, Math.max(0, availableHeight - detailsHeight));
      const searchHeight =
        menuRef.querySelector<HTMLElement>('.model-picker-search')?.offsetHeight ?? 0;
      const footerHeight =
        menuRef.querySelector<HTMLElement>('.dropdown-footer')?.offsetHeight ?? 0;
      menuRef.style.maxHeight = `${menuHeight}px`;
      if (listRef)
        listRef.style.maxHeight = `${Math.max(0, menuHeight - searchHeight - footerHeight)}px`;
    };
    repositionPopup = reposition;

    searchInputRef?.focus();

    if (!menuRef) return;
    const stopObservingViewport = observePopupViewport(menuRef, reposition);
    const listObserver =
      globalThis.ResizeObserver === undefined
        ? null
        : new globalThis.ResizeObserver(updateScrollMetrics);
    if (listRef) listObserver?.observe(listRef);
    onCleanup(() => {
      clearTimeout(detailsHoverTimer);
      repositionPopup = undefined;
      stopObservingViewport();
      listObserver?.disconnect();
    });
  });

  const getItemIndex = (providerID: string, modelID: string) => {
    return flatItems().findIndex((i) => i.providerID === providerID && i.modelID === modelID);
  };
  const scrollbarThumbHeight = createMemo(() => {
    const { clientHeight, scrollHeight } = scrollMetrics();
    if (scrollHeight <= clientHeight) return 0;
    return Math.max(24, (clientHeight * clientHeight) / scrollHeight);
  });
  const scrollbarThumbTop = createMemo(() => {
    const { clientHeight, scrollHeight, scrollTop } = scrollMetrics();
    const availableTrack = clientHeight - scrollbarThumbHeight();
    const availableScroll = scrollHeight - clientHeight;
    return availableScroll > 0 ? (scrollTop / availableScroll) * availableTrack : 0;
  });

  function updateScrollMetrics() {
    if (!listRef) return;
    setScrollMetrics({
      clientHeight: listRef.clientHeight,
      scrollHeight: listRef.scrollHeight,
      scrollTop: listRef.scrollTop,
    });
  }

  createEffect(() => {
    filteredGroups();
    queueMicrotask(updateScrollMetrics);
  });

  return (
    <div
      ref={(el) => {
        anchorRef = el;
      }}
      class={`dropdown-anchor model-picker-anchor absolute z-50 ${detailsPlacement() === 'top' ? 'details-on-top' : ''}`}
      onClick={props.onClose}
      style={{ bottom: '100%' }}
    >
      <div
        ref={(el) => {
          menuRef = el;
          props.popoverRef?.(el);
        }}
        class="dropdown-menu model-picker-menu w-full"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
        style={{ outline: 'none' }}
      >
        <div class="dropdown-search model-picker-search">
          <UiIcon
            source={searchIcon}
            class="dropdown-search-icon"
            width={12}
            height={12}
            aria-hidden="true"
          />
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
            <Tooltip content="Clear search">
              <button
                type="button"
                class="dropdown-search-clear"
                onClick={() => {
                  setQuery('');
                  searchInputRef?.focus();
                }}
                aria-label="Clear search"
                tabIndex={-1}
              >
                <UiIcon source={xmarkIcon} width={11} height={11} />
              </button>
            </Tooltip>
          </Show>
        </div>

        <div class="model-picker-list-frame">
          <div
            ref={(element) => (listRef = element)}
            class="model-picker-list pb-1"
            onScroll={updateScrollMetrics}
          >
            <Show
              when={visibleProviders().length > 0}
              fallback={
                <div class="model-picker-empty px-3 text-center text-[11px] text-vscode-muted">
                  No models available
                </div>
              }
            >
              <Show
                when={filteredGroups().length > 0}
                fallback={
                  <div class="model-picker-empty px-3 text-center text-[11px] text-vscode-muted">
                    No matching models
                  </div>
                }
              >
                <For each={filteredGroups()}>
                  {({ name, models }) => (
                    <>
                      <div class="dropdown-group-header">{name}</div>
                      <For each={models}>
                        {(entry) => {
                          const provider = entry.provider;
                          const model = entry.model;
                          const myIndex = () => getItemIndex(provider.id, model.id);
                          const pinned = () => isModelPinned(provider.id, model.id);
                          return (
                            <div
                              class={`model-picker-row ${pinned() ? 'pinned' : ''}`}
                              onMouseEnter={(event) => {
                                clearTimeout(detailsHoverTimer);
                                setFocusIndex(myIndex());
                                setHoveredEntry({ provider, model });
                                if (!anchorRef || !menuRef) return;
                                const anchorBox = anchorRef.getBoundingClientRect();
                                const rowBox = event.currentTarget.getBoundingClientRect();
                                setDetailsTop(
                                  Math.max(
                                    0,
                                    Math.min(
                                      rowBox.top - anchorBox.top,
                                      window.innerHeight - anchorBox.top - 150
                                    )
                                  )
                                );
                                if (window.innerWidth <= STACKED_DETAILS_MAX_WIDTH) {
                                  setDetailsPlacement(null);
                                  detailsHoverTimer = setTimeout(() => {
                                    setDetailsPlacement('top');
                                    queueMicrotask(() => repositionPopup?.());
                                  }, STACKED_DETAILS_HOVER_DELAY_MS);
                                } else {
                                  setDetailsPlacement(
                                    menuRef.getBoundingClientRect().right + 235 <= window.innerWidth
                                      ? 'right'
                                      : null
                                  );
                                  queueMicrotask(() => repositionPopup?.());
                                }
                              }}
                              onMouseLeave={() => {
                                clearTimeout(detailsHoverTimer);
                                setHoveredEntry(null);
                                setDetailsPlacement(null);
                                queueMicrotask(() => repositionPopup?.());
                              }}
                            >
                              <button
                                class={`dropdown-item model-picker-item ${isSelected(provider.id, model.id) ? 'selected' : ''} ${focusIndex() === myIndex() ? 'keyboard-focus' : ''}`}
                                data-provider-id={provider.id}
                                data-model-id={model.id}
                                onClick={() => {
                                  props.onSelect({ providerID: provider.id, modelID: model.id });
                                  props.onClose();
                                }}
                              >
                                <span class="dropdown-name-wrap">
                                  <span class="dropdown-name">
                                    <FormattedModelName name={entry.item.name} />
                                  </span>
                                  <Show when={pinned()}>
                                    <span class="model-picker-provider-name">{provider.name}</span>
                                  </Show>
                                  <span class="dropdown-check">
                                    <Show when={isSelected(provider.id, model.id)}>
                                      <UiIcon
                                        source={checkIcon}
                                        class="h-3 w-3 text-vscode-accent"
                                        width={12}
                                        height={12}
                                      />
                                    </Show>
                                  </span>
                                </span>
                              </button>
                              <Tooltip content={`${pinned() ? 'Unpin' : 'Pin'} model`}>
                                <button
                                  type="button"
                                  class="model-picker-pin"
                                  classList={{ active: pinned() }}
                                  onClick={() => setModelPinned(provider.id, model.id, !pinned())}
                                  aria-label={`${pinned() ? 'Unpin' : 'Pin'} ${entry.item.name}`}
                                >
                                  <UiIcon
                                    source={pinIcon}
                                    width={14}
                                    height={14}
                                    aria-hidden="true"
                                  />
                                </button>
                              </Tooltip>
                            </div>
                          );
                        }}
                      </For>
                    </>
                  )}
                </For>
              </Show>
            </Show>
          </div>
          <Show when={scrollbarThumbHeight() > 0}>
            <div class="model-picker-scrollbar" aria-hidden="true">
              <div
                class="model-picker-scrollbar-thumb"
                style={{
                  height: `${scrollbarThumbHeight()}px`,
                  transform: `translateY(${scrollbarThumbTop()}px)`,
                }}
              />
            </div>
          </Show>
        </div>

        <Show when={props.showManageModels ?? true}>
          <div class="dropdown-footer">
            <button
              class={`dropdown-item ${animateManageModels() ? 'manage-models-attention' : ''}`}
              onClick={() => {
                setShowModels(true);
                props.onClose();
              }}
            >
              <span
                class={`dropdown-footer-icon ${animateManageModels() ? 'manage-models-attention-icon' : ''}`}
              >
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
              <span
                class={`dropdown-footer-label text-vscode-muted ${animateManageModels() ? 'shimmer-progress' : ''}`}
              >
                Manage models
              </span>
            </button>
          </div>
        </Show>
      </div>
      <Show when={detailsPlacement() ? hoveredEntry() : null}>
        {(entry) => (
          <div
            ref={(element) => (detailsRef = element)}
            class={`model-picker-details ${detailsPlacement()}`}
            style={detailsPlacement() === 'right' ? { top: `${detailsTop()}px` } : undefined}
            aria-live="polite"
          >
            <dl>
              <div>
                <dt>Model</dt>
                <dd>
                  {getModelDisplayName(entry().provider.id, entry().model.id, entry().model.name)}
                </dd>
              </div>
              <div>
                <dt>Provider</dt>
                <dd>{entry().provider.name}</dd>
              </div>
              <div>
                <dt>Inputs</dt>
                <dd>{formatModelInputs(entry().model.capabilities.input)}</dd>
              </div>
              <div>
                <dt>Reasoning</dt>
                <dd>
                  {entry().model.capabilities.reasoning ||
                  modelSupportsVariants(entry().provider.id, entry().model.id, state.providers)
                    ? 'Allows reasoning'
                    : 'No reasoning'}
                </dd>
              </div>
              <Show when={entry().model.limit?.context}>
                {(context) => (
                  <div>
                    <dt>Context</dt>
                    <dd>{formatContextLimit(context())}</dd>
                  </div>
                )}
              </Show>
            </dl>
          </div>
        )}
      </Show>
    </div>
  );
}

function formatModelInputs(input: VisibleProviderModel['capabilities']['input']): string {
  if (Array.isArray(input)) return input.join(', ') || 'text';
  if (input) {
    const enabled = Object.entries(input)
      .filter(([, supported]) => supported)
      .map(([modality]) => modality);
    if (enabled.length > 0) return enabled.join(', ');
  }
  return 'text';
}

type VisibleProviderModel = ReturnType<typeof getVisibleProviders>[number]['models'][string];

export { formatThinkingLabel, formatContextLimit };
