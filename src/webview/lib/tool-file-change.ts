import type { FileDiff, Part, ToolPart, ToolState } from '../types';
import { getWorkspaceRelativePath, isAbsolutePath, normalizePath } from './path-display';

export type FileChangeKind = 'added' | 'edited' | 'removed' | 'moved';

export type FileChange = {
  kind: FileChangeKind;
  path: string;
  fromPath?: string;
  toPath?: string;
  before?: string;
  after?: string;
  patch?: string;
  patchFormat?: 'headerless' | 'unified';
  additions?: number;
  deletions?: number;
  previewStatus?: 'unavailable' | 'truncated';
  previewMessage?: string;
  isSummary?: boolean;
  dedupeKey: string;
};

type MetadataFileChange = {
  change: FileChange;
  fallbackKind: boolean;
};

type PatchSection = {
  operation: 'add' | 'update' | 'delete';
  path: string;
  movePath?: string;
  lines: string[];
  bytes: number;
  lineCount: number;
  additions: number;
  deletions: number;
  previewMessage?: string;
};

type BoundedTextMeasurement = {
  bytes: number;
  lines: number;
  exceeded: 'bytes' | 'lines' | null;
};

const FILE_CHANGE_TOOL_NAMES = new Set([
  'edit',
  'write',
  'create',
  'file_edit',
  'file_write',
  'file_create',
  'update_file',
  'replace',
  'insert',
  'apply_edit',
  'apply_diff',
  'delete',
  'remove',
  'unlink',
  'rm',
  'file_delete',
  'file_remove',
  'move',
  'mv',
  'rename',
  'file_move',
  'file_rename',
]);

const PRIMARY_PATH_KEYS = [
  'file_path',
  'filePath',
  'filepath',
  'relativePath',
  'path',
  'file',
  'filename',
];
const SOURCE_PATH_KEYS = [
  'from_path',
  'fromPath',
  'old_path',
  'oldPath',
  'source_path',
  'sourcePath',
  'source',
  'src',
];
const TARGET_PATH_KEYS = [
  'to_path',
  'toPath',
  'new_path',
  'newPath',
  'movePath',
  'move_path',
  'target_path',
  'targetPath',
  'destination_path',
  'destinationPath',
  'destination',
  'dest',
];
const OPERATION_KEYS = ['operation', 'action', 'changeType', 'change_type', 'status', 'type'];
const FILE_READ_TOOLS = new Set(['read', 'file_read']);
const MAX_LAYOUT_CONTENT_SCAN_CHARS = 256 * 1024;
const MAX_PATCH_FILE_CHANGES = 64;
const MAX_MODEL_PATCH_BYTES = 1024 * 1024;
const MAX_MODEL_PATCH_LINES = 10_000;
const MAX_PATCH_SECTION_BYTES = 256 * 1024;
const MAX_PATCH_SECTION_LINES = 2_000;
const MAX_STORED_PATCH_BYTES = 512 * 1024;
const MAX_STORED_PATCH_LINES = 4_000;

function looksLikePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
  if (/^[^\s/\\]+\.[^\s/\\]+$/.test(trimmed) && !trimmed.startsWith('.')) return false;
  return (
    /[\\/]/.test(trimmed) ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    /^\.\.?(?:[\\/]|$)/.test(trimmed) ||
    /\.[A-Za-z0-9]{1,12}$/.test(trimmed)
  );
}

