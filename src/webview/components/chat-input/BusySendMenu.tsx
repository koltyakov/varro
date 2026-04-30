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
          <svg
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M8 3v10M3 8h10" />
          </svg>
        </span>
        <span class="busy-menu-label">Add to Queue</span>
        <span class="busy-menu-hint">Enter</span>
      </button>
      <button class="toolbar-popover-item" onClick={props.onSteer}>
        <span class="busy-menu-icon">
          <svg
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M8 2l1.8 4.8H15l-4 3.4 1.6 5L8 12l-4.6 3.2 1.6-5-4-3.4h5.2z" />
          </svg>
        </span>
        <span class="busy-menu-label">Steer with Message</span>
        <span class="busy-menu-hint">{'\u2303'}Enter</span>
      </button>
      <button class="toolbar-popover-item" onClick={props.onStopAndSend}>
        <span class="busy-menu-icon" style={{ color: 'var(--color-vscode-error)' }}>
          <svg
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M2 3l12 10M14 3L2 13" />
          </svg>
        </span>
        <span class="busy-menu-label">Stop and Send</span>
      </button>
    </div>
  );
}
