import { xmarkIcon } from '../lib/ui-icons';
import { UiIcon } from './UiIcon';

/** Header close button for dialogs that share the `provider-connect-*` dialog chrome. */
export function DialogCloseButton(props: { onClick: () => void }) {
  return (
    <button type="button" class="provider-connect-close" onClick={props.onClick} aria-label="Close">
      <UiIcon source={xmarkIcon} width={16} height={16} aria-hidden="true" />
    </button>
  );
}
