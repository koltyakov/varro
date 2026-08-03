import { For, Show, createEffect, onCleanup, onMount } from 'solid-js';
import { FolderIcon } from '../FolderIcon';
import {
  clampPopupToViewport,
  flipPopupDownIfNeeded,
  observePopupViewport,
} from '../../lib/popup-position';
import type { DroppedFile } from '../../../shared/protocol';

const COMPLETION_MENU_EDGE_INSET = 4;

export type MentionCompletionItem =
  | {
      key: string;
      type: 'agent';
      label: string;
      detail: string;
      value: string;
    }
  | {
      key: string;
      type: 'file';
      label: string;
      detail: string;
      value: string;
      file: DroppedFile;
    };

export type SlashCommand = {
  name: string;
  aliases: string[];
  description: string;
  source?: 'command' | 'mcp' | 'skill';
  action: (args: string) => void | Promise<void>;
};

export type CompletionItem =
  | (SlashCommand & { key: string; type: 'slash' })
  | MentionCompletionItem;

export function CompletionMenu(props: {
  items: CompletionItem[];
  selectedIndex: number;
  onSelect: (item: CompletionItem) => void;
  header?: string;
}) {
  // oxlint-disable-next-line no-unassigned-vars
  let menuRef: HTMLDivElement | undefined;
  const itemRefs = new Map<number, HTMLButtonElement>();

  function updateScrollbarInset() {
    if (!menuRef) return;
    const borderWidth = menuRef.clientLeft * 2;
    const scrollbarInset = Math.max(0, menuRef.offsetWidth - menuRef.clientWidth - borderWidth);
    menuRef.style.setProperty('--composer-completion-scrollbar-inset', `${scrollbarInset}px`);
  }

  createEffect(() => {
    const items = props.items;
    const activeIndices = new Set(items.map((_, i) => i));
    for (const key of itemRefs.keys()) {
      if (!activeIndices.has(key)) itemRefs.delete(key);
    }
  });

  createEffect(() => {
    void props.items;
    queueMicrotask(updateScrollbarInset);
  });

  createEffect(() => {
    const idx = props.selectedIndex;
    const el = itemRefs.get(idx);
    if (!el || !menuRef) return;
    const elTop = el.offsetTop;
    const elBottom = elTop + el.offsetHeight;
    const viewTop = menuRef.scrollTop + COMPLETION_MENU_EDGE_INSET;
    const viewBottom = menuRef.scrollTop + menuRef.clientHeight - COMPLETION_MENU_EDGE_INSET;
    if (elTop < viewTop) {
      menuRef.scrollTop = Math.max(0, elTop - COMPLETION_MENU_EDGE_INSET);
    } else if (elBottom > viewBottom) {
      menuRef.scrollTop = elBottom - menuRef.clientHeight + COMPLETION_MENU_EDGE_INSET;
    }
  });

  onMount(() => {
    updateScrollbarInset();
    if (!menuRef) return;

    const reposition = () => {
      if (!menuRef) return;
      updateScrollbarInset();
      flipPopupDownIfNeeded(menuRef);
      clampPopupToViewport(menuRef);
    };
    onCleanup(observePopupViewport(menuRef, reposition));
  });

  return (
    <div class="composer-completion-menu" ref={menuRef}>
      <Show when={props.header}>
        <div class="composer-completion-header">{props.header}</div>
      </Show>
      <For each={props.items}>
        {(item, index) => {
          const isSlash = item.type === 'slash';
          const title = 'name' in item ? `/${item.name}` : item.label;
          const detail = 'description' in item ? item.description : item.detail;
          return (
            <button
              ref={(el) => itemRefs.set(index(), el)}
              class={`composer-completion-item completion-${item.type} ${props.selectedIndex === index() ? 'selected' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => props.onSelect(item)}
            >
              <Show when={!isSlash}>
                <span class="composer-completion-icon">
                  <Show
                    when={item.type === 'agent'}
                    fallback={
                      item.type === 'file' && item.file.type === 'directory' ? (
                        <FolderIcon width={12} height={12} />
                      ) : (
                        <CompletionFileIcon />
                      )
                    }
                  >
                    <svg width="12" height="12" viewBox="0 0 32 32" aria-hidden="true">
                      <path
                        fill="currentColor"
                        d="M28 12V4h-8v3.546l-6 5.25V11H4v10h10v-1.796l6 5.25V28h8v-8h-8v1.796l-6-5.25v-1.092l6-5.25V12h8zM22 22h4v4h-4v-4zM12 19H6v-6h6v6zM22 6h4v4h-4V6z"
                      />
                    </svg>
                  </Show>
                </span>
              </Show>
              <CompletionTitle title={title} />
              <span class="composer-completion-detail" title={detail}>
                {detail}
              </span>
            </button>
          );
        }}
      </For>
    </div>
  );
}

function CompletionFileIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 21.4V2.6C4 2.26863 4.26863 2 4.6 2H16.2515C16.4106 2 16.5632 2.06321 16.6757 2.17574L19.8243 5.32426C19.9368 5.43679 20 5.5894 20 5.74853V21.4C20 21.7314 19.7314 22 19.4 22H4.6C4.26863 22 4 21.7314 4 21.4Z"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M16 2V5.4C16 5.73137 16.2686 6 16.6 6H20"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function CompletionTitle(props: { title: string }) {
  return (
    <span class="composer-completion-title-shell">
      <span class="composer-completion-title" title={props.title}>
        {props.title}
      </span>
    </span>
  );
}