function stripPathWrapping(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('`') && trimmed.endsWith('`')) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseTitleFileChange(title: string): Omit<FileChange, 'dedupeKey'> | null {
  const trimmed = title.trim();
  if (!trimmed) return null;

  const movedMatch = trimmed.match(/^(moved|renamed)\s+(.+?)\s*(?:->|→)\s*(.+)$/i);
  if (movedMatch) {
    const fromPath = stripPathWrapping(movedMatch[2]!);
    const toPath = stripPathWrapping(movedMatch[3]!);
    if (!looksLikePath(fromPath) || !looksLikePath(toPath)) return null;
    return { kind: 'moved', path: toPath, fromPath, toPath };
  }

  const basicMatch = trimmed.match(
    /^(added|created|edited|updated|modified|removed|deleted)\s+(.+)$/i
  );
  if (!basicMatch) return null;

  const action = basicMatch[1]!.toLowerCase();
  const path = stripPathWrapping(basicMatch[2]!);
  if (!looksLikePath(path)) return null;

  return {
    kind:
      action === 'added' || action === 'created'
        ? 'added'
        : action === 'removed' || action === 'deleted'
          ? 'removed'
          : 'edited',
    path,
  };
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function numberValue(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function withDedupeKey(change: Omit<FileChange, 'dedupeKey'>): FileChange {
  const result: FileChange = {
    kind: change.kind,
    path: change.path,
    dedupeKey: change.isSummary
      ? `summary:${change.previewMessage || 'truncated'}`
      : change.kind === 'moved'
        ? `moved:${normalizePath(change.fromPath || '')}->${normalizePath(change.toPath || change.path)}`
        : `${change.kind}:${normalizePath(change.path)}`,
  };
  if (change.fromPath !== undefined) result.fromPath = change.fromPath;
  if (change.toPath !== undefined) result.toPath = change.toPath;
  if (change.before !== undefined) result.before = change.before;
  if (change.after !== undefined) result.after = change.after;
  if (change.patch !== undefined) result.patch = change.patch;
  if (change.patchFormat !== undefined) result.patchFormat = change.patchFormat;
  if (change.additions !== undefined) result.additions = change.additions;
  if (change.deletions !== undefined) result.deletions = change.deletions;
  if (change.previewStatus !== undefined) result.previewStatus = change.previewStatus;
  if (change.previewMessage !== undefined) result.previewMessage = change.previewMessage;
  if (change.isSummary !== undefined) result.isSummary = change.isSummary;
  return result;
}

export function isToolFileRead(toolName: string): boolean {
  return FILE_READ_TOOLS.has(toolName.trim().toLowerCase());
}

export function getToolReadPath(toolName: string, toolState: ToolState): string | null {
  if (!isToolFileRead(toolName)) return null;
  const input = (toolState.input || {}) as Record<string, unknown>;
  return firstString(input, PRIMARY_PATH_KEYS) || null;
}

function getToolMetadata(toolState: ToolState): Record<string, unknown> | undefined {
  if (
    toolState.status === 'completed' ||
    toolState.status === 'running' ||
    toolState.status === 'error'
  ) {
    return toolState.metadata;
  }
  return undefined;
}

function kindFromText(value: string | undefined): FileChangeKind | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (/(?:^|\b)(move|moved|rename|renamed)(?:\b|$)/.test(normalized)) return 'moved';
  if (/(?:^|\b)(delete|deleted|remove|removed|unlink)(?:\b|$)/.test(normalized)) return 'removed';
  if (/(?:^|\b)(create|created|add|added)(?:\b|$)/.test(normalized)) return 'added';
  if (
    /(?:^|\b)(edit|edited|update|updated|modify|modified|write|wrote|replace|insert|patch)(?:\b|$)/.test(
      normalized
    )
  ) {
    return 'edited';
  }
  return null;
}

const toolFileChangeCache = new WeakMap<ToolState, FileChange | null>();
const toolFileChangesCache = new WeakMap<ToolState, FileChange[]>();

export function getToolFileChange(toolName: string, toolState: ToolState): FileChange | null {
  const cached = toolFileChangeCache.get(toolState);
  if (cached !== undefined) return cached;

  const result = getToolFileChanges(toolName, toolState)[0] || null;
  toolFileChangeCache.set(toolState, result);
  return result;
}

export function getToolFileChanges(toolName: string, toolState: ToolState): FileChange[] {
  const cached = toolFileChangesCache.get(toolState);
  if (cached !== undefined) return cached;

  const result = computeToolFileChanges(toolName, toolState);
  toolFileChangesCache.set(toolState, result);
  toolFileChangeCache.set(toolState, result[0] || null);
  return result;
}

export function getToolFileChangeSignature(toolName: string, toolState: ToolState): string | null {
  const changes = getToolFileChanges(toolName, toolState);
  if (changes.length === 0) return null;
  return changes.map((change) => change.dedupeKey).join('|');
}

export function getToolInlineFileChangesLayoutSignature(
  toolName: string,
  toolState: ToolState
): string | null {
  const changes = getToolFileChanges(toolName, toolState);
  const hasPreviewContent = changes.some(
    (change) =>
      change.patch !== undefined ||
      change.before !== undefined ||
      change.after !== undefined ||
      change.previewStatus !== undefined
  );
  if (!hasPreviewContent) return null;

  return changes
    .map((change) => {
      const contentSignature =
        change.previewStatus !== undefined
          ? `preview:${change.previewStatus}:${change.previewMessage ?? ''}`
          : change.patch !== undefined
            ? `patch:${getLayoutContentSignature(change.patch)}`
            : change.before !== undefined || change.after !== undefined
              ? `snapshots:${getLayoutContentSignature(change.before ?? '')}:${getLayoutContentSignature(change.after ?? '')}`
              : `metadata:${change.kind}:${change.fromPath ?? ''}:${change.toPath ?? ''}:${change.additions ?? ''}:${change.deletions ?? ''}`;
      return `${change.dedupeKey}:${contentSignature}`;
    })
    .join('|');
}

function getLayoutContentSignature(content: string) {
  let hash = 2_166_136_261;
  let lineCount = 1;
  const length = content.length;

  const fold = (code: number) => {
    if (code === 10) lineCount += 1;
    hash ^= code;
    hash = Math.imul(hash, 16_777_619);
  };

  if (length <= MAX_LAYOUT_CONTENT_SCAN_CHARS) {
    for (let index = 0; index < length; index += 1) fold(content.charCodeAt(index));
    return `${length}:${lineCount}:${hash >>> 0}`;
  }

  // Sample evenly across the whole content so a change anywhere — including the
  // middle — still perturbs the signature, at a bounded cost.
  const step = length / MAX_LAYOUT_CONTENT_SCAN_CHARS;
  for (let sample = 0; sample < MAX_LAYOUT_CONTENT_SCAN_CHARS; sample += 1) {
    const index = Math.floor(sample * step);
    hash ^= index;
    hash = Math.imul(hash, 16_777_619);
    fold(content.charCodeAt(index));
  }
  return `${length}:sampled:${hash >>> 0}`;
}

function computeToolFileChanges(toolName: string, toolState: ToolState): FileChange[] {
  const metadata = getToolMetadata(toolState) || {};
  const normalizedToolName = toolName.trim().toLowerCase().split('.').pop();
  const metadataChanges = fileChangesFromMetadataFiles(
    metadata,
    normalizedToolName === 'apply_patch' ? 'edited' : null
  );
  if (normalizedToolName === 'apply_patch') {
    const inputChanges = fileChangesFromPatchInput(
      (toolState.input || {}) as Record<string, unknown>
    );
    if (metadataChanges.length > 0 || inputChanges.length > 0) {
      return mergeFileChanges(metadataChanges, inputChanges);
    }
  }
  if (metadataChanges.length > 0) {
    return limitFileChanges(metadataChanges.map((entry) => entry.change));
  }

  const single = computeToolFileChange(toolName, toolState);
  return single ? [single] : [];
}

function fileChangesFromMetadataFiles(
  metadata: Record<string, unknown>,
  fallbackKind: FileChangeKind | null
): MetadataFileChange[] {
  const files = metadata.files;
  if (!Array.isArray(files)) return [];

  const changes: MetadataFileChange[] = [];
  let previewBytesRemaining = MAX_STORED_PATCH_BYTES;
  let previewLinesRemaining = MAX_STORED_PATCH_LINES;
  const count = Math.min(files.length, MAX_PATCH_FILE_CHANGES);
  for (let index = 0; index < count; index += 1) {
    const item = files[index];
    if (!isRecord(item)) continue;
    const primaryPath = firstString(item, ['relativePath', ...PRIMARY_PATH_KEYS]);
    const explicitFromPath = firstString(item, SOURCE_PATH_KEYS);
    const explicitToPath = firstString(item, TARGET_PATH_KEYS);
    const fromPath = explicitFromPath || firstString(item, ['filePath', 'filepath']);
    const explicitKind =
      kindFromText(firstString(item, OPERATION_KEYS)) ||
      (fromPath && explicitToPath ? 'moved' : null);
    const kind = explicitKind || fallbackKind;
    const toPath =
      kind === 'moved'
        ? explicitToPath || firstString(item, ['relativePath']) || primaryPath
        : undefined;
    const additions = numberValue(item, 'additions');
    const deletions = numberValue(item, 'deletions');
    let before = stringValue(item, ['before', 'oldContent', 'old_content']);
    let after = stringValue(item, ['after', 'newContent', 'new_content']);
    let patch = firstString(item, ['patch', 'diff']);
    let previewMessage: string | undefined;
    for (const content of [patch, before, after]) {
      if (content === undefined) continue;
      if (previewBytesRemaining <= 0 || previewLinesRemaining <= 0) {
        previewMessage = 'Preview truncated: total inline patch content limit reached.';
        break;
      }
      const byteLimit = Math.min(MAX_PATCH_SECTION_BYTES, previewBytesRemaining);
      const lineLimit = Math.min(MAX_PATCH_SECTION_LINES, previewLinesRemaining);
      const measured = measureBoundedText(content, byteLimit, lineLimit);
      previewBytesRemaining = Math.max(0, previewBytesRemaining - measured.bytes);
      previewLinesRemaining = Math.max(0, previewLinesRemaining - measured.lines);
      if (!measured.exceeded) continue;
      previewMessage =
        byteLimit < MAX_PATCH_SECTION_BYTES || lineLimit < MAX_PATCH_SECTION_LINES
          ? 'Preview truncated: total inline patch content limit reached.'
          : 'Preview truncated: file patch section exceeds 2,000 lines or 256 KB.';
      break;
    }
    if (previewMessage) {
      before = undefined;
      after = undefined;
      patch = undefined;
    }

    if (kind === 'moved') {
      const path = toPath || primaryPath || fromPath;
      if (!path) continue;
      changes.push({
        fallbackKind: explicitKind === null,
        change: withDedupeKey({
          kind,
          path,
          fromPath,
          toPath,
          before,
          after,
          patch,
          additions,
          deletions,
          previewStatus: previewMessage ? 'truncated' : undefined,
          previewMessage,
        }),
      });
      continue;
    }

    const path = primaryPath || toPath || fromPath;
    if (!path || !kind) continue;
    changes.push({
      fallbackKind: explicitKind === null,
      change: withDedupeKey({
        kind,
        path,
        before,
        after,
        patch,
        additions,
        deletions,
        previewStatus: previewMessage ? 'truncated' : undefined,
        previewMessage,
      }),
    });
  }

  if (files.length > MAX_PATCH_FILE_CHANGES) {
    changes.push({
      fallbackKind: false,
      change: createTruncatedSummary(
        `Additional metadata files were omitted after ${MAX_PATCH_FILE_CHANGES} files.`
      ),
    });
  }
  return changes;
}

function fileChangesFromPatchInput(input: Record<string, unknown>): FileChange[] {
  const patchText = firstString(input, ['patchText', 'patch_text', 'patch']);
  if (!patchText) return [];

  const changes: FileChange[] = [];
  let current: PatchSection | null = null;
  let fileCount = 0;
  let storedBytes = 0;
  let storedLines = 0;
  let stopMessage: string | null = null;
  let reachedEndPatch = false;

  const finishSection = () => {
    if (!current) return;
    const section = current;
    current = null;
    const patch = section.lines.length > 0 ? section.lines.join('\n') : undefined;
    const previewStatus = section.previewMessage ? 'truncated' : undefined;
    const additions = previewStatus ? undefined : section.additions;
    const deletions = previewStatus ? undefined : section.deletions;

    if (section.operation === 'update' && section.movePath) {
      const toPath = stripPathWrapping(section.movePath);
      if (toPath) {
        changes.push(
          withDedupeKey({
            kind: 'moved',
            path: toPath,
            fromPath: section.path,
            toPath,
            patch,
            patchFormat: patch ? 'headerless' : undefined,
            additions,
            deletions,
            previewStatus,
            previewMessage: section.previewMessage,
          })
        );
        return;
      }
    }

    const kind =
      section.operation === 'add' ? 'added' : section.operation === 'delete' ? 'removed' : 'edited';
    changes.push(
      withDedupeKey({
        kind,
        path: section.path,
        patch,
        patchFormat: patch ? 'headerless' : undefined,
        additions,
        deletions,
        previewStatus,
        previewMessage: section.previewMessage,
      })
    );
  };

  const processLine = (line: string, lineBytes: number): 'continue' | 'complete' | 'limit' => {
    const header = /^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/.exec(line);
    if (header) {
      finishSection();
      if (fileCount >= MAX_PATCH_FILE_CHANGES) {
        stopMessage = `Additional patch files were omitted after ${MAX_PATCH_FILE_CHANGES} files.`;
        return 'limit';
      }
      const path = stripPathWrapping(header[2] || '');
      if (!path) return 'continue';
      current = {
        operation: header[1]!.toLowerCase() as PatchSection['operation'],
        path,
        lines: [],
        bytes: 0,
        lineCount: 0,
        additions: 0,
        deletions: 0,
      };
      fileCount += 1;
      return 'continue';
    }

    if (/^\*\*\* End Patch\s*$/.test(line)) {
      finishSection();
      reachedEndPatch = true;
      return 'complete';
    }
    if (!current) return 'continue';

    const move = /^\*\*\* Move to:\s*(.+?)\s*$/.exec(line);
    if (current.operation === 'update' && move) {
      current.movePath = move[1];
      return 'continue';
    }

    const nextSectionBytes = current.bytes + lineBytes + (current.lines.length > 0 ? 1 : 0);
    const nextStoredBytes = storedBytes + lineBytes + (current.lines.length > 0 ? 1 : 0);
    if (
      nextSectionBytes > MAX_PATCH_SECTION_BYTES ||
      current.lineCount + 1 > MAX_PATCH_SECTION_LINES
    ) {
      current.previewMessage ||=
        'Preview truncated: file patch section exceeds 2,000 lines or 256 KB.';
      return 'continue';
    }
    if (nextStoredBytes > MAX_STORED_PATCH_BYTES || storedLines + 1 > MAX_STORED_PATCH_LINES) {
      current.previewMessage ||= 'Preview truncated: total inline patch content limit reached.';
      return 'continue';
    }

    current.lines.push(line);
    current.bytes = nextSectionBytes;
    current.lineCount += 1;
    storedBytes = nextStoredBytes;
    storedLines += 1;
    if (line.startsWith('+')) current.additions += 1;
    else if (line.startsWith('-')) current.deletions += 1;
    return 'continue';
  };

  let scannedBytes = 0;
  let scannedLines = 0;
  let lineStart = 0;
  let lineBytes = 0;
  let index = 0;
  for (; index < patchText.length; index += 1) {
    const { bytes, codeUnits } = getUtf8Width(patchText, index);
    if (scannedBytes + bytes > MAX_MODEL_PATCH_BYTES) {
      stopMessage = 'Additional patch content was omitted after the 1 MB input limit.';
      break;
    }
    scannedBytes += bytes;

    if (patchText.charCodeAt(index) !== 10) {
      lineBytes += bytes;
      index += codeUnits - 1;
      continue;
    }
    if (scannedLines >= MAX_MODEL_PATCH_LINES) {
      stopMessage = `Additional patch content was omitted after ${MAX_MODEL_PATCH_LINES.toLocaleString()} input lines.`;
      break;
    }

    const lineEnd = index > lineStart && patchText.charCodeAt(index - 1) === 13 ? index - 1 : index;
    scannedLines += 1;
    const result = processLine(patchText.slice(lineStart, lineEnd), lineBytes);
    lineStart = index + 1;
    lineBytes = 0;
    if (result !== 'continue') break;
  }

  if (
    !stopMessage &&
    !reachedEndPatch &&
    index >= patchText.length &&
    lineStart < patchText.length
  ) {
    if (scannedLines >= MAX_MODEL_PATCH_LINES) {
      stopMessage = `Additional patch content was omitted after ${MAX_MODEL_PATCH_LINES.toLocaleString()} input lines.`;
    } else {
      processLine(patchText.slice(lineStart), lineBytes);
    }
  }
  const unfinishedSection = current as PatchSection | null;
  if (stopMessage && unfinishedSection) {
    unfinishedSection.previewMessage ||=
      'Preview truncated because the model patch input limit was reached.';
  }
  finishSection();
  if (stopMessage) changes.push(createTruncatedSummary(stopMessage));
  return limitFileChanges(changes);
}

function getUtf8Width(value: string, index: number) {
  const code = value.charCodeAt(index);
  if (code <= 0x7f) return { bytes: 1, codeUnits: 1 };
  if (code <= 0x7ff) return { bytes: 2, codeUnits: 1 };
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = value.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return { bytes: 4, codeUnits: 2 };
  }
  return { bytes: 3, codeUnits: 1 };
}

