export type LocalImageResponse = { url: string; path: string; mime: string };
export type LocalImageRequest = {
  path: string;
  directory?: string;
  sessionID?: string;
  original?: boolean;
};

/**
 * Two leading separators name a network share or device path. Resolving one on Windows can send
 * the user's credentials to that host, so reject it before any file system access.
 */
export function isNetworkOrDevicePath(path: string): boolean {
  return /^[\\/]{2}/.test(path.trimStart());
}

/** Parse local Markdown targets without admitting network URLs or executable schemes. */
export function parseLocalImagePath(source: string): string | null {
  if (!source || source.length > 4096 || source.startsWith('//')) return null;
  let path = source;
  if (/^file:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      if (url.hostname && url.hostname !== 'localhost') return null;
      path = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, '$1');
    } catch {
      return null;
    }
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^[A-Za-z]:[/\\]/.test(source)) return null;
    if (/[?#]/.test(source)) return null;
    try {
      path = decodeURIComponent(source);
    } catch {
      // Literal percent signs are valid in local filenames.
    }
  }
  if (!path || isNetworkOrDevicePath(path)) return null;
  // oxlint-disable-next-line no-control-regex -- Reject control characters at the local file boundary.
  return !/[\u0000-\u001f\u007f]/.test(path) ? path : null;
}
