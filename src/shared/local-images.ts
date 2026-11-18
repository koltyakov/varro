export type LocalImageResponse = { url: string; path: string; mime: string };
export type LocalImageRequest = {
  path: string;
  directory?: string;
  sessionID?: string;
  original?: boolean;
};

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
  // oxlint-disable-next-line no-control-regex -- Reject control characters at the local file boundary.
  return path && !/[\u0000-\u001f\u007f]/.test(path) ? path : null;
}
