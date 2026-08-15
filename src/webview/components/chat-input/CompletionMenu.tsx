import { For, Show, createEffect, onCleanup, onMount } from 'solid-js';
import { FileTypeIcon } from '../FileTypeIcon';
import { FolderIcon } from '../FolderIcon';
import { MaterialChipIcon } from '../MaterialChipIcon';
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
                        <MaterialChipIcon kind="session" class="completion-session-icon" />
                      ) : item.type === 'file' && item.file.type === 'directory' ? (
                        <FolderIcon width={12} height={12} />
                      ) : (
                        <FileTypeIcon
                          path={
                            item.type === 'file' ? item.file.relativePath || item.file.path : ''
                          }
                          class="completion-file-type-icon"
                        />
                      )
                    }
                  >
                    <MaterialChipIcon kind="agent" class="completion-agent-icon" />
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

function CompletionTitle(props: { title: string }) {
  return (
    <span class="composer-completion-title-shell">
      <span class="composer-completion-title" title={props.title}>
        {props.title}
      </span>
    </span>
  );
}
