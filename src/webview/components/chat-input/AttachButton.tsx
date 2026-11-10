import { attachmentIcon } from '../../lib/ui-icons';
import { hostMetadata } from '../../host/extensions';
import { Tooltip } from '../Tooltip';
import { UiIcon } from '../UiIcon';

export function AttachButton(props: { onAttach: () => void }) {
  return (
    <Tooltip
      content={
        hostMetadata().ideName === 'VS Code'
          ? 'Attach files or folders. For drag and drop, hold Shift before entering VS Code.'
          : 'Attach files or folders'
      }
    >
      <button class="toolbar-attach-button" onClick={props.onAttach} aria-label="Attach files">
        <UiIcon source={attachmentIcon} width={15} height={15} />
      </button>
    </Tooltip>
  );
}
