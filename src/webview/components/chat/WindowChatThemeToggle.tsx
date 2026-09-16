import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import {
  toggleWindowChatTheme,
  windowChatTheme,
  windowChatThemeReversed,
} from '../../lib/window-chat-theme';
import { Tooltip } from '../Tooltip';

function label() {
  const theme = windowChatTheme();
  if (!theme?.counterpart) return 'This theme has no matching light/dark counterpart';
  return `Switch this chat to ${windowChatThemeReversed() ? theme.source : theme.counterpart.name}`;
}

export function WindowChatThemeToggle() {
  return (
    <Show when={windowChatTheme()}>
      <FloatingThemeButton />
    </Show>
  );
}

function FloatingThemeButton() {
  const [hasRoom, setHasRoom] = createSignal(false);
  let toolbar!: HTMLDivElement;
  onMount(() => {
    const root = toolbar.closest('.interactive-session');
    if (!root) return;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const column = root.querySelector('.interactive-list-track');
      const contentPadding = parseFloat(
        getComputedStyle(root).getPropertyValue('--chat-horizontal-padding')
      );
      // Keep the toggle entirely in the outer gutter, clear of messages and sticky headers.
      setHasRoom(
        !!column &&
          toolbar.getBoundingClientRect().left >=
            column.getBoundingClientRect().right - contentPadding + 8
      );
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(sync);
    };
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(root);
    const column = root.querySelector('.interactive-list-track');
    if (column) resizeObserver.observe(column);
    window.addEventListener('resize', schedule);
    sync();
    onCleanup(() => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', schedule);
    });
  });
  return (
    <div
      ref={(element) => {
        toolbar = element;
      }}
      class="window-chat-theme-toolbar"
      classList={{ 'is-occluded': !hasRoom() }}
      aria-hidden={!hasRoom()}
    >
      <Tooltip content={label()}>
        <button
          type="button"
          class="chat-header-btn"
          disabled={!windowChatTheme()?.counterpart}
          aria-label={label()}
          aria-pressed={windowChatThemeReversed()}
          onClick={toggleWindowChatTheme}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" />
            <path d="M8 2a6 6 0 0 1 0 12Z" fill="currentColor" />
          </svg>
        </button>
      </Tooltip>
    </div>
  );
}
