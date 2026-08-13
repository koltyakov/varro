import { For } from 'solid-js';
import type { ClipboardImage, NativePdfAttachment } from '../../lib/app-state-types';
import type { DroppedFile } from '../../../shared/protocol';
import { formatContextLineRanges } from '../../../shared/context-files';
import { getDroppedFileLabel } from '../../lib/path-display';
import { AttachmentChip } from './AttachmentChip';

type AttachmentStripItem =
  | { type: 'active-context'; value: ActiveContextAttachment }
  | { type: 'terminal-selection'; value: TerminalSelectionAttachment }
  | { type: 'diagnostics'; value: { count: number; total: number } }
  | { type: 'file'; value: DroppedFile }
  | { type: 'clipboard-image'; value: ClipboardImage }
  | { type: 'native-pdf'; value: NativePdfAttachment };

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
  diagnostics: { count: number; total: number } | null;
  files: DroppedFile[];
  clipboardImages: ClipboardImage[];
  nativePdfs: NativePdfAttachment[];
  nativePdfsSupported: boolean;
  clipboardImagesDisabled: boolean;
  onToggleActiveContext: () => void;
  onClearTerminalSelection: () => void;
  onClearDiagnostics: () => void;
  onRemoveFile: (path: string) => void;
  onRemoveClipboardImage: (id: string) => void;
  onRemoveNativePdf: (id: string) => void;
  onOpenFile?: (file: DroppedFile) => void;
  onPreviewImage?: (image: ClipboardImage) => void;
}) {
  const orderedAttachments = (): AttachmentStripItem[] =>
    [
      ...(props.activeContext
        ? [{ type: 'active-context' as const, value: props.activeContext }]
        : []),
      ...(props.terminalSelection
        ? [{ type: 'terminal-selection' as const, value: props.terminalSelection }]
        : []),
      ...(props.diagnostics ? [{ type: 'diagnostics' as const, value: props.diagnostics }] : []),
      ...props.files.map((file) => ({ type: 'file' as const, value: file })),
      ...props.clipboardImages.map((image) => ({ type: 'clipboard-image' as const, value: image })),
      ...props.nativePdfs.map((pdf) => ({ type: 'native-pdf' as const, value: pdf })),
    ].toSorted((a, b) => getAttachmentSequence(a) - getAttachmentSequence(b));

  return (
    <div class="chat-attachments-container">
      <For each={orderedAttachments()}>
        {(item) => {
          if (item.type === 'active-context') {
            return (
              <AttachmentChip
                label={item.value.filename}
                detail={item.value.lineRange}
                disabled={!props.activeContextEnabled}
                title={props.activeContextTitle || item.value.filename}
                toggle
                onClick={props.onToggleActiveContext}
              />
            );
          }

          if (item.type === 'terminal-selection') {
            return (
              <AttachmentChip
                label={item.value.terminalName}
                detail="terminal"
                icon="terminal"
                title={`Terminal: ${item.value.terminalName}`}
                onRemove={props.onClearTerminalSelection}
              />
            );
          }

          if (item.type === 'diagnostics') {
            return (
              <AttachmentChip
                label="Problems"
                detail={`${item.value.count}${item.value.total > item.value.count ? ` of ${item.value.total}` : ''}`}
                icon="warning"
                title={`${item.value.count} attached diagnostics`}
                onRemove={props.onClearDiagnostics}
              />
            );
          }

          if (item.type === 'file') {
            const lineRange = formatContextLineRanges(item.value.lineRanges);
            return (
              <AttachmentChip
                label={getDroppedFileLabel(item.value)}
                detail={lineRange}
                icon={item.value.type === 'directory' ? 'folder' : 'file'}
                title={
                  lineRange
                    ? `${item.value.relativePath || item.value.path} ${lineRange}`
                    : item.value.relativePath || item.value.path
                }
                onClick={props.onOpenFile ? () => props.onOpenFile?.(item.value) : undefined}
                onRemove={() => props.onRemoveFile(item.value.path)}
              />
            );
          }

          if (item.type === 'clipboard-image')
            return (
              <AttachmentChip
                label={item.value.filename}
                disabled={props.clipboardImagesDisabled}
                icon="image"
                title={
                  props.clipboardImagesDisabled
                    ? `${item.value.filename} · Current model doesn't support vision, so this image will not be sent`
                    : item.value.filename
                }
                onClick={
                  props.onPreviewImage ? () => props.onPreviewImage?.(item.value) : undefined
                }
                onRemove={() => props.onRemoveClipboardImage(item.value.id)}
                previewImage={{ url: item.value.url, alt: item.value.filename }}
              />
            );
          return (
            <AttachmentChip
              label={item.value.filename}
              detail={props.nativePdfsSupported ? 'PDF' : undefined}
              icon={props.nativePdfsSupported ? undefined : 'file'}
              title={
                props.nativePdfsSupported
                  ? item.value.filename
                  : item.value.contextFile?.relativePath || item.value.filename
              }
              onClick={
                !props.nativePdfsSupported && item.value.contextFile && props.onOpenFile
                  ? () => props.onOpenFile?.(item.value.contextFile!)
                  : undefined
              }
              onRemove={() => props.onRemoveNativePdf(item.value.id)}
            />
          );
        }}
      </For>
    </div>
  );
}

function getAttachmentSequence(item: AttachmentStripItem) {
  switch (item.type) {
    case 'active-context':
      return -2;
    case 'terminal-selection':
      return -1;
    case 'diagnostics':
      return 0;
    case 'file':
      return item.value.attachmentSequence ?? Number.MAX_SAFE_INTEGER;
    case 'clipboard-image':
      return item.value.attachmentSequence ?? Number.MAX_SAFE_INTEGER;
    case 'native-pdf':
      return item.value.attachmentSequence ?? Number.MAX_SAFE_INTEGER;
  }
}
