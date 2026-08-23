import { transitionUpIcon, transitionUpSolidIcon, xmarkIcon } from '../../lib/ui-icons';
import { UiIcon } from '../UiIcon';

export function BusySendMenu(props: {
  ref?: HTMLDivElement | ((el: HTMLDivElement) => void);
  onQueue: () => void;
  onSteer: () => void;
  onStopAndSend: () => void;
}) {
  return (
    <div ref={props.ref} class="toolbar-popover busy-menu" onClick={(e) => e.stopPropagation()}>
      <button class="toolbar-popover-item" onClick={props.onQueue}>
        <span class="busy-menu-icon">
          <UiIcon source={transitionUpIcon} width={14} height={14} />
        </span>
        <span class="busy-menu-label">Add to Queue</span>
        <span class="busy-menu-hint">Enter</span>
      </button>
      <button class="toolbar-popover-item" onClick={props.onSteer}>
        <span class="busy-menu-icon">
          <UiIcon source={transitionUpSolidIcon} width={14} height={14} />
        </span>
        <span class="busy-menu-label">Steer with Message</span>
        <span class="busy-menu-hint">{'\u2303'}Enter</span>
      </button>
      <button class="toolbar-popover-item" onClick={props.onStopAndSend}>
        <span class="busy-menu-icon" style={{ color: 'var(--color-vscode-error)' }}>
          <UiIcon source={xmarkIcon} width={14} height={14} />
        </span>
        <span class="busy-menu-label">Stop and Send</span>
      </button>
    </div>
  );
}
