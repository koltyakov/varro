interface NormalizedWorkspacePath {
  absolute: boolean;
  displaySegments: string[];
  identity: string;
  identitySegments: string[];
  root: string;
}

export function normalizeWorkspaceIdentity(path: string | null | undefined): string | null {
  return normalizeWorkspacePath(path)?.identity ?? null;
}

export function isSameWorkspacePath(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  const normalizedLeft = normalizeWorkspaceIdentity(left);
  const normalizedRight = normalizeWorkspaceIdentity(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

export function getRelativePathWithinWorkspace(
  path: string | null | undefined,
  workspacePath: string | null | undefined
): string | null {
  const normalizedPath = normalizeWorkspacePath(path);
  const normalizedWorkspace = normalizeWorkspacePath(workspacePath);
  if (!normalizedPath || !normalizedWorkspace || normalizedPath.root !== normalizedWorkspace.root) {
    return null;
  }
  if (normalizedPath.identitySegments.length < normalizedWorkspace.identitySegments.length) {
    return null;
  }
  if (
    !normalizedWorkspace.identitySegments.every(
      (segment, index) => segment === normalizedPath.identitySegments[index]
    )
  ) {
    return null;
  }
  if (normalizedPath.identitySegments.length === normalizedWorkspace.identitySegments.length) {
    return '.';
  }
  return normalizedPath.displaySegments.slice(normalizedWorkspace.displaySegments.length).join('/');
}

export function isAbsoluteWorkspacePath(path: string | null | undefined): boolean {
  return normalizeWorkspacePath(path)?.absolute ?? false;
}

function normalizeWorkspacePath(path: string | null | undefined): NormalizedWorkspacePath | null {
  if (!path) return null;

  const extended = path.match(/^(?:\\\\|\/\/)\?[\\/](.*)$/s);
  if (extended) {
    const remainder = extended[1]!;
    const drive = normalizeWindowsDrivePath(remainder);
    if (drive) return drive;
    const volume = normalizeWindowsVolumePath(remainder);
    if (volume) return volume;
    const unc = remainder.match(/^UNC[\\/](.*)$/is);
    return unc ? normalizeWindowsUncPath(unc[1]!, true) : null;
  }

  if (/^(?:\\\\|\/\/)\.[\\/]/.test(path) || /^[\\/]+\?\?[\\/]/.test(path)) {
    return null;
  }

  return (
    normalizeWindowsDrivePath(path) || normalizeWindowsUncPath(path) || normalizePosixPath(path)
  );
}

function normalizeWindowsVolumePath(path: string): NormalizedWorkspacePath | null {
  const match = path.match(/^(Volume\{[^\\/]+\})[\\/](.*)$/is);
  if (!match) return null;

  const volume = match[1]!.toLowerCase();
  const displaySegments = windowsSegments(match[2]!);
  const identitySegments = displaySegments.map((segment) => segment.toLowerCase());
  return {
    absolute: true,
    displaySegments,
    identity: `//?/${volume}${identitySegments.length > 0 ? `/${identitySegments.join('/')}` : '/'}`,
    identitySegments,
    root: `volume:${volume}`,
  };
}

function normalizeWindowsDrivePath(path: string): NormalizedWorkspacePath | null {
  const match = path.match(/^([A-Za-z]):[\\/](.*)$/s);
  if (!match) return null;

  const drive = match[1]!;
  const displaySegments = windowsSegments(match[2]!);
  const identitySegments = displaySegments.map((segment) => segment.toLowerCase());
  const root = `drive:${drive.toLowerCase()}`;
  return {
    absolute: true,
    displaySegments,
    identity: `${drive.toLowerCase()}:/${identitySegments.join('/')}`,
    identitySegments,
    root,
  };
}

function normalizeWindowsUncPath(
  path: string,
  withoutNamespacePrefix = false
): NormalizedWorkspacePath | null {
  const match = withoutNamespacePrefix
    ? path.match(/^([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/s)
    : path.match(/^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/s);
  if (!match) return null;

  const server = match[1]!;
  const share = match[2]!;
  const displaySegments = windowsSegments(match[3] || '');
  const identitySegments = displaySegments.map((segment) => segment.toLowerCase());
  const normalizedServer = server.toLowerCase();
  const normalizedShare = share.toLowerCase();
  return {
    absolute: true,
    displaySegments,
    identity: `//${normalizedServer}/${normalizedShare}${
      identitySegments.length > 0 ? `/${identitySegments.join('/')}` : ''
    }`,
    identitySegments,
    root: `unc:${normalizedServer}/${normalizedShare}`,
  };
}

function normalizePosixPath(path: string): NormalizedWorkspacePath | null {
  let display = path;
  if (display.startsWith('//')) {
    display = `//${display.slice(2).replace(/\/+/g, '/')}`;
  } else {
    display = display.replace(/\/+/g, '/');
  }
  if (display !== '/') display = display.replace(/\/+$/, '');
  if (!display) return null;

  const displaySegments = display.split('/').filter(Boolean);
  return {
    absolute: display.startsWith('/'),
    displaySegments,
    identity: display,
    identitySegments: displaySegments,
    root: display.startsWith('//') ? 'posix://' : display.startsWith('/') ? 'posix:/' : 'relative',
  };
}

function windowsSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}
