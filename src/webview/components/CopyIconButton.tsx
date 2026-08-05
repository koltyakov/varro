import { Show, createSignal, onCleanup } from 'solid-js';
import { writeClipboard } from '../lib/write-clipboard';

/**
 * Copy affordance for tool detail rows that render their value on a single
 * ellipsized line. The row deliberately hides the tail of long values, so this
 * is what keeps them recoverable — it is not decoration.
 *
 * Hidden until the row is hovered, but focus reveals it too: an invisible
 * focusable control is a keyboard trap.
 */
export function CopyIconButton(props: { text: string; label: string }) {
  const [copied, setCopied] = createSignal(false);
  let copyTimeout: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => clearTimeout(copyTimeout));

  const handleCopy = async () => {
    if (!(await writeClipboard(props.text))) return;
    setCopied(true);
    clearTimeout(copyTimeout);
    copyTimeout = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      class="tool-copy-button"
      classList={{ 'is-copied': copied() }}
      title={copied() ? 'Copied' : `Copy ${props.label}`}
      aria-label={copied() ? 'Copied' : `Copy ${props.label}: ${props.text}`}
      onClick={() => void handleCopy()}
    >
      <Show
        when={copied()}
        fallback={
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M19.4 20H9.6C9.26863 20 9 19.7314 9 19.4V9.6C9 9.26863 9.26863 9 9.6 9H19.4C19.7314 9 20 9.26863 20 9.6V19.4C20 19.7314 19.7314 20 19.4 20Z" />
            <path d="M15 9V4.6C15 4.26863 14.7314 4 14.4 4H4.6C4.26863 4 4 4.26863 4 4.6V14.4C4 14.7314 4.26863 15 4.6 15H9" />
          </svg>
        }
      >
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M3 8.5l3.5 3.5L13 5" />
        </svg>
      </Show>
    </button>
  );
}
