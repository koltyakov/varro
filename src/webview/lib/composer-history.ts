import type { DroppedFile } from '../../shared/protocol';
import type { ClipboardImage } from './app-state-types';

export type ComposerSnapshot = {
  text: string;
  caret: number;
  files: DroppedFile[];
  images: ClipboardImage[];
};

export type ComposerHistoryAction = 'undo' | 'redo';

type ComposerEditKind = 'insert' | 'delete' | 'replace' | 'attachments';

const DEFAULT_MAX_DEPTH = 200;
const DEFAULT_COALESCE_MS = 1000;

export function getComposerHistoryAction(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): ComposerHistoryAction | null {
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'z' && (event.metaKey || event.ctrlKey)) {
    return event.shiftKey ? 'redo' : 'undo';
  }
  if (key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey) {
    return 'redo';
  }
  return null;
}

function getAttachmentSignature(snapshot: ComposerSnapshot): string {
  const fileSignature = snapshot.files
    .map((file) => `${file.path}\u0001${JSON.stringify(file.lineRanges ?? null)}`)
    .join('\u0001');
  const imageSignature = snapshot.images.map((image) => image.id).join('\u0001');
  return `${fileSignature}\u0001${imageSignature}`;
}

function cloneSnapshot(snapshot: ComposerSnapshot): ComposerSnapshot {
  return {
    text: snapshot.text,
    caret: snapshot.caret,
    files: snapshot.files.map((file) => ({ ...file })),
    images: snapshot.images.map((image) => ({ ...image })),
  };
}

export function createComposerHistory(options?: {
  maxDepth?: number;
  coalesceMs?: number;
  now?: () => number;
}) {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const coalesceMs = options?.coalesceMs ?? DEFAULT_COALESCE_MS;
  const now = options?.now ?? (() => Date.now());

  let stack: ComposerSnapshot[] = [{ text: '', caret: 0, files: [], images: [] }];
  let index = 0;
  let lastEditTime = 0;
  let lastEditKind: ComposerEditKind | null = null;
  let breakNextCoalesce = false;

  function reset(snapshot: ComposerSnapshot) {
    stack = [cloneSnapshot(snapshot)];
    index = 0;
    lastEditTime = 0;
    lastEditKind = null;
    breakNextCoalesce = false;
  }

  function record(snapshot: ComposerSnapshot) {
    const current = stack[index];
    const attachmentsChanged = getAttachmentSignature(snapshot) !== getAttachmentSignature(current);

    if (snapshot.text === current.text && !attachmentsChanged) {
      // Caret-only movement: keep the entry but track the latest caret so
      // undo/redo restores where the user actually was.
      stack[index] = cloneSnapshot(snapshot);
      return;
    }

    // A new edit invalidates the redo tail.
    stack.length = index + 1;

    const delta = snapshot.text.length - current.text.length;
    const kind: ComposerEditKind =
      snapshot.text === current.text
        ? 'attachments'
        : delta > 0
          ? 'insert'
          : delta < 0
            ? 'delete'
            : 'replace';
    const isSingleCharEdit = Math.abs(delta) === 1;
    const time = now();
    const shouldCoalesce =
      index > 0 &&
      isSingleCharEdit &&
      (kind === 'insert' || kind === 'delete') &&
      kind === lastEditKind &&
      !attachmentsChanged &&
      !breakNextCoalesce &&
      time - lastEditTime <= coalesceMs;

    if (shouldCoalesce) {
      stack[index] = cloneSnapshot(snapshot);
    } else {
      stack.push(cloneSnapshot(snapshot));
      index += 1;
      if (stack.length > maxDepth) {
        const overflow = stack.length - maxDepth;
        stack.splice(0, overflow);
        index -= overflow;
      }
    }

    lastEditTime = time;
    lastEditKind = kind;
    // Whitespace ends a typing run so undo works word-by-word.
    breakNextCoalesce =
      kind === 'insert' && isSingleCharEdit && /\s/.test(snapshot.text[snapshot.caret - 1] ?? '');
  }

  function undo(): ComposerSnapshot | null {
    if (index === 0) return null;
    index -= 1;
    lastEditKind = null;
    breakNextCoalesce = false;
    return cloneSnapshot(stack[index]);
  }

  function redo(): ComposerSnapshot | null {
    if (index >= stack.length - 1) return null;
    index += 1;
    lastEditKind = null;
    breakNextCoalesce = false;
    return cloneSnapshot(stack[index]);
  }

  return {
    record,
    undo,
    redo,
    reset,
    canUndo: () => index > 0,
    canRedo: () => index < stack.length - 1,
  };
}