function measureBoundedText(
  content: string,
  maxBytes: number,
  maxLines: number
): BoundedTextMeasurement {
  let bytes = 0;
  let lines = content.length > 0 ? 1 : 0;
  if (lines > maxLines) return { bytes, lines, exceeded: 'lines' };

  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    const width = getUtf8Width(content, index);
    bytes += width.bytes;
    if (bytes > maxBytes) return { bytes, lines, exceeded: 'bytes' };
    // Count LF and lone CR as line breaks (matching DiffView's measureText), so a
    // CRLF pair counts once while old-Mac CR line endings still advance the count.
    if (code === 10 || (code === 13 && content.charCodeAt(index + 1) !== 10)) {
      lines += 1;
      if (lines > maxLines) return { bytes, lines, exceeded: 'lines' };
    }
    index += width.codeUnits - 1;
  }
  return { bytes, lines, exceeded: null };
}

function createTruncatedSummary(message: string): FileChange {
  return withDedupeKey({
    kind: 'edited',
    path: '',
    previewStatus: 'truncated',
    previewMessage: message,
    isSummary: true,
  });
}

function limitFileChanges(changes: readonly FileChange[]): FileChange[] {
  const files = changes.filter((change) => !change.isSummary);
  const messages = changes
    .filter((change) => change.isSummary && change.previewMessage)
    .map((change) => change.previewMessage!);
  if (files.length > MAX_PATCH_FILE_CHANGES) {
    messages.push(`Additional patch files were omitted after ${MAX_PATCH_FILE_CHANGES} files.`);
  }
  const result = files.slice(0, MAX_PATCH_FILE_CHANGES);
  if (messages.length > 0) result.push(createTruncatedSummary([...new Set(messages)].join(' ')));
  return result;
}

