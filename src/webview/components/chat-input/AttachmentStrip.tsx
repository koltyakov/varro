import { For, Show } from 'solid-js';
import type { ClipboardImage } from '../../lib/state';
import type { DroppedFile } from '../../../shared/protocol';
import { formatContextLineRanges } from '../../../shared/context-files';
import { getDroppedFileLabel } from '../../lib/path-display';
import { AttachmentChip } from './AttachmentChip';

type ActiveContextAttachment = {
  filename: string;
  lineRange: string | null;
};

type TerminalSelectionAttachment = {
  terminalName: string;
};

export function AttachmentStrip(props: {
  activeContext: ActiveContextAttachment | null;
  activeContextEnabled: boolean;
  activeContextTitle: string | null;
  terminalSelection: TerminalSelectionAttachment | null;
  files: DroppedFile[];
  clipboardImages: ClipboardImage[];
  clipboardImagesDisabled: boolean;
  onToggleActiveContext: () => void;
  onClearTerminalSelection: () => void;
  onRemoveFile: (path: string) => void;
  onRemoveClipboardImage: (id: string) => void;
}) {
  return (
    <div class="chat-attachments-container">
      <Show when={props.activeContext}>
        {(activeContext) => (
          <AttachmentChip
            label={activeContext().filename}
            detail={activeContext().lineRange}
            disabled={!props.activeContextEnabled}
            title={props.activeContextTitle || activeContext().filename}
            onClick={props.onToggleActiveContext}
          />
        )}
      </Show>
      <Show when={props.terminalSelection}>
        {(terminalSelection) => (
          <AttachmentChip
            label={terminalSelection().terminalName}
            detail="terminal"
            icon="terminal"
            title={`Terminal: ${terminalSelection().terminalName}`}
            onRemove={props.onClearTerminalSelection}
          />
        )}
      </Show>
      <For each={props.files}>
        {(file) => {
          const lineRange = formatContextLineRanges(file.lineRanges);
          return (
            <AttachmentChip
              label={getDroppedFileLabel(file)}
              detail={lineRange}
              icon={file.type === 'directory' ? 'folder' : 'file'}
              title={
                lineRange
                  ? `${file.relativePath || file.path} ${lineRange}`
                  : file.relativePath || file.path
              }
              onRemove={() => props.onRemoveFile(file.path)}
            />
          );
        }}
      </For>
      <For each={props.clipboardImages}>
        {(image) => (
          <AttachmentChip
            label={image.filename}
            disabled={props.clipboardImagesDisabled}
            icon="image"
            title={
              props.clipboardImagesDisabled
                ? `${image.filename} · Current model doesn't support vision, so this image will not be sent`
                : image.filename
            }
            onRemove={() => props.onRemoveClipboardImage(image.id)}
          />
        )}
      </For>
    </div>
  );
}
