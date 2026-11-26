import { postMessage } from '../lib/bridge';
import { openNewWindowIcon } from '../lib/ui-icons';
import { Tooltip } from './Tooltip';
import { UiIcon } from './UiIcon';

/**
 * Companion to CopyIconButton for rows that render their value on a single
 * ellipsized line: copy recovers the text, this reads it in a read-only editor
 * tab. Shares the copy button's hover and focus reveal.
 */
export function OpenTextIconButton(props: {
  content: string;
  /** Names the editor tab. */
  title: string;
  label: string;
  language?: string;
}) {
  const open = () => {
    postMessage({
      type: 'vscode/open-text',
      payload: { content: props.content, title: props.title, language: props.language },
    });
  };

  return (
    <Tooltip content={`Open ${props.label} in an editor tab`} delay={500}>
      <button
        type="button"
        class="tool-open-button"
        aria-label={`Open ${props.label} in an editor tab`}
        onClick={open}
      >
        <UiIcon source={openNewWindowIcon} width={12} height={12} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
