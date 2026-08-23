import { attachmentIcon } from '../../lib/ui-icons';
import { Tooltip } from '../Tooltip';
import { UiIcon } from '../UiIcon';

export function AttachButton(props: { onAttach: () => void }) {
  return (
    <Tooltip content="Attach files">
      <button class="toolbar-attach-button" onClick={props.onAttach} aria-label="Attach files">
        <UiIcon source={attachmentIcon} width={15} height={15} />
      </button>
    </Tooltip>
  );
}
