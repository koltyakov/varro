import type {
  QueuedMessage,
  SelectedModel,
  SessionSelectedMcps,
  SessionSelectedModels,
} from './app-state-types';
import type {
  DesktopSessionPaneSide,
  DroppedFile,
  EditorDiagnostic,
  InitialWebviewState,
  PermissionMode,
} from '../../shared/protocol';
import { isPermissionMode } from '../../shared/protocol';
import { STORAGE_KEYS, readStored, writeStored } from './state-storage';

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

export function readStoredNullableStringRecord(key: string): Record<string, string | null> {
  const record = asStoredRecord(readStored<unknown>(key));
  if (!record) return {};

  const entries: Array<[string, string | null]> = [];
  for (const [entryKey, value] of Object.entries(record)) {
    if (!normalizeStoredString(entryKey)) continue;
    if (value === null) {
      entries.push([entryKey, null]);
      continue;
    }
    const normalized = normalizeStoredString(value);
    if (normalized) entries.push([entryKey, normalized]);
  }
  return Object.fromEntries(entries);
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

export function readStoredBooleanRecord(key: string): Record<string, boolean> {
  return normalizeStoredRecord(readStored<unknown>(key), (value) =>
    typeof value === 'boolean' ? value : null
  );
}

export function readStoredPermissionModes(key: string): Record<string, PermissionMode> {
  return normalizeStoredRecord(readStored<unknown>(key), (value) =>
    isPermissionMode(value) ? value : null
  );
}

function normalizeStoredAttachmentSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalizeStoredClipboardImage(
  value: unknown
): NonNullable<QueuedMessage['clipboardImages']>[number] | null {
  const record = asStoredRecord(value);
  const id = normalizeStoredString(record?.id);
  const url = normalizeStoredString(record?.url);
  const mime = normalizeStoredString(record?.mime);
  const filename = normalizeStoredString(record?.filename);
  if (
    !id ||
    !url ||
    !mime ||
    !filename ||
    typeof record?.size !== 'number' ||
    !Number.isFinite(record.size) ||
    record.size < 0
  ) {
    return null;
  }

  const image: NonNullable<QueuedMessage['clipboardImages']>[number] = {
    id,
    url,
    mime,
    filename,
    size: record.size,
  };
  const contentKey = normalizeStoredString(record.contentKey);
  if (contentKey) image.contentKey = contentKey;
  const attachmentSequence = normalizeStoredAttachmentSequence(record.attachmentSequence);
  if (attachmentSequence !== undefined) image.attachmentSequence = attachmentSequence;
  return image;
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

export function readStoredDroppedFiles(key: string): DroppedFile[] {
  const value = readStored<unknown>(key);
  const files: DroppedFile[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    const file = normalizeStoredDroppedFile(item);
    if (!file || files.some((existingFile) => existingFile.path === file.path)) continue;
    files.push(file);
  }
  return files;
}

function normalizeStoredTerminalSelection(value: unknown): QueuedMessage['terminalSelection'] {
  const record = asStoredRecord(value);
  if (typeof record?.text !== 'string' || typeof record.terminalName !== 'string') return null;
  return { text: record.text, terminalName: record.terminalName };
}

function normalizeStoredDiagnostics(value: unknown): QueuedMessage['attachedDiagnostics'] {
  const record = asStoredRecord(value);
  if (!record || !Array.isArray(record.diagnostics)) return null;
  const diagnostics = record.diagnostics.slice(0, 20).flatMap<EditorDiagnostic>((item) => {
    const diagnostic = asStoredRecord(item);
    if (
      typeof diagnostic?.path !== 'string' ||
      (diagnostic.severity !== 'error' &&
        diagnostic.severity !== 'warning' &&
        diagnostic.severity !== 'info') ||
      typeof diagnostic.message !== 'string' ||
      !Number.isFinite(diagnostic.line)
    ) {
      return [];
    }
    return [
      {
        path: diagnostic.path,
        severity: diagnostic.severity,
        message: diagnostic.message.slice(0, 500),
        line: diagnostic.line as number,
      },
    ];
  });
  if (diagnostics.length === 0) return null;
  const total = Number.isInteger(record.total)
    ? Math.max(diagnostics.length, record.total as number)
    : diagnostics.length;
  return { diagnostics, total };
}

function normalizeStoredQueuedMessage(value: unknown): QueuedMessage | null {
  const record = asStoredRecord(value);
  const id = normalizeStoredString(record?.id);
  const sessionId = normalizeStoredString(record?.sessionId);
  if (!id || !sessionId || typeof record?.text !== 'string') return null;
  const agent = normalizeStoredString(record.agent);
  const droppedFiles = Array.isArray(record.droppedFiles)
    ? record.droppedFiles
        .map(normalizeStoredDroppedFile)
        .filter((file): file is DroppedFile => file !== null)
    : [];
  const clipboardImages = Array.isArray(record.clipboardImages)
    ? record.clipboardImages
        .slice(0, 5)
        .map(normalizeStoredClipboardImage)
        .filter(
          (image): image is NonNullable<QueuedMessage['clipboardImages']>[number] => image !== null
        )
    : [];
  const terminalSelection = normalizeStoredTerminalSelection(record.terminalSelection);
  const attachedDiagnostics = normalizeStoredDiagnostics(record.attachedDiagnostics);
  if (
    record.text.trim().length === 0 &&
    droppedFiles.length === 0 &&
    clipboardImages.length === 0 &&
    !terminalSelection &&
    !attachedDiagnostics
  ) {
    return null;
  }

  return {
    id,
    sessionId,
    text: record.text,
    ...(agent ? { agent } : {}),
    ...(record.paused === true ? { paused: true } : {}),
    droppedFiles,
    clipboardImages,
    terminalSelection,
    ...(attachedDiagnostics ? { attachedDiagnostics } : {}),
  };
}

export function readStoredQueuedMessages(hostValue?: unknown): QueuedMessage[] {
  const value = hostValue ?? readStored<unknown>(STORAGE_KEYS.queuedMessages);
  const ids = new Set<string>();
  const messages: QueuedMessage[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    const message = normalizeStoredQueuedMessage(item);
    if (!message || ids.has(message.id)) continue;
    ids.add(message.id);
    messages.push(message);
  }
  // Image data URLs stay in host persistence; browser persistence is synchronous and size-sensitive.
  writeStored(
    STORAGE_KEYS.queuedMessages,
    messages.filter((message) => (message.clipboardImages?.length ?? 0) === 0)
  );
  return messages;
}

export function readShowThinking(): boolean {
  const value = readStored<unknown>(STORAGE_KEYS.showThinking);
  return typeof value === 'boolean' ? value : true;
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
