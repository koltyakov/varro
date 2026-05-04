import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { DocumentIcon } from '../DocumentIcon';
import type { DroppedFile } from '../../../shared/protocol';

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
    const scrollbarInset = Math.max(0, menuRef.offsetWidth - menuRef.clientWidth);
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
    const viewTop = menuRef.scrollTop;
    const viewBottom = viewTop + menuRef.clientHeight;
    if (elTop < viewTop) {
      menuRef.scrollTop = elTop;
    } else if (elBottom > viewBottom) {
      menuRef.scrollTop = elBottom - menuRef.clientHeight;
    }
  });

  onMount(() => {
    updateScrollbarInset();

    if (typeof ResizeObserver === 'undefined' || !menuRef) return;
    const observer = new ResizeObserver(() => updateScrollbarInset());
    observer.observe(menuRef);
    onCleanup(() => observer.disconnect());
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
          const enableMarquee = item.type === 'file';
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
                    fallback={<DocumentIcon width={14} height={14} />}
                  >
                    <svg width="14" height="14" viewBox="0 0 32 32" aria-hidden="true">
                      <path
                        fill="currentColor"
                        d="M28 12V4h-8v3.546l-6 5.25V11H4v10h10v-1.796l6 5.25V28h8v-8h-8v1.796l-6-5.25v-1.092l6-5.25V12h8zM22 22h4v4h-4v-4zM12 19H6v-6h6v6zM22 6h4v4h-4V6z"
                      />
                    </svg>
                  </Show>
                </span>
              </Show>
              <CompletionTitle title={title} enableMarquee={enableMarquee} />
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

function CompletionTitle(props: { title: string; enableMarquee?: boolean }) {
  let shellRef: HTMLSpanElement | undefined;
  let textRef: HTMLSpanElement | undefined;
  const [overflowDistance, setOverflowDistance] = createSignal(0);

  const measure = () => {
    if (!props.enableMarquee || !shellRef || !textRef) {
      setOverflowDistance(0);
      return;
    }

    const distance = Math.ceil(textRef.scrollWidth - shellRef.clientWidth);
    setOverflowDistance(distance > 1 ? distance : 0);
  };

  onMount(() => {
    queueMicrotask(measure);

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    if (shellRef) observer.observe(shellRef);
    if (textRef) observer.observe(textRef);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    void props.title;
    void props.enableMarquee;
    queueMicrotask(measure);
  });

  return (
    <span class="composer-completion-title-shell" ref={(el) => (shellRef = el)}>
      <span
        ref={(el) => (textRef = el)}
        class={`composer-completion-title ${overflowDistance() > 0 ? 'marquee' : ''}`}
        title={props.title}
        style={
          overflowDistance() > 0
            ? {
                '--marquee-distance': `${overflowDistance()}px`,
                '--marquee-duration': `${Math.max(2.2, 1.2 + overflowDistance() / 90)}s`,
              }
            : undefined
        }
      >
        {props.title}
      </span>
    </span>
  );
}
