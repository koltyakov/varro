import { Portal } from 'solid-js/web';
import { shareIosIcon } from '../../lib/ui-icons';
import { UiIcon } from '../UiIcon';

export function DropOverlay() {
  return (
    <Portal>
      <div class="chat-drop-overlay" aria-hidden="true">
        <div class="chat-drop-overlay-card">
          <div class="chat-drop-overlay-icon">
            <UiIcon source={shareIosIcon} width={22} height={22} />
          </div>
          <div class="chat-drop-overlay-title">Drop to add to context</div>
        </div>
      </div>
    </Portal>
  );
}
