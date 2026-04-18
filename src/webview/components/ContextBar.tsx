import { Show, For } from 'solid-js';
import {
  state,
  removeClipboardImage,
  removeContextFile,
  clearClipboardImages,
  clearContextFiles,
} from '../lib/state';
import { getLeafPathName } from '../lib/path-display';

export function ContextBar() {
  const files = () => state.droppedFiles;
  const clipboardImages = () => state.clipboardImages;
  const selection = () => state.editorContext.selection;
  const activeFile = () => state.editorContext.activeFile;
  const hasContext = () => files().length > 0 || clipboardImages().length > 0 || !!selection();
  const activeContext = () => {
    const file = activeFile();
    if (!file) return null;

    const selectedLines = selection();
    if (!selectedLines) {
      return { filename: getLeafPathName(file.relativePath), lineRange: null as string | null };
    }

    const lineRange =
      selectedLines.startLine === selectedLines.endLine
        ? `L${selectedLines.startLine}`
        : `L${selectedLines.startLine}-${selectedLines.endLine}`;

    return { filename: getLeafPathName(file.relativePath), lineRange };
  };

  return (
    <Show when={hasContext()}>
      <div class="flex items-center gap-1.5 px-3 py-1.5">
        <div class="flex flex-1 flex-wrap gap-1 overflow-hidden">
          <Show when={activeContext()}>
            <ContextChip
              label={activeContext()!.filename}
              detail={activeContext()!.lineRange}
              title={
                activeContext()!.lineRange
                  ? `${activeContext()!.filename} ${activeContext()!.lineRange}`
                  : activeContext()!.filename
              }
            />
          </Show>
          <For each={files()}>
            {(file) => (
              <ContextChip
                label={getDroppedFileLabel(file)}
                title={file.relativePath || file.path}
                icon={file.type === 'directory' ? 'folder' : 'file'}
                onRemove={files().length > 0 ? () => removeContextFile(file.path) : undefined}
              />
            )}
          </For>
          <For each={clipboardImages()}>
            {(image) => (
              <ImageContextChip image={image} onRemove={() => removeClipboardImage(image.id)} />
            )}
          </For>
        </div>
        <div class="flex items-center">
          <Show when={clipboardImages().length > 0}>
            <button
              class="flex h-[20px] w-[20px] items-center justify-center rounded text-vscode-muted/40 transition-colors hover:bg-vscode-hover hover:text-vscode-error"
              onClick={clearClipboardImages}
              title="Clear pasted images"
            >
              <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
                <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
              </svg>
            </button>
          </Show>
          <Show when={files().length > 0}>
            <button
              class="flex h-[20px] w-[20px] items-center justify-center rounded text-vscode-muted/40 transition-colors hover:bg-vscode-hover hover:text-vscode-error"
              onClick={clearContextFiles}
              title="Clear dropped files"
            >
              <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
                <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
              </svg>
            </button>
          </Show>
        </div>
      </div>
    </Show>
  );
}

function ContextChip(props: {
  label: string;
  detail?: string | null;
  title?: string;
  icon?: 'file' | 'folder';
  onRemove?: () => void;
}) {
  return (
    <span
      class="inline-flex min-w-0 items-center gap-1 rounded border border-vscode-border/30 bg-vscode-card/30 px-2 py-0.5 text-[11px] text-vscode-fg"
      title={props.title}
    >
      <Show
        when={props.icon === 'folder'}
        fallback={
          <svg
            class="h-3 w-3 shrink-0 text-vscode-muted/60"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M9.5 1.1l3.4 3.5.1.4v10c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1h5.1l.4.1z" />
          </svg>
        }
      >
        <svg class="h-3 w-3 shrink-0 text-vscode-muted/60" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.75 3A1.75 1.75 0 000 4.75v6.5C0 12.22.78 13 1.75 13h12.5c.97 0 1.75-.78 1.75-1.75V5.75C16 4.78 15.22 4 14.25 4H8.41L6.7 2.29A1 1 0 005.99 2H1.75z" />
        </svg>
      </Show>
      <span class="max-w-[140px] truncate">{props.label}</span>
      <Show when={props.detail}>
        <span class="shrink-0 text-vscode-muted/60">{props.detail}</span>
      </Show>
      <Show when={props.onRemove}>
        <button
          class="ml-0.5 text-vscode-muted/30 transition-colors hover:text-vscode-error"
          onClick={() => props.onRemove?.()}
        >
          <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
          </svg>
        </button>
      </Show>
    </span>
  );
}

function getDroppedFileLabel(file: { path: string; relativePath: string }) {
  if (!file.relativePath || file.relativePath === '.') {
    return getLeafPathName(file.path);
  }
  return getLeafPathName(file.relativePath);
}

function ImageContextChip(props: {
  image: { url: string; filename: string; size: number };
  onRemove?: () => void;
}) {
  return (
    <span
      class="inline-flex min-w-0 items-center gap-1.5 rounded border border-vscode-border/30 bg-vscode-card/30 px-2 py-0.5 text-[11px] text-vscode-fg"
      title={`${props.image.filename} · ${formatImageSize(props.image.size)}`}
    >
      <img
        src={props.image.url}
        alt={props.image.filename}
        class="h-5 w-5 shrink-0 rounded border border-vscode-border/20 object-cover"
      />
      <span class="max-w-[120px] truncate">{props.image.filename}</span>
      <span class="text-vscode-muted/60">{formatImageSize(props.image.size)}</span>
      <Show when={props.onRemove}>
        <button
          class="ml-0.5 text-vscode-muted/30 transition-colors hover:text-vscode-error"
          onClick={() => props.onRemove?.()}
        >
          <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
          </svg>
        </button>
      </Show>
    </span>
  );
}

function formatImageSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size >= 100 * 1024 ? 0 : 1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
