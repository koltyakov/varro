import type {
  ClipboardImage,
  QueuedMessage,
  SelectedModel,
  SessionSelectedMcps,
  SessionSelectedModels,
} from './app-state-types';
import type {
  DesktopSessionPaneSide,
  DroppedFile,
  InitialWebviewState,
  PermissionMode,
} from '../../shared/protocol';
import { isPermissionMode } from '../../shared/protocol';
import { STORAGE_KEYS, readStored } from './state-storage';

function asStoredRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeStoredString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeStoredStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => normalizeStoredString(item) !== null);
}

function normalizeStoredSelectedModel(value: unknown): SelectedModel | null {
  const record = asStoredRecord(value);
  const providerID = normalizeStoredString(record?.providerID);
  const modelID = normalizeStoredString(record?.modelID);
  if (!providerID || !modelID) return null;

  const variant = normalizeStoredString(record?.variant);
  return variant ? { providerID, modelID, variant } : { providerID, modelID };
}

function normalizeStoredRecord<T>(
  value: unknown,
  normalizeValue: (entry: unknown) => T | null
): Record<string, T> {
  const record = asStoredRecord(value);
  if (!record) return {};

  const entries: Array<[string, T]> = [];
  for (const [key, entry] of Object.entries(record)) {
    if (!normalizeStoredString(key)) continue;
    const normalized = normalizeValue(entry);
    if (normalized !== null) entries.push([key, normalized]);
  }
  return Object.fromEntries(entries);
}

export function readStoredString(key: string): string | null {
  return normalizeStoredString(readStored<unknown>(key));
}

export function readStoredStringArray(key: string): string[] {
  return normalizeStoredStringArray(readStored<unknown>(key)) ?? [];
}

export function readStoredStringRecord(key: string): Record<string, string> {
  return normalizeStoredRecord(readStored<unknown>(key), normalizeStoredString);
}

export function readStoredSelectedModel(key: string): SelectedModel | null {
  return normalizeStoredSelectedModel(readStored<unknown>(key));
}

export function readStoredSelectedModels(key: string): SessionSelectedModels {
  return normalizeStoredRecord(readStored<unknown>(key), normalizeStoredSelectedModel);
}

export function readStoredStringArrayRecord(key: string): SessionSelectedMcps {
  return normalizeStoredRecord(readStored<unknown>(key), normalizeStoredStringArray);
}

export function readStoredPermissionModes(key: string): Record<string, PermissionMode> {
  return normalizeStoredRecord(readStored<unknown>(key), (value) =>
    isPermissionMode(value) ? value : null
  );
}

function normalizeStoredAttachmentSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalizeStoredDroppedFile(value: unknown): DroppedFile | null {
  const record = asStoredRecord(value);
  const path = normalizeStoredString(record?.path);
  const relativePath = normalizeStoredString(record?.relativePath);
  if (!path || !relativePath || (record?.type !== 'file' && record?.type !== 'directory')) {
    return null;
  }

  const file: DroppedFile = { path, relativePath, type: record.type };
  if (Array.isArray(record.lineRanges)) {
    file.lineRanges = record.lineRanges.flatMap((item) => {
      const range = asStoredRecord(item);
      const startLine = range?.startLine;
      const endLine = range?.endLine;
      return typeof startLine === 'number' &&
        typeof endLine === 'number' &&
        Number.isSafeInteger(startLine) &&
        Number.isSafeInteger(endLine) &&
        startLine >= 1 &&
        endLine >= startLine
        ? [{ startLine, endLine }]
        : [];
    });
  }
  const attachmentSequence = normalizeStoredAttachmentSequence(record.attachmentSequence);
  if (attachmentSequence !== undefined) file.attachmentSequence = attachmentSequence;
  return file;
}

function normalizeStoredClipboardImage(value: unknown): ClipboardImage | null {
  const record = asStoredRecord(value);
  const id = normalizeStoredString(record?.id);
  const url = normalizeStoredString(record?.url);
  const mime = normalizeStoredString(record?.mime);
  const filename = normalizeStoredString(record?.filename);
  const size = record?.size;
  if (
    !id ||
    !url ||
    !mime ||
    !filename ||
    typeof size !== 'number' ||
    !Number.isFinite(size) ||
    size < 0
  ) {
    return null;
  }

  const image: ClipboardImage = { id, url, mime, filename, size };
  const contentKey = normalizeStoredString(record?.contentKey);
  if (contentKey) image.contentKey = contentKey;
  const attachmentSequence = normalizeStoredAttachmentSequence(record?.attachmentSequence);
  if (attachmentSequence !== undefined) image.attachmentSequence = attachmentSequence;
  return image;
}