function mergeFileChanges(
  metadataChanges: readonly MetadataFileChange[],
  inputChanges: readonly FileChange[]
): FileChange[] {
  const result: FileChange[] = [];
  const matchedInputs = new Set<number>();

  for (const metadataEntry of metadataChanges) {
    if (metadataEntry.change.isSummary) {
      result.push({ ...metadataEntry.change });
      continue;
    }

    let bestInputIndex = -1;
    let bestScore = 0;
    for (let index = 0; index < inputChanges.length; index += 1) {
      if (matchedInputs.has(index) || inputChanges[index]!.isSummary) continue;
      const score = getMergeScore(metadataEntry, inputChanges[index]!);
      if (score <= bestScore) continue;
      bestScore = score;
      bestInputIndex = index;
    }

    if (bestInputIndex < 0) {
      result.push({ ...metadataEntry.change });
      continue;
    }
    matchedInputs.add(bestInputIndex);
    result.push(
      mergeFileChange(
        metadataEntry.change,
        inputChanges[bestInputIndex]!,
        metadataEntry.fallbackKind
      )
    );
  }

  for (let index = 0; index < inputChanges.length; index += 1) {
    if (!matchedInputs.has(index)) result.push({ ...inputChanges[index]! });
  }
  return limitFileChanges(result);
}

