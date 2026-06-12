import { Show } from 'solid-js';
import { DocumentIcon } from '../DocumentIcon';
import { FolderIcon } from '../FolderIcon';

export function AttachmentChip(props: {
  label: string;
  detail?: string | null;
  disabled?: boolean;
  icon?: 'file' | 'folder' | 'image' | 'terminal';
  toggle?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  title?: string;
}) {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!props.onClick) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    props.onClick();
  };

  return (
    <span
      class={`chat-attachment-chip${props.disabled ? ' disabled' : ''}${props.onClick ? ' clickable' : ''}`}
      title={props.title}
      aria-disabled={props.disabled ? 'true' : undefined}
      aria-pressed={
        props.onClick && props.toggle ? (!props.disabled ? 'true' : 'false') : undefined
      }
      role={props.onClick ? 'button' : undefined}
      tabIndex={props.onClick ? 0 : undefined}
      onClick={() => props.onClick?.()}
      onKeyDown={handleKeyDown}
    >
      <Show when={props.onRemove}>
        <button
          class="chip-remove"
          onClick={(e) => {
            e.stopPropagation();
            props.onRemove?.();
          }}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
          </svg>
        </button>
      </Show>
      <Show when={props.icon === 'image'}>
        <svg class="chip-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M14.5 2h-13a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h13a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5zM2 3h12v7.3l-2.6-2.6a.5.5 0 00-.7 0L7.5 11 5.9 9.4a.5.5 0 00-.7 0L2 12.6V3zm3.5 4a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
        </svg>
      </Show>
      <Show when={props.icon === 'folder'}>
        <FolderIcon class="chip-icon" width="12" height="12" />
      </Show>
      <Show when={props.icon === 'terminal'}>
        <svg class="chip-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M1.75 2h12.5c.97 0 1.75.78 1.75 1.75v8.5c0 .97-.78 1.75-1.75 1.75H1.75A1.75 1.75 0 010 12.25v-8.5C0 2.78.78 2 1.75 2zm0 1a.75.75 0 00-.75.75v8.5c0 .41.34.75.75.75h12.5a.75.75 0 00.75-.75v-8.5a.75.75 0 00-.75-.75H1.75zm2.03 2.22a.75.75 0 011.06 0L6.56 6.94 4.84 8.66a.75.75 0 11-1.06-1.06L4.44 7 3.78 6.28a.75.75 0 010-1.06zM8 8.25h4a.75.75 0 010 1.5H8a.75.75 0 010-1.5z" />
        </svg>
      </Show>
      <Show when={props.icon !== 'image' && props.icon !== 'folder' && props.icon !== 'terminal'}>
        <DocumentIcon class="chip-icon" width="12" height="12" />
      </Show>
      <span class="chip-label">{props.label}</span>
      <Show when={props.detail}>
        <span class="chip-detail">{props.detail}</span>
      </Show>
    </span>
  );
}
