import { createMemo, For, onCleanup, onMount } from 'solid-js';
import type { LspStatus } from '../../shared/protocol';
import { observePopupViewport, placeDropdownAnchor } from '../lib/popup-position';

export function LspPicker(props: {
  items: LspStatus[];
  onClose: () => void;
  popoverRef?: (el: HTMLDivElement) => void;
}) {
  let anchorRef: HTMLDivElement | undefined;
  let menuRef: HTMLDivElement | undefined;
  const items = createMemo(() =>
    props.items.toSorted((left, right) => left.name.localeCompare(right.name))
  );

  onMount(() => {
    const reposition = () => {
      if (anchorRef && menuRef) placeDropdownAnchor(anchorRef, menuRef, 10, 8);
    };

    menuRef?.focus();
    if (menuRef) onCleanup(observePopupViewport(menuRef, reposition));
  });

  return (
    <div
      ref={(el) => {
        anchorRef = el;
      }}
      class="dropdown-anchor absolute inset-x-0 z-50"
      onClick={props.onClose}
      style={{ bottom: '100%', 'padding-bottom': '10px' }}
    >
      <div
        ref={(el) => {
          menuRef = el;
          props.popoverRef?.(el);
        }}
        class="dropdown-menu w-full"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          props.onClose();
        }}
        onClick={(event) => event.stopPropagation()}
        style={{ outline: 'none' }}
      >
        <div class="dropdown-header">LSPs</div>
        <div class="model-picker-list overflow-y-auto py-1">
          <For each={items()}>
            {(item) => (
              <div class="dropdown-item lsp-picker-item">
                <span class="dropdown-name-wrap">
                  <span class="dropdown-name">{item.name}</span>
                  <span class="dropdown-hint">{item.root || 'workspace root'}</span>
                </span>
                <span class="dropdown-meta">
                  <span class={`model-capability-tag mcp-status-tag status-${item.status}`}>
                    {item.status}
                  </span>
                </span>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
