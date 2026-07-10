export async function collectDroppedPaths(
  dataTransfer: DataTransfer | null,
  options: { includeFilePaths?: boolean; preferFileContent?: boolean } = {}
): Promise<string[]> {
  if (!dataTransfer) return [];

  const paths = new Set<string>();
  const preferFileContent =
    options.preferFileContent === true && Array.from(dataTransfer.files).length > 0;

  const knownTypes = [
    'CodeEditors',
    'CodeFiles',
    'text/uri-list',
    'ResourceURLs',
    'application/vnd.code.uri-list',
    'text/plain',
  ];
  const allTypes = Array.from(dataTransfer.types || []);
  for (const t of allTypes) {
    if (t.startsWith('application/vnd.code.') || !knownTypes.includes(t)) {
      knownTypes.push(t);
    }
  }

  for (const path of collectVSCodeDroppedPaths(dataTransfer)) {
    paths.add(path);
  }

  for (const type of knownTypes) {
    if (isCollectedVSCodeDropType(type)) continue;
    if (preferFileContent && !isVSCodeDropType(type)) continue;
    try {
      const data = dataTransfer.getData(type);
      for (const path of parseDroppedText(data)) {
        paths.add(path);
      }
    } catch {}
  }

  if (options.includeFilePaths !== false) {
    for (const file of Array.from(dataTransfer.files)) {
      const path = (file as File & { path?: string }).path;
      if (path) paths.add(path);
    }

    for (const item of Array.from(dataTransfer.items)) {
      const file = item.getAsFile() as (File & { path?: string }) | null;
      if (file?.path) paths.add(file.path);
    }
  }

  if (paths.size === 0 && !preferFileContent) {
    // Fall back to async string reading from ALL DataTransferItems
    const stringItems = Array.from(dataTransfer.items).filter((item) => item.kind === 'string');

    const itemText = await Promise.all(stringItems.map(readDroppedItem));

    for (const value of itemText) {
      for (const path of parseDroppedText(value)) {
        paths.add(path);
      }
    }
  }

  return Array.from(paths);
}

function isCollectedVSCodeDropType(type: string) {
  return (
    type === 'CodeEditors' ||
    type === 'CodeFiles' ||
    type === 'ResourceURLs' ||
    type === 'application/vnd.code.uri-list'
  );
}

function isVSCodeDropType(type: string) {
  return (
    type === 'CodeEditors' ||
    type === 'CodeFiles' ||
    type === 'ResourceURLs' ||
    type.startsWith('application/vnd.code.')
  );
}

function collectVSCodeDroppedPaths(dataTransfer: DataTransfer): string[] {
  const paths = new Set<string>();

  for (const path of parseCodeEditorsDrop(dataTransfer.getData('CodeEditors'))) {
    paths.add(path);
  }

  for (const path of parseCodeFilesDrop(dataTransfer.getData('CodeFiles'))) {
    paths.add(path);
  }

  for (const path of parseResourceListDrop(dataTransfer.getData('ResourceURLs'))) {
    paths.add(path);
  }

  for (const path of parseUriListDrop(dataTransfer.getData('application/vnd.code.uri-list'))) {
    paths.add(path);
  }

  return Array.from(paths);
}

function parseCodeEditorsDrop(value: string): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as unknown[];
    const paths = new Set<string>();
    for (const item of parsed) {
      if (!item) continue;
      if (typeof item === 'string') {
        const decoded = decodeDroppedCandidate(item);
        if (decoded) paths.add(decoded);
        continue;
      }
      if (typeof item !== 'object') continue;
      const resource = 'resource' in item ? (item.resource as string | undefined) : undefined;
      const uri = resource ? decodeDroppedCandidate(resource) : null;
      if (uri) paths.add(uri);
    }
    return Array.from(paths);
  } catch {
    return [];
  }
}

function parseCodeFilesDrop(value: string): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as unknown[];
    const paths = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const decoded = decodeDroppedCandidate(item);
      if (decoded) paths.add(decoded);
    }
    return Array.from(paths);
  } catch {
    return [];
  }
}

function parseResourceListDrop(value: string): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as unknown[];
    const paths = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const decoded = decodeDroppedCandidate(item);
      if (decoded) paths.add(decoded);
    }
    return Array.from(paths);
  } catch {
    return parseUriListDrop(value);
  }
}

