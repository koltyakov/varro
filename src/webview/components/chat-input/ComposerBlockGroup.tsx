import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  flush,
  For,
  onSettled,
  Show,
} from 'solid-js';
import { Portal, type JSX } from '@solidjs/web';
import { ariaBoolean } from '../../lib/aria';
import { checkIcon, pauseIcon, playIcon } from '../../lib/ui-icons';
import { prepareForComposerCollapse } from '../../lib/message-list-layout';
import { observePopupViewport } from '../../lib/popup-position';
import { UiIcon } from '../UiIcon';
import { registerComposerOverlayDismiss } from './composer-overlay-dismiss';

export type ComposerBlockKind = 'queue' | 'goal' | 'todos' | 'background' | 'files';

export type ComposerBlockStatus = 'running' | 'paused' | 'achieved';

export type ComposerBlock = {
  kind: ComposerBlockKind;
  /** Item count shown in the tab, or `null` while the block has nothing to show. */
  count: () => number | null;
  /** Counter text when it differs from the count, such as completed/total todos; `null` hides it. */
  countLabel?: () => string | null;
  /** A dimmed status shown in place of the counter, such as for the goal. */
  status?: () => ComposerBlockStatus | null;
  /** The block stays mounted while another tab is selected so it keeps its own state. */
  render: () => JSX.Element;
};

/** Fewer blocks fit without a menu, so they stay ungrouped. */
const MIN_TABS = 3;

const BLOCK_ORDER: readonly ComposerBlockKind[] = ['queue', 'goal', 'todos', 'background', 'files'];

const STATUS_ICONS: Record<ComposerBlockStatus, string> = {
  running: playIcon,
  paused: pauseIcon,
  achieved: checkIcon,
};

const BLOCK_LABELS: Record<ComposerBlockKind, string> = {
  queue: 'Queue',
  goal: 'Goal',
  todos: 'Todos',
  background: 'Background',
  files: 'Files',
};

/**
 * Shows the blocks above the composer one at a time behind a tab menu. The menu only appears
 * when at least three blocks have content; one or two blocks render exactly as they would ungrouped.
 * A tab is always selected, so the menu never shows without its block. Tabs that do not fit on
 * one line move into a "…" dropdown; the selected tab always stays on the line.
 */
