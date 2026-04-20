import { createMemo, createSignal, For, onMount, Show, createEffect } from 'solid-js';
import { getVisibleProviders, setShowSettings, state } from '../lib/state';
import { formatVariantLabel as formatThinkingLabel, formatContextLimit } from '../lib/format';

interface ModelSelection {
  providerID?: string;
  modelID?: string;
  variant?: string;
}

export function ModelPicker(props: {
  onSelect: (sel: ModelSelection) => void;
  onClose: () => void;
}) {
  // oxlint-disable-next-line no-unassigned-vars
  let menuRef: HTMLDivElement | undefined;
  const visibleProviders = createMemo(() => getVisibleProviders(state.providers));

  const flatItems = createMemo(() => {
    const items: Array<{
      providerID: string;
      modelID: string;
      name: string;
      contextLimit?: number;
    }> = [];
    for (const provider of visibleProviders()) {
      for (const model of Object.values(provider.models).toSorted((a, b) =>
        a.name.localeCompare(b.name)
      )) {
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
    const idx = initialIndex();
    setFocusIndex(idx);
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
    menuRef?.focus();
  });

  const getItemIndex = (providerID: string, modelID: string) => {
    return flatItems().findIndex((i) => i.providerID === providerID && i.modelID === modelID);
  };

  return (
    <div class="absolute inset-x-0 bottom-full z-50 mb-1 px-3" onClick={props.onClose}>
      <div
        ref={menuRef}
        class="dropdown-menu w-full"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
        style={{ outline: 'none' }}
      >
        <div class="max-h-[280px] overflow-y-auto py-1">
          <Show
            when={visibleProviders().length > 0}
            fallback={
              <div class="px-3 py-4 text-center text-[11px] text-vscode-muted">
                No models available
              </div>
            }
          >
            <For each={visibleProviders()}>
              {(provider) => (
                <>
                  <div class="dropdown-group-header">{provider.name}</div>
                  <For
                    each={Object.values(provider.models).toSorted((a, b) =>
                      a.name.localeCompare(b.name)
                    )}
                  >
                    {(model) => {
                      const myIndex = () => getItemIndex(provider.id, model.id);
                      return (
                        <button
                          class={`dropdown-item ${isSelected(provider.id, model.id) ? 'selected' : ''} ${focusIndex() === myIndex() ? 'keyboard-focus' : ''}`}
                          onClick={() => {
                            props.onSelect({ providerID: provider.id, modelID: model.id });
                            props.onClose();
                          }}
                          onMouseEnter={() => setFocusIndex(myIndex())}
                        >
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
                          <span class="min-w-0 flex-1 truncate">{model.name}</span>
                          <Show when={model.limit?.context}>
                            <span class="dropdown-hint">
                              {formatContextLimit(model.limit!.context)}
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
        </div>

        <div class="border-t border-vscode-border/20">
          <button
            class="dropdown-item"
            onClick={() => {
              setShowSettings(true);
              props.onClose();
            }}
          >
            <span class="dropdown-check">
              <svg class="h-3 w-3 text-vscode-muted" viewBox="0 0 16 16" fill="currentColor">
                <path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.7.3.5 2.4h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.7 2.4-.5V6.8l-2.4-.5-.3-.8 1.3-2-.8-.8-2 1.3-.7-.3zM9.4 8a1.4 1.4 0 11-2.8 0 1.4 1.4 0 012.8 0z" />
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

export function modelSupportsReasoning(
  providerID: string | null,
  modelID: string | null,
  providers: {
    id: string;
    models: {
      [key: string]: {
        capabilities?: { reasoning?: boolean };
        variants?: { [key: string]: unknown };
      };
    };
  }[]
): boolean {
  if (!providerID || !modelID) return false;
  const provider = providers.find((p) => p.id === providerID);
  const model = provider?.models[modelID];
  if (!model) return false;
  return (
    !!model.capabilities?.reasoning ||
    (model.variants != null && Object.keys(model.variants).length > 0)
  );
}

export { formatThinkingLabel, formatContextLimit };

