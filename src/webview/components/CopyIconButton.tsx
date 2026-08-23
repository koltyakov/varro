import { Show, createSignal, onCleanup } from 'solid-js';
import { writeClipboard } from '../lib/write-clipboard';
import { checkIcon, copyIcon } from '../lib/ui-icons';
import { Tooltip } from './Tooltip';
import { UiIcon } from './UiIcon';

/**
 * Copy affordance for tool detail rows that render their value on a single
 * ellipsized line. The row deliberately hides the tail of long values, so this
 * is what keeps them recoverable - it is not decoration.
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
    <Tooltip content={copied() ? 'Copied' : `Copy ${props.label}`} delay={500}>
      <button
        type="button"
        class="tool-copy-button"
        classList={{ 'is-copied': copied() }}
        aria-label={copied() ? 'Copied' : `Copy ${props.label}: ${props.text}`}
        onClick={() => void handleCopy()}
      >
        <Show
          when={copied()}
          fallback={<UiIcon source={copyIcon} width={12} height={12} aria-hidden="true" />}
        >
          <UiIcon source={checkIcon} width={12} height={12} aria-hidden="true" />
        </Show>
      </button>
    </Tooltip>
  );
}