export function ComposerBlockGroup(props: { blocks: readonly ComposerBlock[] }) {
  const id = createUniqueId();
  const panelId = `composer-block-panel-${id}`;
  const tabId = (kind: ComposerBlockKind) => `composer-block-tab-${id}-${kind}`;
  const blockFor = (kind: ComposerBlockKind) => props.blocks.find((block) => block.kind === kind);
  const present = createMemo(() =>
    BLOCK_ORDER.filter((kind) => (blockFor(kind)?.count() ?? null) !== null)
  );
  const tabbed = () => present().length >= MIN_TABS;
  const [selected, setSelected] = createSignal<ComposerBlockKind | null>(null);
  const active = createMemo(() => {
    const kinds = present();
    const choice = selected();
    return choice && kinds.includes(choice) ? choice : (kinds[0] ?? null);
  });
  const [layout, setLayout] = createSignal<TabLayout | null>(null);
  const visibleTabs = createMemo(() => fitTabs(present(), active(), layout()));
  const overflowTabs = createMemo(() => present().filter((kind) => !visibleTabs().includes(kind)));
  const [menuOpen, setMenuOpen] = createSignal(false);
  let groupRef: HTMLDivElement | undefined;
  let panelRef: HTMLDivElement | undefined;
  let menuRowRef: HTMLDivElement | undefined;
  let measureRef: HTMLDivElement | undefined;
  let moreButtonRef: HTMLButtonElement | undefined;

  // A message the user just queued should be visible, not hidden behind another tab.
  createEffect(
    () => blockFor('queue')?.count() ?? 0,
    (count, previous) => {
      if (previous !== undefined && count > previous) setSelected('queue');
    }
  );

  createEffect(
    () => overflowTabs().length,
    (count) => {
      if (count === 0) setMenuOpen(false);
    }
  );

  // Natural tab widths come from an invisible copy of the row, so hidden tabs can be measured.
  const measure = () => {
    if (!menuRowRef || !measureRef) return;
    const rowStyle = getComputedStyle(menuRowRef);
    const available =
      menuRowRef.clientWidth -
      (Number.parseFloat(rowStyle.paddingLeft) || 0) -
      (Number.parseFloat(rowStyle.paddingRight) || 0);
    const widths: Partial<Record<ComposerBlockKind, number>> = {};
    let more = 0;
    for (const element of measureRef.querySelectorAll<HTMLElement>('[data-measure]')) {
      const width = element.getBoundingClientRect().width;
      const key = element.dataset.measure;
      if (key === 'more') more = width;
      else if (isComposerBlockKind(key)) widths[key] = width;
    }
    setLayout({
      available,
      gap: Number.parseFloat(getComputedStyle(measureRef).columnGap) || 0,
      more,
      widths,
    });
  };

  createEffect(
    () => tabbed(),
    (isTabbed) => {
      if (!isTabbed || globalThis.ResizeObserver === undefined) return;
      const row = menuRowRef;
      const copy = measureRef;
      if (!row || !copy) return;
      measure();
      const observer = new ResizeObserver(() => measure());
      observer.observe(row);
      observer.observe(copy);
      return () => observer.disconnect();
    }
  );

  /** Applies a tab change and reserves any height the composer gives back to the transcript. */
  const changeView = (apply: () => void) => {
    const group = groupRef;
    const before = group?.getBoundingClientRect().height ?? 0;
    // Hold the old height while measuring the new view so the transcript cannot clamp first.
    if (group) group.style.minHeight = `${before}px`;
    apply();
    flush();
    if (!group) return;
    const groupTop = group.getBoundingClientRect().top;
    const contentBottom = panelRef?.getBoundingClientRect().bottom ?? groupTop;
    const after =
      contentBottom -
      groupTop +
      (Number.parseFloat(getComputedStyle(group).borderBottomWidth) || 0);
    if (before - after > 0.5) {
      prepareForComposerCollapse(group, before - after);
      flush();
    }
    group.style.minHeight = '';
  };

  const select = (kind: ComposerBlockKind) => {
    if (kind !== active()) changeView(() => setSelected(kind));
  };

  const focusTab = (kind: ComposerBlockKind) => {
    menuRowRef?.querySelector<HTMLElement>(`#${CSS.escape(tabId(kind))}`)?.focus();
  };

  const onTabKeyDown = (event: KeyboardEvent) => {
    const kinds = present();
    const current = active();
    if (!current || kinds.length === 0) return;
    const index = kinds.indexOf(current);
    const next =
      event.key === 'ArrowRight'
        ? kinds[(index + 1) % kinds.length]
        : event.key === 'ArrowLeft'
          ? kinds[(index - 1 + kinds.length) % kinds.length]
          : event.key === 'Home'
            ? kinds[0]
            : event.key === 'End'
              ? kinds[kinds.length - 1]
              : undefined;
    if (!next) return;
    event.preventDefault();
    select(next);
    focusTab(next);
  };

  const tabContent = (kind: ComposerBlockKind) => (
    <TabContent
      label={BLOCK_LABELS[kind]}
      counter={blockFor(kind)?.countLabel?.() ?? String(blockFor(kind)?.count() ?? '')}
      status={blockFor(kind)?.status?.() ?? null}
    />
  );

  return (
    <div
      ref={(element) => {
        groupRef = element;
      }}
      class={`composer-block-group${tabbed() ? ' is-tabbed' : ''}`}
      hidden={present().length === 0}
    >
      <Show when={tabbed()}>
        <div
          ref={(element) => {
            menuRowRef = element;
          }}
          class="composer-block-menu"
        >
          <div
            class="composer-block-tabs"
            role="tablist"
            aria-label="Chat input panels"
            onKeyDown={onTabKeyDown}
          >
            <For each={visibleTabs()}>
              {(kind) => (
                <button
                  type="button"
                  role="tab"
                  id={tabId(kind)}
                  class="composer-block-tab"
                  data-kind={kind}
                  aria-selected={ariaBoolean(active() === kind)}
                  aria-controls={panelId}
                  tabindex={active() === kind ? 0 : -1}
                  onClick={() => select(kind)}
                >
                  {tabContent(kind)}
                </button>
              )}
            </For>
          </div>
          <Show when={overflowTabs().length > 0}>
            <button
              ref={(element) => {
                moreButtonRef = element;
              }}
              type="button"
              class="composer-block-tab composer-block-more"
              aria-label="More panels"
              aria-haspopup="menu"
              aria-expanded={ariaBoolean(menuOpen())}
              onClick={() => setMenuOpen((open) => !open)}
            >
              …
            </button>
          </Show>
          <div
            ref={(element) => {
              measureRef = element;
            }}
            class="composer-block-tabs composer-block-tabs-measure"
            aria-hidden="true"
          >
            <For each={present()}>
              {(kind) => (
                <span class="composer-block-tab" data-measure={kind}>
                  {tabContent(kind)}
                </span>
              )}
            </For>
            <span class="composer-block-tab composer-block-more" data-measure="more">
              …
            </span>
          </div>
        </div>
      </Show>
      <Show when={menuOpen() && moreButtonRef}>
        {(anchor) => (
          <OverflowMenu
            anchor={anchor()}
            kinds={overflowTabs()}
            content={tabContent}
            onSelect={(kind) => {
              setMenuOpen(false);
              select(kind);
              focusTab(kind);
            }}
            onClose={(restoreFocus) => {
              setMenuOpen(false);
              if (restoreFocus) moreButtonRef?.focus();
            }}
          />
        )}
      </Show>
      <div
        ref={(element) => {
          panelRef = element;
        }}
        id={panelId}
        class="composer-block-panel"
        role={tabbed() ? 'tabpanel' : undefined}
        aria-labelledby={tabbed() && active() ? tabId(active()!) : undefined}
      >
        <For each={props.blocks}>
          {(block) => (
            <div
              class="composer-block-slot"
              data-kind={block.kind}
              hidden={tabbed() && active() !== block.kind}
            >
              {block.render()}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

type TabLayout = {
  available: number;
  gap: number;
  more: number;
  widths: Partial<Record<ComposerBlockKind, number>>;
};

/** Keeps tabs in order until one no longer fits beside the selected tab and the "…" button. */
function fitTabs(
  kinds: ComposerBlockKind[],
  active: ComposerBlockKind | null,
  layout: TabLayout | null
): ComposerBlockKind[] {
  if (!layout || !active) return kinds;
  const width = (kind: ComposerBlockKind) => layout.widths[kind] ?? 0;
  const total = kinds.reduce((sum, kind) => sum + width(kind), 0) + layout.gap * (kinds.length - 1);
  if (total <= layout.available) return kinds;
  const shown = new Set<ComposerBlockKind>([active]);
  let used = width(active) + layout.gap + layout.more;
  for (const kind of kinds) {
    if (kind === active) continue;
    if (used + layout.gap + width(kind) > layout.available) break;
    shown.add(kind);
    used += layout.gap + width(kind);
  }
  return kinds.filter((kind) => shown.has(kind));
}

function isComposerBlockKind(value: string | undefined): value is ComposerBlockKind {
  return BLOCK_ORDER.some((kind) => kind === value);
}

function TabContent(props: {
  label: string;
  counter: string | null;
  status: ComposerBlockStatus | null;
}) {
  const icon = () =>
    props.status ? { source: STATUS_ICONS[props.status], label: props.status } : null;
  const text = () => (props.status ? null : props.counter);
  return (
    <>
      <span class="composer-block-tab-label">{props.label}</span>
      <Show
        when={icon()}
        fallback={
          <Show when={text()}>
            {(counter) => (
              <>
                {' '}
                <span class="composer-block-tab-count">{counter()}</span>
              </>
            )}
          </Show>
        }
      >
        {(status) => (
          <UiIcon
            source={status().source}
            class="composer-block-tab-status"
            width={12}
            height={12}
            role="img"
            aria-label={status().label}
          />
        )}
      </Show>
    </>
  );
}

function OverflowMenu(props: {
  anchor: HTMLElement;
  kinds: ComposerBlockKind[];
  content: (kind: ComposerBlockKind) => JSX.Element;
  onSelect: (kind: ComposerBlockKind) => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  let menu: HTMLDivElement | undefined;
  const position = () => {
    if (!menu) return;
    const margin = 8;
    const anchor = props.anchor.getBoundingClientRect();
    const rect = menu.getBoundingClientRect();
    const left = Math.min(anchor.right - rect.width, window.innerWidth - margin - rect.width);
    menu.style.left = `${Math.max(margin, left)}px`;
    menu.style.top = `${anchor.bottom + 4}px`;
  };
  onSettled(() => {
    const cleanups: Array<() => void> = [];
    if (menu) {
      position();
      cleanups.push(observePopupViewport(menu, position));
      menu.querySelector<HTMLButtonElement>('button')?.focus();
    }
    const outside = (event: Event) => {
      if (!(event.target instanceof Node)) return;
      if (menu?.contains(event.target) || props.anchor.contains(event.target)) return;
      props.onClose(false);
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('focusin', outside);
    cleanups.push(registerComposerOverlayDismiss(() => props.onClose(false)));
    cleanups.push(() => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('focusin', outside);
    });
    return () => {
      for (const cleanup of cleanups.toReversed()) cleanup();
    };
  });
  return (
    <Portal>
      <div
        ref={(element) => {
          menu = element;
        }}
        class="session-item-actions-menu composer-block-overflow-menu"
        role="menu"
        aria-label="More panels"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            props.onClose(true);
            return;
          }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const items = Array.from(menu?.querySelectorAll<HTMLButtonElement>('button') ?? []);
          const index = items.findIndex((item) => item === document.activeElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}
      >
        <For each={props.kinds}>
          {(kind) => (
            <button
              type="button"
              role="menuitem"
              class="composer-block-overflow-item"
              data-kind={kind}
              onClick={() => props.onSelect(kind)}
            >
              {props.content(kind)}
            </button>
          )}
        </For>
      </div>
    </Portal>
  );
}
