import { Show } from 'solid-js';
import { DocumentIcon } from '../DocumentIcon';
import { FolderIcon } from '../FolderIcon';

export type InlineChipData = {
  id: string;
  type: 'mention-file' | 'mention-agent' | 'image';
  label: string;
  title?: string;
  detail?: string;
  icon?: 'file' | 'folder' | 'image' | 'terminal' | 'agent';
  disabled?: boolean;
};

export function InlineChip(props: { data: InlineChipData }) {
  return (
    <span
      class={`inline-chip${props.data.disabled ? ' disabled' : ''}`}
      contentEditable={false}
      data-chip-id={props.data.id}
      data-chip-type={props.data.type}
      title={props.data.title || props.data.label}
    >
      <Show when={props.data.icon === 'image'}>
        <svg
          class="inline-chip-icon"
          viewBox="0 0 16 16"
          fill="currentColor"
          width="11"
          height="11"
        >
          <path d="M14.5 2h-13a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h13a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5zM2 3h12v7.3l-2.6-2.6a.5.5 0 00-.7 0L7.5 11 5.9 9.4a.5.5 0 00-.7 0L2 12.6V3zm3.5 4a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
        </svg>
      </Show>
      <Show when={props.data.icon === 'folder'}>
        <FolderIcon class="inline-chip-icon" width="11" height="11" />
      </Show>
      <Show when={props.data.icon === 'agent'}>
        <svg
          class="inline-chip-icon"
          viewBox="0 0 16 16"
          fill="currentColor"
          width="11"
          height="11"
        >
          <path d="M8 1a3 3 0 00-3 3v1H4a2 2 0 00-2 2v6a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-1V4a3 3 0 00-3-3zm1 4V4a1 1 0 10-2 0v1h2zM6 9a1 1 0 11-2 0 1 1 0 012 0zm5 1a1 1 0 100-2 1 1 0 000 2z" />
        </svg>
      </Show>
      <Show when={!props.data.icon || props.data.icon === 'file'}>
        <DocumentIcon class="inline-chip-icon" width="11" height="11" />
      </Show>
      <span class="inline-chip-label">{props.data.label}</span>
      <Show when={props.data.detail}>
        <span class="inline-chip-detail">{props.data.detail}</span>
      </Show>
    </span>
  );
}