function normalizeStoredTerminalSelection(value: unknown): QueuedMessage['terminalSelection'] {
  const record = asStoredRecord(value);
  if (typeof record?.text !== 'string' || typeof record.terminalName !== 'string') return null;
  return { text: record.text, terminalName: record.terminalName };
}

function normalizeStoredQueuedMessage(value: unknown): QueuedMessage | null {
  const record = asStoredRecord(value);
  const id = normalizeStoredString(record?.id);
  const sessionId = normalizeStoredString(record?.sessionId);
  if (!id || !sessionId || typeof record?.text !== 'string') return null;

  const droppedFiles = Array.isArray(record.droppedFiles)
    ? record.droppedFiles
        .map(normalizeStoredDroppedFile)
        .filter((file): file is DroppedFile => file !== null)
    : [];
  const clipboardImages = Array.isArray(record.clipboardImages)
    ? record.clipboardImages
        .map(normalizeStoredClipboardImage)
        .filter((image): image is ClipboardImage => image !== null)
    : [];
  const terminalSelection = normalizeStoredTerminalSelection(record.terminalSelection);
  if (
    record.text.trim().length === 0 &&
    droppedFiles.length === 0 &&
    clipboardImages.length === 0 &&
    !terminalSelection
  ) {
    return null;
  }

  return {
    id,
    sessionId,
    text: record.text,
    droppedFiles,
    clipboardImages,
    terminalSelection,
  };
}

export function readStoredQueuedMessages(): QueuedMessage[] {
  const value = readStored<unknown>(STORAGE_KEYS.queuedMessages);
  if (!Array.isArray(value)) return [];

  const ids = new Set<string>();
  const messages: QueuedMessage[] = [];
  for (const item of value) {
    const message = normalizeStoredQueuedMessage(item);
    if (!message || ids.has(message.id)) continue;
    ids.add(message.id);
    messages.push(message);
  }
  return messages;
}

function readStoredBoolean(key: string): boolean | null {
  const value = readStored<unknown>(key);
  return typeof value === 'boolean' ? value : null;
}

export function readShowThinking(): boolean {
  const value = readStored<unknown>(STORAGE_KEYS.showThinking);
  return typeof value === 'boolean' ? value : true;
}

export function readExpandThinkingByDefault(
  initialWebviewState: Partial<InitialWebviewState> = readInitialWebviewState()
): boolean {
  return (
    initialWebviewState.expandThinkingByDefault ??
    readStoredBoolean(STORAGE_KEYS.expandThinkingByDefault) ??
    false
  );
}

export function readShowStickyUserPrompt(
  initialWebviewState: Partial<InitialWebviewState> = readInitialWebviewState()
): boolean {
  return (
    initialWebviewState.showStickyUserPrompt ??
    readStoredBoolean(STORAGE_KEYS.showStickyUserPrompt) ??
    true
  );
}

export function readDesktopSessionPaneSide(
  initialWebviewState: Partial<InitialWebviewState> = readInitialWebviewState()
): DesktopSessionPaneSide {
  return initialWebviewState.desktopSessionPaneSide === 'right' ? 'right' : 'left';
}

export function resolveInitialDraftMode(
  permissionWorkspace: string | null,
  fallbackMode: PermissionMode
): PermissionMode {
  if (permissionWorkspace) {
    const modes = readStoredPermissionModes(STORAGE_KEYS.projectPermissionModes);
    const projectMode = modes[permissionWorkspace];
    if (Object.hasOwn(modes, permissionWorkspace) && isPermissionMode(projectMode)) {
      return projectMode;
    }
  }
  const storedMode = readStored<PermissionMode>(STORAGE_KEYS.draftPermissionMode);
  return isPermissionMode(storedMode) ? storedMode : fallbackMode;
}

export function readInitialWebviewState(): Partial<InitialWebviewState> {
  const value = (window as unknown as { __initialWebviewState?: InitialWebviewState })
    .__initialWebviewState;
  return value && typeof value === 'object' ? value : {};
}
