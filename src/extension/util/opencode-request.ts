export function scopeOpenCodeRequest(baseUrl: string, path: string, directory?: string) {
  const url = new URL(path, baseUrl);
  if (!path.startsWith('/') || path.startsWith('//') || url.origin !== baseUrl) {
    throw new Error('Unsupported OpenCode API path');
  }

  const normalizedDirectory = normalizeOpenCodeDirectory(directory);
  const hasExplicitDirectory = url.searchParams.has('directory');
  const explicitDirectory = hasExplicitDirectory
    ? normalizeOpenCodeDirectory(url.searchParams.get('directory') || undefined)
    : undefined;

  if (!url.pathname.startsWith('/global/')) {
    if (explicitDirectory) {
      url.searchParams.set('directory', explicitDirectory);
    } else if (hasExplicitDirectory) {
      url.searchParams.delete('directory');
    } else if (normalizedDirectory) {
      url.searchParams.set('directory', normalizedDirectory);
    }
  }

  const scopedDirectory = !url.pathname.startsWith('/global/')
    ? (explicitDirectory ?? normalizedDirectory)
    : normalizedDirectory;

  return { url: url.toString(), directory: scopedDirectory };
}

export function getOpenCodeDirectoryHeaders(directory?: string): Record<string, string> {
  if (!directory) return {};
  return { 'x-opencode-directory': directory };
}

function normalizeOpenCodeDirectory(directory: string | undefined) {
  if (!directory) return undefined;
  const trimmed = directory.trim();
  if (!trimmed) return undefined;
  // Preserve the original directory spelling. OpenCode session lookups on
  // Windows have regressed when Varro rewrote drive casing or path separators.
  // We only trim trailing separators so equivalent user input stays stable
  // without changing the underlying path identity.
  const normalized = trimmed.replace(/[\\/]+$/, '');
  return normalized || trimmed;
}