function getMergeScore(metadataEntry: MetadataFileChange, inputChange: FileChange) {
  const metadataChange = metadataEntry.change;
  const metadataTarget = metadataChange.toPath || metadataChange.path;
  const inputTarget = inputChange.toPath || inputChange.path;

  if (metadataChange.kind === 'moved' && inputChange.kind === 'moved') {
    const sameTarget = isSameChangePath(metadataTarget, inputTarget);
    const sameSource =
      !!metadataChange.fromPath &&
      !!inputChange.fromPath &&
      isSameChangePath(metadataChange.fromPath, inputChange.fromPath);
    if (sameTarget && sameSource) return 140;
    if (sameTarget) return 120;
    if (sameSource) return 110;
    return 0;
  }

  if (inputChange.kind === 'moved') {
    if (isSameChangePath(metadataTarget, inputTarget)) return 80;
    if (inputChange.fromPath && isSameChangePath(metadataTarget, inputChange.fromPath)) return 70;
    return 0;
  }
  if (metadataChange.kind === 'moved') return 0;
  if (!isSameChangePath(metadataTarget, inputTarget)) return 0;
  if (metadataChange.kind === inputChange.kind) return 140;
  return metadataEntry.fallbackKind ? 120 : 0;
}

function isSameChangePath(a: string, b: string) {
  return isSameFileKey(normalizeChangePath(a), normalizeChangePath(b));
}

