export function normalizeWorkspaceIdentity(path: string | null | undefined): string | null {
  if (!path) return null;

  const windowsPath = isWindowsWorkspacePath(path);
  let normalized = windowsPath ? path.replace(/\\/g, '/') : path;
  if (normalized.startsWith('//')) {
    normalized = `//${normalized.slice(2).replace(/\/+/g, '/')}`;
  } else {
    normalized = normalized.replace(/\/+/g, '/');
  }

  if (normalized !== '/' && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.replace(/\/+$/, '');
  }
  if (!normalized) return null;
  return windowsPath ? normalized.toLowerCase() : normalized;
}

function isWindowsWorkspacePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(path);
}

export function isSameWorkspacePath(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  const normalizedLeft = normalizeWorkspaceIdentity(left);
  const normalizedRight = normalizeWorkspaceIdentity(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}