function parseUriListDrop(value: string): string[] {
  if (!value) return [];
  const paths = new Set<string>();
  for (const entry of value.split(/\r?\n/)) {
    const decoded = decodeDroppedCandidate(entry.trim());
    if (decoded) paths.add(decoded);
  }
  return Array.from(paths);
}

export function readItemByType(dataTransfer: DataTransfer, type: string): Promise<string> {
  return new Promise((resolve) => {
    const item = Array.from(dataTransfer.items).find((i) => i.type === type && i.kind === 'string');
    if (!item) {
      resolve(dataTransfer.getData(type) || '');
      return;
    }
    item.getAsString((value) => resolve(value || ''));
  });
}

function readDroppedItem(item: DataTransferItem): Promise<string> {
  return new Promise((resolve) => {
    item.getAsString((value) => resolve(value || ''));
  });
}

export function parseDroppedText(value: string): string[] {
  if (!value) return [];

  const structuredPaths = extractPathsFromStructuredDrop(value);
  if (structuredPaths.length > 0) return structuredPaths;

  const paths = new Set<string>();

  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const decoded = decodeDroppedCandidate(trimmed);
    if (!decoded) return [];
    paths.add(decoded);
  }

  return Array.from(paths);
}

function decodeDroppedCandidate(value: string): string | null {
  return decodeDroppedPath(value) || decodeWorkspaceRelativePath(value);
}

function decodeDroppedPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/')) return trimmed;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    let pathname = decodeURIComponent(url.pathname);

    if (url.protocol === 'vscode-file:') {
      pathname = pathname.replace(/^\/vscode-app(?=\/|$)/, '');
    }

    if (
      url.protocol === 'vscode-resource:' &&
      url.hostname === 'file' &&
      pathname.startsWith('///')
    ) {
      pathname = pathname.slice(2);
    }

    if (url.protocol === 'file:' && url.hostname && !/^\/[A-Za-z]:\//.test(pathname)) {
      pathname = `//${url.hostname}${pathname}`;
    }

    return normalizeDroppedPath(pathname);
  } catch {
    return null;
  }
}

function normalizeDroppedPath(pathname: string): string | null {
  if (!pathname) return null;
  if (/^\/[A-Za-z]:\//.test(pathname)) return pathname.slice(1);
  if (/^[A-Za-z]:[\\/]/.test(pathname)) return pathname;
  return pathname.startsWith('/') || pathname.startsWith('//') ? pathname : null;
}

function decodeWorkspaceRelativePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  if (trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return null;
  if (/\s/.test(trimmed)) return null;

  const normalized = trimmed.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized === '..') return null;

  const looksPathLike =
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.startsWith('.') ||
    /^[^/\\]+\.[^/\\]+$/.test(trimmed);

  return looksPathLike ? normalized : null;
}

function extractPathsFromStructuredDrop(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed || !/^[[{"]/.test(trimmed)) return [];

  try {
    const parsed = JSON.parse(trimmed);
    const paths = new Set<string>();
    collectStructuredDropPaths(parsed, paths);
    return Array.from(paths);
  } catch {
    return [];
  }
}

function collectStructuredDropPaths(value: unknown, paths: Set<string>, keyHint = '') {
  if (typeof value === 'string') {
    const looksPathLike =
      !keyHint ||
      /(path|uri|url|resource)/i.test(keyHint) ||
      value.startsWith('/') ||
      value.startsWith('./') ||
      value.startsWith('../') ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      value.includes('/') ||
      value.includes('\\') ||
      /^[^/\\]+\.[^/\\]+$/.test(value) ||
      /^[a-z][a-z0-9+.-]*:/i.test(value);

    if (!looksPathLike) return;

    for (const candidate of value.split(/\r?\n/)) {
      const decoded = decodeDroppedCandidate(candidate);
      if (decoded) paths.add(decoded);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStructuredDropPaths(item, paths, keyHint);
    }
    return;
  }

  if (!value || typeof value !== 'object') return;

  for (const [key, entry] of Object.entries(value)) {
    collectStructuredDropPaths(entry, paths, key);
  }
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result || '')));
    reader.addEventListener('error', () =>
      reject(reader.error || new Error('Failed to read clipboard image'))
    );
    reader.readAsDataURL(file);
  });
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Unexpected FileReader result'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : '');
    });
    reader.addEventListener('error', () => reject(reader.error || new Error('FileReader failed')));
    reader.readAsDataURL(file);
  });
}
