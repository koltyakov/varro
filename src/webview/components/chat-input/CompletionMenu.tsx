import { For, Show, createEffect, onCleanup, onMount } from 'solid-js';
import { FileTypeIcon } from '../FileTypeIcon';
import { FolderIcon } from '../FolderIcon';
import { MaterialChipIcon } from '../MaterialChipIcon';
import { ProblemsIcon } from '../ProblemsIcon';
import {
  clampPopupToViewport,
  flipPopupDownIfNeeded,
  getPopupTopBound,
  observePopupViewport,
} from '../../lib/popup-position';
import type {
  DroppedFile,
  DatabaseTableReference,
  EditorDiagnostic,
} from '../../../shared/protocol';
import type { Session } from '../../types';
import { formatRelativeAge } from '../../lib/message-metrics';

const COMPLETION_MENU_EDGE_INSET = 4;

export type MentionCompletionItem =
  | {
      key: string;
      type: 'table';
      label: string;
      detail: string;
      value: string;
      table: DatabaseTableReference;
    }
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
  acceptsArguments?: boolean;
  source?: 'command' | 'mcp' | 'skill';
  action: (args: string) => void | Promise<void>;
};

export type CompletionItem =
  | {
      key: string;
      type: 'problems';
      label: string;
      detail: string;
      diagnostic: EditorDiagnostic | null;
      severity?: EditorDiagnostic['severity'];
    }
  | (SlashCommand & { key: string; type: 'slash' | 'skill' })
  | MentionCompletionItem;

export function CompletionMenu(props: {
  items: CompletionItem[];
  selectedIndex: number;
  onSelect: (item: CompletionItem) => void;
  header?: string;
  emptyMessage?: string;
  anchorRect?: () => DOMRect | null;
}) {
  // oxlint-disable-next-line no-unassigned-vars
  let menuRef: HTMLDivElement | undefined;
  const itemRefs = new Map<string, HTMLButtonElement>();

  function updateScrollbarInset() {
    if (!menuRef) return;
    const borderWidth = menuRef.clientLeft * 2;
    const scrollbarInset = Math.max(0, menuRef.offsetWidth - menuRef.clientWidth - borderWidth);
    menuRef.style.setProperty('--composer-completion-scrollbar-inset', `${scrollbarInset}px`);
  }

  function reposition() {
    if (!menuRef) return;
    const caret = props.anchorRect?.();
    const host = menuRef.offsetParent;
    if (caret && host instanceof HTMLElement) {
      const bottom = caret.top - 6;
      menuRef.style.top = 'auto';
      menuRef.style.bottom = `${host.getBoundingClientRect().bottom - bottom}px`;
      menuRef.style.transform = '';
      menuRef.style.maxHeight = `${Math.min(220, Math.max(0, bottom - getPopupTopBound(menuRef, 8)))}px`;
    } else {
      flipPopupDownIfNeeded(menuRef);
      clampPopupToViewport(menuRef);
    }
    updateScrollbarInset();
  }

  createEffect(() => {
    props.anchorRect?.();
    queueMicrotask(reposition);
  });

  createEffect(() => {
    const items = props.items;
    const activeKeys = new Set(items.map((item) => item.key));
    for (const key of itemRefs.keys()) {
      if (!activeKeys.has(key)) itemRefs.delete(key);
    }
  });

  createEffect(() => {
    void props.items;
    queueMicrotask(updateScrollbarInset);
  });

  createEffect(() => {
    const idx = props.selectedIndex;
    const selectedItem = props.items[idx];
    const el = selectedItem ? itemRefs.get(selectedItem.key) : undefined;
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

    onCleanup(observePopupViewport(menuRef, reposition));
    document.addEventListener('selectionchange', reposition);
    document.addEventListener('scroll', reposition, true);
    const observer = globalThis.ResizeObserver ? new ResizeObserver(reposition) : undefined;
    if (menuRef.parentElement) observer?.observe(menuRef.parentElement);
    onCleanup(() => {
      document.removeEventListener('selectionchange', reposition);
      document.removeEventListener('scroll', reposition, true);
      observer?.disconnect();
    });
  });

  return (
    <div class="composer-completion-menu" ref={menuRef}>
      <Show when={props.header}>
        <div class="composer-completion-header">{props.header}</div>
      </Show>
      <Show when={props.items.length === 0 && props.emptyMessage}>
        <div class="composer-completion-empty" role="status">
          {props.emptyMessage}
        </div>
      </Show>
      <For each={props.items}>
        {(item, index) => {
          const isSlash = item.type === 'slash' || item.type === 'skill';
          const isSkill =
            item.type === 'skill' || (item.type === 'slash' && item.source === 'skill');
          const title = () =>
            'name' in item
              ? `${isSkill ? (props.header === 'Skills' ? '' : '/skill:') : '/'}${item.name}`
              : item.label;
          const detail =
            item.type === 'session'
              ? `${item.detail ? `${item.detail} · ` : ''}${formatRelativeAge(item.session.time.updated, Date.now())}`
              : 'description' in item
                ? item.description
                : item.detail;
          return (
            <button
              ref={(el) => itemRefs.set(item.key, el)}
              class={`composer-completion-item completion-${isSlash ? 'slash' : item.type} ${props.selectedIndex === index() ? 'selected' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => props.onSelect(item)}
            >
              <Show when={!isSlash || (isSkill && props.header === 'Skills')}>
                <span class="composer-completion-icon">
                  <Show
                    when={item.type === 'agent'}
                    fallback={
                      isSkill ? (
                        <MaterialChipIcon kind="skill" class="completion-skill-icon" />
                      ) : item.type === 'session' ? (
                        <MaterialChipIcon kind="session" class="completion-session-icon" />
                      ) : item.type === 'problems' ? (
                        <ProblemsIcon severity={item.diagnostic?.severity ?? item.severity} />
                      ) : item.type === 'table' ? (
                        <MaterialChipIcon kind="table" class="completion-file-type-icon" />
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
              <CompletionTitle title={title()} />
              <span
                class={`composer-completion-detail${item.type === 'session' ? ' composer-completion-age' : ''}`}
                title={item.type === 'session' ? item.session.directory : detail}
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
