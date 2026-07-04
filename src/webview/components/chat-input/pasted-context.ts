import { client } from '../../lib/client';
import { addContextFile } from '../../lib/state';
import { getWorkspaceRelativePath, isAbsolutePath, normalizePath } from '../../lib/path-display';
import { mergeContextFile, parseSelectionReference } from '../../../shared/context-files';
import type { DroppedFile } from '../../../shared/protocol';

export function getPastedContextFiles(text: string, workspacePath: string | null): DroppedFile[] {
  if (!text.trim()) return [];

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const files = new Map<string, DroppedFile>();

  for (const line of lines) {
    const selectionRef = parseSelectionReference(line);
    if (selectionRef) {
      const file = createDroppedFileFromReference(selectionRef.path!, workspacePath, false);
      if (!file) continue;
      addOrMergePastedContextFile(files, { ...file, lineRanges: selectionRef.lineRanges });
      continue;
    }

    const activeFileMatch = line.match(/^\[Active file: (.+?)\]$/);
    if (activeFileMatch) {
      const file = createDroppedFileFromReference(activeFileMatch[1]!, workspacePath, false);
      if (file) addOrMergePastedContextFile(files, file);
    }
  }

  return Array.from(files.values());
}

export async function addPastedMentionContextFiles(text: string) {
  if (!text.trim()) return;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const files = new Map<string, DroppedFile>();

  for (const line of lines) {
    for (const mention of extractPastedFileMentions(line)) {
      const file = await resolveDroppedFileReference(mention.path, mention.isDirectory);
      if (file) addOrMergePastedContextFile(files, file);
    }
  }

  for (const file of files.values()) {
    addContextFile(file);
  }
}

export function getPromptTextWithoutContextReferences(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (parseSelectionReference(line)) return false;
      if (/^\[Active file: .+\]$/.test(line)) return false;
      return (
        extractPastedFileMentions(line).length === 0 ||
        line.replace(/(^|[\s(])@([^\s@]+?\/?)(?=$|[\s),.:;!?])/g, '$1').trim().length > 0
      );
    })
    .join('\n')
    .trim();
}

function extractPastedFileMentions(line: string): Array<{ path: string; isDirectory: boolean }> {
  const matches = line.matchAll(/(^|[\s(])@([^\s@)]+?\/?)(?=$|[\s),:;!?])/g);
  const mentions: Array<{ path: string; isDirectory: boolean }> = [];

  for (const match of matches) {
    const rawPath = match[2]?.trim();
    const isDirectory = rawPath?.endsWith('/') ?? false;
    if (!rawPath || !isLikelyFileMentionPath(rawPath, isDirectory)) continue;
    mentions.push({
      path: rawPath.replace(/\/+$/, ''),
      isDirectory,
    });
  }

  return mentions;
}

function isLikelyFileMentionPath(value: string, isDirectory = false) {
  const normalized = normalizePath(value.replace(/^\.\//, ''));
  if (!normalized) return false;
  if (normalized === '.' || normalized === '..') return false;
  if (isDirectory) return true;
  if (normalized.includes('/')) return true;
  return /\.[A-Za-z0-9_-]{1,16}$/.test(normalized);
}

async function resolveDroppedFileReference(
  referencePath: string,
  isDirectory: boolean
): Promise<DroppedFile | null> {
  const normalizedReference = normalizePath(referencePath);
  if (!normalizedReference) return null;

  const resolved = await client.varro.resolveWorkspacePath(normalizedReference);
  if (!resolved) return null;
  if (isDirectory && resolved.type !== 'directory') return null;

  return resolved;
}

function createDroppedFileFromReference(
  referencePath: string,
  workspacePath: string | null,
  isDirectory: boolean
): DroppedFile | null {
  const normalizedReference = normalizePath(referencePath);
  if (!normalizedReference) return null;

  const relativePath = isAbsolutePath(normalizedReference)
    ? (getWorkspaceRelativePath(normalizedReference, workspacePath) ?? normalizedReference)
    : normalizedReference;
  const absolutePath = isAbsolutePath(normalizedReference)
    ? normalizedReference
    : workspacePath
      ? `${normalizePath(workspacePath).replace(/\/+$/, '')}/${normalizedReference.replace(/^\.\//, '')}`
      : normalizedReference;

  return {
    path: absolutePath,
    relativePath,
    type: isDirectory ? 'directory' : 'file',
  };
}

function addOrMergePastedContextFile(files: Map<string, DroppedFile>, file: DroppedFile) {
  const current = files.get(file.path);
  if (!current) {
    files.set(file.path, file);
    return;
  }

  files.set(file.path, mergeContextFile(current, file));
}
