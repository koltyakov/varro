import {
  getRelativePathWithinWorkspace,
  isAbsoluteWorkspacePath,
  isSameWorkspacePath,
} from '../../shared/workspace-path';

export function normalizePath(value: string) {
  if (!value) return value;
  const normalized = value.replace(/\\/g, '/');
  const trimmed = normalized.replace(/\/+$/, '');
  if (!trimmed) return normalized.startsWith('/') ? '/' : normalized;
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}/`;
  if (/^\/\/\?\/Volume\{[^/]+\}$/i.test(trimmed)) return `${trimmed}/`;
  return trimmed;
}

function trimTrailingSlashes(value: string) {
  return value.replace(/\/+$/, '');
}

export function isAbsolutePath(path: string) {
  return isAbsoluteWorkspacePath(path);
}

export function getLeafPathName(path: string): string {
  if (!path) return path;

  const normalizedPath = trimTrailingSlashes(normalizePath(path));
  if (!normalizedPath) return path;

  const segments = normalizedPath.split('/').filter(Boolean);
  return segments[segments.length - 1] || path;
}

export function getWorkspaceRelativePath(
  path: string,
  workspacePath: string | null | undefined
): string | null {
  if (!path || !workspacePath) return null;

  return getRelativePathWithinWorkspace(normalizePath(path), normalizePath(workspacePath));
}

export function formatDisplayPath(path: string, workspacePath: string | null | undefined): string {
  const relativePath = getWorkspaceRelativePath(path, workspacePath);
  if (relativePath) return relativePath;
  if (isAbsolutePath(path)) return getLeafPathName(path);
  return path;
}

export function getDroppedFileLabel(file: { path: string; relativePath: string }) {
  if (!file.relativePath || file.relativePath === '.') {
    return getLeafPathName(file.path);
  }
  return getLeafPathName(file.relativePath);
}

export function isSamePath(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  return isSameWorkspacePath(normalizePath(a), normalizePath(b));
}
