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
      title={copied() ? 'Copied' : `Copy ${props.label}`}
      aria-label={copied() ? 'Copied' : `Copy ${props.label}: ${props.text}`}
      onClick={() => void handleCopy()}
    >
      <Show
        when={copied()}
        fallback={
          <svg
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
            <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1" />
          </svg>
        }
      >
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
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
