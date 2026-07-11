import type { FileDiff, Part, ToolPart, ToolState } from '../types';
import { getWorkspaceRelativePath, isAbsolutePath, normalizePath } from './path-display';

export type FileChangeKind = 'added' | 'edited' | 'removed' | 'moved';

export type FileChange = {
  kind: FileChangeKind;
  path: string;
  fromPath?: string;
  toPath?: string;
  additions?: number;
  deletions?: number;
  dedupeKey: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function withDedupeKey(change: Omit<FileChange, 'dedupeKey'>): FileChange {
  const result: FileChange = {
    kind: change.kind,
    path: change.path,
    dedupeKey:
      change.kind === 'moved'
        ? `moved:${normalizePath(change.fromPath || '')}->${normalizePath(change.toPath || change.path)}`
        : `${change.kind}:${normalizePath(change.path)}`,
  };
  if (change.fromPath !== undefined) result.fromPath = change.fromPath;
  if (change.toPath !== undefined) result.toPath = change.toPath;
  if (change.additions !== undefined) result.additions = change.additions;
  if (change.deletions !== undefined) result.deletions = change.deletions;
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

function computeToolFileChanges(toolName: string, toolState: ToolState): FileChange[] {
  const metadata = getToolMetadata(toolState) || {};
  const metadataChanges = fileChangesFromMetadataFiles(metadata);
  if (metadataChanges.length > 0) return metadataChanges;

  const normalizedToolName = toolName.trim().toLowerCase().split('.').pop();
  if (normalizedToolName === 'apply_patch') {
    const inputChanges = fileChangesFromPatchInput(
      (toolState.input || {}) as Record<string, unknown>
    );
    if (inputChanges.length > 0) return inputChanges;
  }

  const single = computeToolFileChange(toolName, toolState);
  return single ? [single] : [];
}

function fileChangesFromMetadataFiles(metadata: Record<string, unknown>): FileChange[] {
  const files = metadata.files;
  if (!Array.isArray(files)) return [];

  return files.flatMap((item) => {
    if (!isRecord(item)) return [];
    const primaryPath = firstString(item, ['relativePath', ...PRIMARY_PATH_KEYS]);
    const fromPath =
      firstString(item, SOURCE_PATH_KEYS) || firstString(item, ['filePath', 'filepath']);
    const toPath =
      firstString(item, ['movePath', 'move_path']) || firstString(item, ['relativePath']);
    const kind =
      kindFromText(firstString(item, OPERATION_KEYS)) || (toPath && fromPath ? 'moved' : null);
    const additions = numberValue(item, 'additions');
    const deletions = numberValue(item, 'deletions');

    if (kind === 'moved') {
      const path = toPath || primaryPath || fromPath;
      if (!path) return [];
      return [withDedupeKey({ kind, path, fromPath, toPath, additions, deletions })];
    }

    const path = primaryPath || toPath || fromPath;
    if (!path || !kind) return [];
    return [withDedupeKey({ kind, path, additions, deletions })];
  });
}

function fileChangesFromPatchInput(input: Record<string, unknown>): FileChange[] {
  const patchText = firstString(input, ['patchText', 'patch_text', 'patch']);
  if (!patchText) return [];

  const headerPattern = /^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/gm;
  const headers = [...patchText.matchAll(headerPattern)];
  return headers.flatMap((match, index) => {
    const operation = match[1]?.toLowerCase();
    const path = stripPathWrapping(match[2] || '');
    if (!operation || !path) return [];

    if (operation === 'update') {
      const sectionEnd = headers[index + 1]?.index ?? patchText.length;
      const section = patchText.slice((match.index ?? 0) + match[0].length, sectionEnd);
      const movePath = section.match(/^\*\*\* Move to:\s*(.+?)\s*$/m)?.[1];
      if (movePath) {
        const toPath = stripPathWrapping(movePath);
        if (toPath) {
          return [withDedupeKey({ kind: 'moved', path: toPath, fromPath: path, toPath })];
        }
      }
    }

    const kind = operation === 'add' ? 'added' : operation === 'delete' ? 'removed' : 'edited';
    return [withDedupeKey({ kind, path })];
  });
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
  });
}

export function getToolChangePath(part: ToolPart): string | null {
  return getToolFileChange(part.tool, part.state)?.path || null;
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
          record(change);
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
