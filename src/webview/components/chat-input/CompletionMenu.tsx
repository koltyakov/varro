import { For, Show, createEffect, onCleanup, onMount } from 'solid-js';
import { FolderIcon } from '../FolderIcon';
import {
  clampPopupToViewport,
  flipPopupDownIfNeeded,
  observePopupViewport,
} from '../../lib/popup-position';
import type { DroppedFile } from '../../../shared/protocol';
import type { Session } from '../../types';
import { formatRelativeAge } from '../../lib/message-metrics';

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
    }
  | {
      key: string;
      type: 'session';
      label: string;
      detail: string;
      value: string;
      session: Session;
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
          const detail =
            item.type === 'session'
              ? formatRelativeAge(item.session.time.updated, Date.now())
              : 'description' in item
                ? item.description
                : item.detail;
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
                      item.type === 'session' ? (
                        <CompletionSessionIcon />
                      ) : item.type === 'file' && item.file.type === 'directory' ? (
                        <FolderIcon width={12} height={12} />
                      ) : (
                        <CompletionFileIcon />
                      )
                    }
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <rect
                        x="2"
                        y="21"
                        width="7"
                        height="5"
                        rx="0.6"
                        transform="rotate(-90 2 21)"
                        stroke="currentColor"
                        stroke-width="1.6"
                      />
                      <rect
                        x="17"
                        y="15.5"
                        width="7"
                        height="5"
                        rx="0.6"
                        transform="rotate(-90 17 15.5)"
                        stroke="currentColor"
                        stroke-width="1.6"
                      />
                      <rect
                        x="2"
                        y="10"
                        width="7"
                        height="5"
                        rx="0.6"
                        transform="rotate(-90 2 10)"
                        stroke="currentColor"
                        stroke-width="1.6"
                      />
                      <path
                        d="M7 17.5H10.5C11.6046 17.5 12.5 16.6046 12.5 15.5V8.5C12.5 7.39543 11.6046 6.5 10.5 6.5H7"
                        stroke="currentColor"
                        stroke-width="1.6"
                      />
                      <path d="M12.5 12H17" stroke="currentColor" stroke-width="1.6" />
                    </svg>
                  </Show>
                </span>
              </Show>
              <CompletionTitle title={title} />
              <span
                class={`composer-completion-detail${item.type === 'session' ? ' composer-completion-age' : ''}`}
                title={item.type === 'session' ? undefined : detail}
              >
                {detail}
              </span>
            </button>
          );
        }}
      </For>
    </div>
  );
}

function CompletionSessionIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7 12L17 12"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M7 8L13 8"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M3 20.2895V5C3 3.89543 3.89543 3 5 3H19C20.1046 3 21 3.89543 21 5V15C21 16.1046 20.1046 17 19 17H7.96125C7.35368 17 6.77906 17.2762 6.39951 17.7506L4.06852 20.6643C3.71421 21.1072 3 20.8567 3 20.2895Z"
        stroke="currentColor"
        stroke-width="1.6"
      />
    </svg>
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
