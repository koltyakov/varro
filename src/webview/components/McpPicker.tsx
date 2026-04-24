import { createEffect, createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { getSelectedMcpsForSession, state } from '../lib/state';

export function McpPicker(props: {
  sessionId: string | null;
  onChange: (names: string[]) => void;
  onClose: () => void;
  popoverRef?: (el: HTMLDivElement) => void;
}) {
  let menuRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;

  const [query, setQuery] = createSignal('');
  const [focusIndex, setFocusIndex] = createSignal(0);
  const normalizedQuery = () => query().trim().toLocaleLowerCase();

  const allItems = createMemo(() =>
    Object.entries(state.mcpStatus)
      .map(([name, status]) => ({
        name,
        status: status.status,
        error: status.error,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name))
  );

  const filteredItems = createMemo(() => {
    const search = normalizedQuery();
    if (!search) return allItems();
    return allItems().filter(
      (item) =>
        item.name.toLocaleLowerCase().includes(search) ||
        item.status.toLocaleLowerCase().replaceAll('_', ' ').includes(search)
    );
  });

  const selectedNames = createMemo(() => new Set(getSelectedMcpsForSession(props.sessionId) || []));

  createEffect(() => {
    setFocusIndex((current) => Math.max(0, Math.min(current, filteredItems().length - 1)));
  });

  function toggle(name: string) {
    const next = new Set(selectedNames());
    if (next.has(name)) next.delete(name);
    else next.add(name);
    props.onChange([...next]);
  }

  function handleKeyDown(e: KeyboardEvent) {
    const items = filteredItems();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIndex((cur) => {
        const next = cur + (e.key === 'ArrowDown' ? 1 : -1);
        if (next < 0) return items.length - 1;
        if (next >= items.length) return 0;
        return next;
      });
      queueMicrotask(() => {
        menuRef
          ?.querySelector('.dropdown-item.keyboard-focus')
          ?.scrollIntoView({ block: 'nearest' });
      });
      return;
    }

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const item = items[focusIndex()];
      if (item) toggle(item.name);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  }

  onMount(() => {
    if (allItems().length > 8) searchInputRef?.focus();
    else menuRef?.focus();
  });

  return (
    <div
      class="absolute inset-x-0 z-50"
      onClick={props.onClose}
      style={{ bottom: 'calc(100% + 10px)' }}
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
        <Show when={allItems().length > 8}>
          <div class="dropdown-search">
            <input
              ref={(el) => {
                searchInputRef = el;
              }}
              type="text"
              class="dropdown-search-input"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search MCPs"
              aria-label="Search MCPs"
              spellcheck={false}
            />
          </div>
        </Show>

        <div class="model-picker-list max-h-[280px] overflow-y-auto py-1">
          <Show
            when={allItems().length > 0}
            fallback={
              <div class="px-3 py-4 text-center text-[11px] text-vscode-muted">No MCPs found</div>
            }
          >
            <Show
              when={filteredItems().length > 0}
              fallback={
                <div class="px-3 py-4 text-center text-[11px] text-vscode-muted">
                  No matching MCPs
                </div>
              }
            >
              <For each={filteredItems()}>
                {(item, index) => (
                  <button
                    class={`dropdown-item ${selectedNames().has(item.name) ? 'selected' : ''} ${focusIndex() === index() ? 'keyboard-focus' : ''}`}
                    onClick={() => toggle(item.name)}
                    onMouseEnter={() => setFocusIndex(index())}
                  >
                    <span class="dropdown-name-wrap">
                      <span class="dropdown-name">{item.name}</span>
                      <span class="dropdown-check">
                        <Show when={selectedNames().has(item.name)}>
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
                    <span class="dropdown-meta">
                      <span class={`model-capability-tag mcp-status-tag status-${item.status}`}>
                        {item.status.replaceAll('_', ' ')}
                      </span>
                      <Show when={item.error}>
                        <span class="dropdown-hint">{item.error}</span>
                      </Show>
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}