function normalizeChangePath(path: string) {
  return normalizePath(path).replace(/^\.\//, '');
}

function mergeFileChange(
  metadataChange: FileChange,
  inputChange: FileChange,
  metadataKindIsFallback: boolean
): FileChange {
  const kind = metadataKindIsFallback
    ? inputChange.kind
    : metadataChange.kind === 'moved' || inputChange.kind === 'moved'
      ? 'moved'
      : metadataChange.kind;
  const fromPath = metadataChange.fromPath ?? inputChange.fromPath;
  const toPath = metadataChange.toPath ?? inputChange.toPath;
  const path =
    kind === 'moved' ? toPath || metadataChange.path || inputChange.path : metadataChange.path;
  const metadataHasPreview =
    metadataChange.patch !== undefined ||
    metadataChange.before !== undefined ||
    metadataChange.after !== undefined;
  const inputHasPreview =
    inputChange.patch !== undefined ||
    inputChange.before !== undefined ||
    inputChange.after !== undefined;
  const preferredPatch = getPreferredPatch(metadataChange.patch, inputChange.patch);
  const patch = preferredPatch.patch;
  const previewStateSource =
    preferredPatch.source === 'metadata'
      ? metadataChange
      : preferredPatch.source === 'input'
        ? inputChange
        : metadataHasPreview && !metadataChange.previewStatus
          ? metadataChange
          : inputHasPreview
            ? inputChange
            : metadataChange.previewStatus
              ? metadataChange
              : inputChange;
  const patchFormat =
    preferredPatch.source === 'input' && inputChange.patchFormat
      ? inputChange.patchFormat
      : metadataChange.patchFormat;

  return withDedupeKey({
    kind,
    path,
    fromPath,
    toPath,
    before: metadataChange.before ?? inputChange.before,
    after: metadataChange.after ?? inputChange.after,
    patch,
    patchFormat,
    additions: metadataChange.additions ?? inputChange.additions,
    deletions: metadataChange.deletions ?? inputChange.deletions,
    previewStatus: previewStateSource.previewStatus,
    previewMessage: previewStateSource.previewMessage,
  });
}

function getPreferredPatch(metadataPatch: string | undefined, inputPatch: string | undefined) {
  if (metadataPatch === undefined) {
    return { patch: inputPatch, source: inputPatch === undefined ? undefined : ('input' as const) };
  }
  if (inputPatch === undefined) return { patch: metadataPatch, source: 'metadata' as const };
  if (!hasChangedPatchLine(metadataPatch) && hasChangedPatchLine(inputPatch)) {
    return { patch: inputPatch, source: 'input' as const };
  }
  return { patch: metadataPatch, source: 'metadata' as const };
}

function hasChangedPatchLine(patch: string) {
  const end = Math.min(patch.length, MAX_LAYOUT_CONTENT_SCAN_CHARS);
  let atLineStart = true;
  for (let index = 0; index < end; index += 1) {
    if (atLineStart) {
      const marker = patch[index];
      if (
        (marker === '+' || marker === '-') &&
        !patch.startsWith('+++ ', index) &&
        !patch.startsWith('--- ', index)
      ) {
        return true;
      }
    }
    atLineStart = patch.charCodeAt(index) === 10;
  }
  return false;
}

function computeToolFileChange(toolName: string, toolState: ToolState): FileChange | null {
  const input = (toolState.input || {}) as Record<string, unknown>;
  const metadata = getToolMetadata(toolState) || {};
  const title =
    (toolState.status === 'completed' || toolState.status === 'running' ? toolState.title : '') ||
    '';
  const source = { ...metadata, ...input };
  const primaryPath = firstString(source, PRIMARY_PATH_KEYS);
  const fromPath = firstString(source, SOURCE_PATH_KEYS);
  const toPath = firstString(source, TARGET_PATH_KEYS);
  const additions = numberValue(source, 'additions') ?? numberValue(source, 'linesAdded');
  const deletions = numberValue(source, 'deletions') ?? numberValue(source, 'linesRemoved');
  const before = stringValue(source, ['oldString', 'old_string', 'before', 'oldContent']);
  const after = stringValue(source, ['newString', 'new_string', 'after', 'newContent', 'content']);
  const patch = firstString(source, ['patch', 'diff']);
  const normalizedToolName = toolName.trim().toLowerCase();
  const inferredKind =
    (fromPath && toPath && normalizePath(fromPath) !== normalizePath(toPath) ? 'moved' : null) ||
    kindFromText(firstString(source, OPERATION_KEYS)) ||
    kindFromText(title) ||
    kindFromText(normalizedToolName) ||
    (FILE_CHANGE_TOOL_NAMES.has(normalizedToolName) ? 'edited' : null);

  if (!inferredKind) return null;

  if (inferredKind === 'moved') {
    const from = fromPath || primaryPath;
    const to = toPath || primaryPath;
    const path = to || from;
    if (!path) {
      const titleChange = parseTitleFileChange(title);
      if (!titleChange || titleChange.kind !== 'moved') return null;
      return withDedupeKey({ ...titleChange, additions, deletions });
    }
    return withDedupeKey({
      kind: 'moved',
      path,
      fromPath: from,
      toPath: to,
      additions,
      deletions,
      before,
      after,
      patch,
    });
  }

  const path = primaryPath || toPath || fromPath;
  if (!path) {
    const titleChange = parseTitleFileChange(title);
    if (!titleChange || titleChange.kind === 'moved') return null;
    return withDedupeKey({ ...titleChange, additions, deletions });
  }
  return withDedupeKey({
    kind: inferredKind,
    path,
    additions,
    deletions,
    before,
    after,
    patch,
  });
}

export function getToolChangePath(part: ToolPart): string | null {
  return (
    getToolFileChanges(part.tool, part.state).find((change) => !change.isSummary)?.path || null
  );
}

function diffCount(diff: FileDiff, primary: 'additions' | 'deletions', alias: string): number {
  const record = diff as unknown as Record<string, unknown>;
  const value = record[primary];
  if (typeof value === 'number') return value;
  const aliased = record[alias];
  return typeof aliased === 'number' ? aliased : 0;
}

function diffKind(diff: FileDiff): FileChangeKind {
  const before = (diff as unknown as Record<string, unknown>).before;
  const after = (diff as unknown as Record<string, unknown>).after;
  if (before === '' && typeof after === 'string' && after !== '') return 'added';
  if (after === '' && typeof before === 'string' && before !== '') return 'removed';
  return 'edited';
}

/**
 * Build file changes from a session/message diff summary, deduplicated per file.
 * This is the authoritative source the session list counts from, so anything
 * derived from it stays in sync.
 */
export function getDiffFileChanges(diffs: readonly FileDiff[]): FileChange[] {
  const byFile = new Map<string, FileChange>();
  for (const diff of diffs) {
    if (!diff || typeof diff.file !== 'string' || diff.file === '') continue;
    const change = withDedupeKey({
      kind: diffKind(diff),
      path: diff.file,
      additions: diffCount(diff, 'additions', 'added'),
      deletions: diffCount(diff, 'deletions', 'removed'),
    });
    const key = normalizePath(diff.file);
    const existing = byFile.get(key);
    if (!existing) {
      byFile.set(key, change);
      continue;
    }
    existing.kind = change.kind;
    existing.additions = (existing.additions ?? 0) + (change.additions ?? 0);
    existing.deletions = (existing.deletions ?? 0) + (change.deletions ?? 0);
  }
  return [...byFile.values()];
}

// The same file is often reported twice — once by a tool (absolute path) and
// once by a patch part (workspace-relative path). Treat them as one file when
// the absolute form ends with the relative form.
function isSameFileKey(a: string, b: string): boolean {
  if (a === b) return true;
  const aAbs = isAbsolutePath(a);
  const bAbs = isAbsolutePath(b);
  if (aAbs === bAbs) return false;
  const [abs, rel] = aAbs ? [a, b] : [b, a];
  return abs.endsWith(`/${rel}`);
}

function hasExtension(path: string): boolean {
  // A dot in the final segment signals a file (extension, e.g. `app.ts`, or a
  // dotfile, e.g. `.gitignore`); bare segments like `src/extension` are dirs.
  const basename = path.slice(path.lastIndexOf('/') + 1);
  return basename.includes('.');
}

type SummaryMessage = {
  info?: { summary?: { diffs?: readonly FileDiff[] } | unknown };
  parts: readonly Part[];
};

/**
 * Collect the deduplicated set of file changes across a session's messages, in
 * the order each file was first touched. This is the single enumeration shared
 * by the session list count and the in-chat Files block, so the two agree.
 *
 * It folds together message-level diff summaries, file-changing tool calls, and
 * patch parts. The same file is merged across absolute (tool) and relative
 * (patch) path forms, line counts accumulate, and directory entries (no
 * extension and no line counts) are dropped.
 */
export function getMessageFileChanges(
  messages: readonly SummaryMessage[],
  workspacePath?: string | null
): FileChange[] {
  const result: FileChange[] = [];

  const keyFor = (change: FileChange) => {
    const path = change.toPath || change.path;
    return (getWorkspaceRelativePath(path, workspacePath) ?? normalizePath(path)).replace(
      /^\.\//,
      ''
    );
  };

  const record = (change: FileChange) => {
    const key = keyFor(change);
    const existing = result.find((entry) => isSameFileKey(keyFor(entry), key));
    if (!existing) {
      result.push({ ...change });
      return;
    }
    existing.kind = change.kind;
    // Prefer the shorter (workspace-relative) path for display.
    if ((change.toPath || change.path).length < (existing.toPath || existing.path).length) {
      existing.path = change.path;
      if (change.fromPath !== undefined) existing.fromPath = change.fromPath;
      if (change.toPath !== undefined) existing.toPath = change.toPath;
    }
    existing.dedupeKey = change.dedupeKey;
    existing.additions = (existing.additions ?? 0) + (change.additions ?? 0);
    existing.deletions = (existing.deletions ?? 0) + (change.deletions ?? 0);
  };

  for (const message of messages) {
    const summary = message.info?.summary;
    const summaryDiffs =
      summary && typeof summary === 'object' && 'diffs' in summary && Array.isArray(summary.diffs)
        ? (summary.diffs as readonly FileDiff[])
        : [];
    for (const change of getDiffFileChanges(summaryDiffs)) record(change);

    for (const part of message.parts) {
      if (part.type === 'tool') {
        for (const change of getToolFileChanges(part.tool, (part as ToolPart).state)) {
          if (!change.isSummary) record(change);
        }
        continue;
      }
      if (part.type === 'patch') {
        for (const file of part.files) {
          if (file) record(withDedupeKey({ kind: 'edited', path: file }));
        }
      }
    }
  }

  // Drop directory entries: paths that are an ancestor of another changed path,
  // or that have no file extension and no line counts. Real edited files keep an
  // extension or carry actual +/- counts.
  const keys = result.map(keyFor);
  return result.filter((change, index) => {
    const key = keys[index]!;
    const isAncestor = keys.some(
      (other, otherIndex) => otherIndex !== index && other.startsWith(`${key}/`)
    );
    if (isAncestor) return false;
    const hasCounts = (change.additions ?? 0) > 0 || (change.deletions ?? 0) > 0;
    return hasExtension(key) || hasCounts;
  });
}
