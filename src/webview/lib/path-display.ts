function normalizePath(value: string) {
  return value.replace(/\\/g, '/');
}

function trimTrailingSlashes(value: string) {
  return value.replace(/\/+$/, '');
}

function isAbsolutePath(path: string) {
  const normalizedPath = normalizePath(path);
  return normalizedPath.startsWith('/') || /^[A-Za-z]:\//.test(normalizedPath);
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

  const normalizedPath = normalizePath(path);
  const normalizedWorkspace = trimTrailingSlashes(normalizePath(workspacePath));
  if (!normalizedWorkspace) return null;

  if (normalizedPath === normalizedWorkspace) return '.';
  if (!normalizedPath.startsWith(`${normalizedWorkspace}/`)) return null;

  return normalizedPath.slice(normalizedWorkspace.length + 1);
}

export function formatDisplayPath(path: string, workspacePath: string | null | undefined): string {
  const relativePath = getWorkspaceRelativePath(path, workspacePath);
  if (relativePath) return relativePath;
  if (isAbsolutePath(path)) return getLeafPathName(path);
  return path;
}
