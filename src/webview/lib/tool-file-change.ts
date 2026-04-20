import type { ToolPart, ToolState } from '../types';
import { normalizePath } from './path-display';

export type FileChangeKind = 'added' | 'edited' | 'removed' | 'moved';

export type FileChange = {
  kind: FileChangeKind;
  path: string;
  fromPath?: string;
  toPath?: string;
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

const PRIMARY_PATH_KEYS = ['file_path', 'filePath', 'path', 'filename'];
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
    const fromPath = stripPathWrapping(movedMatch[2]);
    const toPath = stripPathWrapping(movedMatch[3]);
    if (!looksLikePath(fromPath) || !looksLikePath(toPath)) return null;
    return { kind: 'moved', path: toPath, fromPath, toPath };
  }

  const basicMatch = trimmed.match(
    /^(added|created|edited|updated|modified|removed|deleted)\s+(.+)$/i
  );
  if (!basicMatch) return null;

  const action = basicMatch[1].toLowerCase();
  const path = stripPathWrapping(basicMatch[2]);
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

export function getToolFileChange(toolName: string, toolState: ToolState): FileChange | null {
  const cached = toolFileChangeCache.get(toolState);
  if (cached !== undefined) return cached;

  const result = computeToolFileChange(toolName, toolState);
  toolFileChangeCache.set(toolState, result);
  return result;
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
      return {
        ...titleChange,
        dedupeKey: `moved:${normalizePath(titleChange.fromPath || '')}->${normalizePath(titleChange.toPath || titleChange.path)}`,
      };
    }
    return {
      kind: 'moved',
      path,
      fromPath: from,
      toPath: to,
      dedupeKey: `moved:${normalizePath(from || '')}->${normalizePath(to || path)}`,
    };
  }

  const path = primaryPath || toPath || fromPath;
  if (!path) {
    const titleChange = parseTitleFileChange(title);
    if (!titleChange || titleChange.kind === 'moved') return null;
    return {
      ...titleChange,
      dedupeKey: `${titleChange.kind}:${normalizePath(titleChange.path)}`,
    };
  }
  return {
    kind: inferredKind,
    path,
    dedupeKey: `${inferredKind}:${normalizePath(path)}`,
  };
}

export function getToolChangePath(part: ToolPart): string | null {
  return getToolFileChange(part.tool, part.state)?.path || null;
}
