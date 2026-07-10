export function normalizeWorkspaceIdentity(path: string | null | undefined): string | null {
  if (!path) return null;

  const windowsPath = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(path);
  let normalized = path.replace(/\\/g, '/');
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

export function isSameWorkspacePath(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  const normalizedLeft = normalizeWorkspaceIdentity(left);
  const normalizedRight = normalizeWorkspaceIdentity(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}
