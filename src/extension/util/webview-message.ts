import type { DesktopSessionPaneSide, WebviewMessage } from '../../shared/protocol';

const MAX_PATH_LENGTH = 4096;
const MAX_QUERY_LENGTH = 2048;
const MAX_LOG_FIELD_LENGTH = 10_000;
const MAX_SEARCH_QUERY_LENGTH = 200;
const MAX_DROPPED_PATHS = 100;
const MAX_DROPPED_CONTENT_FILES = 20;
const MAX_DROPPED_CONTENT_BYTES = 25 * 1024 * 1024;
const MAX_DROPPED_CONTENT_NAME_LENGTH = 512;
const MAX_DROPPED_CONTENT_BASE64_LENGTH = Math.ceil((MAX_DROPPED_CONTENT_BYTES * 4) / 3) + 4;
const API_BASE = 'http://varro.local';

export function parseWebviewMessage(value: unknown): WebviewMessage | null {
  const message = asRecord(value);
  const type = getString(message?.type);
  if (!type) return null;

  switch (type) {
    case 'ready':
    case 'context/request':
    case 'providers/refresh':
    case 'terminal-selection/clear':
    case 'files/clear':
    case 'files/pick':
      return { type } as WebviewMessage;

    case 'session/export': {
      const payload = asRecord(message?.payload);
      const sessionId = getBoundedString(payload?.sessionId, 512);
      return sessionId ? { type, payload: { sessionId } } : null;
    }

    case 'vscode/open-settings': {
      const payload = asRecord(message?.payload);
      const query = getOptionalBoundedString(payload?.query, 200);
      return query ? { type, payload: { query } } : { type, payload: {} };
    }

    case 'webview/focus': {
      const payload = asRecord(message?.payload);
      return typeof payload?.focused === 'boolean'
        ? { type, payload: { focused: payload.focused } }
        : null;
    }

    case 'terminal/run': {
      const payload = asRecord(message?.payload);
      const command = getBoundedString(payload?.command, 200);
      const title = getOptionalBoundedString(payload?.title, 120);
      if (command !== 'opencode auth login' && command !== 'opencode auth') return null;
      return { type, payload: title ? { command, title } : { command } };
    }

    case 'files/drop': {
      const payload = asRecord(message?.payload);
      if (!Array.isArray(payload?.paths) || payload.paths.length > MAX_DROPPED_PATHS) return null;
      const paths = payload.paths.map((path) => getBoundedString(path, MAX_PATH_LENGTH));
      return paths.every((path): path is string => Boolean(path))
        ? { type, payload: { paths } }
        : null;
    }

    case 'files/drop-content': {
      const payload = asRecord(message?.payload);
      if (!Array.isArray(payload?.files) || payload.files.length === 0) return null;
      if (payload.files.length > MAX_DROPPED_CONTENT_FILES) return null;
      const files: Array<{ name: string; content: string; size: number }> = [];
      for (const entry of payload.files) {
        const record = asRecord(entry);
        const name = getBoundedString(record?.name, MAX_DROPPED_CONTENT_NAME_LENGTH);
        const content = getBoundedString(record?.content, MAX_DROPPED_CONTENT_BASE64_LENGTH, true);
        const size = getSafeInteger(record?.size);
        if (!name || content === null || size === null || size > MAX_DROPPED_CONTENT_BYTES)
          return null;
        files.push({ name, content, size });
      }
      return { type, payload: { files } };
    }

    case 'files/remove':
    case 'file/read': {
      const payload = asRecord(message?.payload);
      const path = getBoundedString(payload?.path, MAX_PATH_LENGTH);
      return path ? ({ type, payload: { path } } as WebviewMessage) : null;
    }

    case 'files/search': {
      const payload = asRecord(message?.payload);
      const requestId = getSafeInteger(payload?.requestId);
      const query = getBoundedString(payload?.query, MAX_SEARCH_QUERY_LENGTH, true);
      const limit = payload?.limit === undefined ? undefined : getSafeInteger(payload.limit);
      if (
        requestId === null ||
        query === null ||
        (payload?.limit !== undefined && limit === null)
      ) {
        return null;
      }
      return {
        type,
        payload: limit == null ? { requestId, query } : { requestId, query, limit },
      };
    }

    case 'vscode/open': {
      const payload = asRecord(message?.payload);
      const path = getBoundedString(payload?.path, MAX_PATH_LENGTH);
      const line = payload?.line === undefined ? undefined : getSafeInteger(payload.line);
      const kind = payload?.kind;
      if (!path || (payload?.line !== undefined && line === null)) return null;
      if (kind !== undefined && kind !== 'auto' && kind !== 'file' && kind !== 'directory')
        return null;
      return {
        type,
        payload: {
          path,
          ...(line !== undefined && line !== null ? { line } : {}),
          ...(kind ? { kind } : {}),
        },
      };
    }

    case 'vscode/open-external': {
      const payload = asRecord(message?.payload);
      const url = getBoundedString(payload?.url, MAX_PATH_LENGTH);
      return url && isAllowedExternalUrl(url) ? { type, payload: { url } } : null;
    }

    case 'config/update': {
      const payload = asRecord(message?.payload);
      const desktopSessionPaneSide = getDesktopSessionPaneSide(payload?.desktopSessionPaneSide);
      return typeof payload?.expandThinkingByDefault === 'boolean' &&
        typeof payload?.showStickyUserPrompt === 'boolean' &&
        desktopSessionPaneSide
        ? {
            type,
            payload: {
              expandThinkingByDefault: payload.expandThinkingByDefault,
              showStickyUserPrompt: payload.showStickyUserPrompt,
              desktopSessionPaneSide,
            },
          }
        : null;
    }

    case 'api/request': {
      const payload = asRecord(message?.payload);
      const id = getSafeInteger(payload?.id);
      const method = getBoundedString(payload?.method, 16)?.toUpperCase() || null;
      const path = getBoundedString(payload?.path, MAX_PATH_LENGTH + MAX_QUERY_LENGTH);
      if (id === null || !method || !path || !isAllowedApiRequest(method, path)) return null;
      return { type, payload: { id, method, path, body: payload?.body } };
    }

    case 'log': {
      const payload = asRecord(message?.payload);
      const msg = getBoundedString(payload?.msg, MAX_LOG_FIELD_LENGTH);
      const data = getOptionalBoundedString(payload?.data, MAX_LOG_FIELD_LENGTH);
      const error = getOptionalBoundedString(payload?.error, MAX_LOG_FIELD_LENGTH);
      const level = payload?.level;
      if (!msg) return null;
      if (level !== undefined && level !== 'info' && level !== 'warn' && level !== 'error')
        return null;
      return {
        type,
        payload: {
          msg,
          ...(data ? { data } : {}),
          ...(error ? { error } : {}),
          ...(level ? { level } : {}),
        },
      };
    }

    default:
      return null;
  }
}

export function isAllowedExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isAllowedApiRequest(method: string, path: string) {
  const url = parseRelativeApiUrl(path);
  if (!url) return false;
  const pathname = url.pathname;
  const segments = pathname.split('/').filter(Boolean);
  if (!segments.every(isSafePathSegment)) return false;

  const hasOnlyQuery = (...keys: string[]) => {
    for (const key of url.searchParams.keys()) {
      if (!keys.includes(key)) return false;
    }
    return true;
  };
  const noQuery = () => !url.search;

  if (pathname === '/global/health') return method === 'GET' && noQuery();
  if (pathname === '/global/config') return method === 'GET' && noQuery();
  if (pathname === '/config/providers') return method === 'GET' && noQuery();
  if (pathname === '/provider/auth') return method === 'GET' && noQuery();
  if (pathname === '/command') return method === 'GET' && noQuery();
  if (pathname === '/mcp') return method === 'GET' && noQuery();
  if (pathname === '/file/status') return method === 'GET' && noQuery();
  if (pathname === '/agent') return method === 'GET' && noQuery();
  if (pathname === '/question') return method === 'GET' && noQuery();
  if (pathname === '/session') return (method === 'GET' || method === 'POST') && noQuery();
  if (pathname === '/session/status') return method === 'GET' && noQuery();
  if (pathname === '/experimental/workspace/status') return method === 'GET' && noQuery();
  if (pathname === '/varro/provider-limit') {
    return (
      method === 'GET' &&
      hasOnlyQuery('providerID', 'modelID') &&
      Boolean(url.searchParams.get('providerID')?.trim())
    );
  }
  if (pathname === '/varro/workspace-file') {
    return (
      method === 'GET' && hasOnlyQuery('path') && Boolean(url.searchParams.get('path')?.trim())
    );
  }
  if (pathname === '/varro/workspace-path/resolve') {
    return (
      method === 'GET' && hasOnlyQuery('path') && Boolean(url.searchParams.get('path')?.trim())
    );
  }
  if (pathname === '/varro/workspace-file/pick') {
    return method === 'GET' && noQuery();
  }
  if (pathname === '/varro/opencode-config') {
    return method === 'GET' && noQuery();
  }
  if (pathname === '/varro/opencode-config/model-routing') {
    return method === 'POST' && noQuery();
  }
  if (segments[0] === 'varro' && segments[1] === 'session' && segments.length === 4) {
    return method === 'DELETE' && noQuery() && segments[3] === 'delete';
  }
  if (pathname === '/varro/session-trash') {
    return (method === 'GET' || method === 'DELETE') && noQuery();
  }
  if (pathname === '/varro/plan/open') return method === 'POST' && noQuery();

  if (segments[0] === 'varro' && segments[1] === 'session-trash' && segments.length === 4) {
    return (
      noQuery() &&
      ((method === 'POST' && segments[3] === 'restore') ||
        (method === 'DELETE' && segments[3] === 'delete'))
    );
  }

  if (segments[0] === 'question' && segments.length === 3) {
    return method === 'POST' && noQuery() && (segments[2] === 'reply' || segments[2] === 'reject');
  }

  if (segments[0] === 'mcp' && segments.length === 3) {
    return (
      method === 'POST' && noQuery() && (segments[2] === 'connect' || segments[2] === 'disconnect')
    );
  }

  if (segments[0] === 'provider' && segments.length === 4) {
    return (
      method === 'POST' &&
      noQuery() &&
      segments[2] === 'oauth' &&
      (segments[3] === 'authorize' || segments[3] === 'callback')
    );
  }

  if (pathname === '/experimental/workspace/warp') {
    return method === 'POST' && noQuery();
  }

  if (segments[0] !== 'session' || segments.length < 2) return false;
  if (segments.length === 2) {
    return (method === 'GET' || method === 'PATCH' || method === 'DELETE') && noQuery();
  }
  if (segments.length === 3) {
    if (segments[2] === 'diff') return method === 'GET' && hasOnlyQuery('messageID');
    if (segments[2] === 'message') return method === 'GET' && noQuery();
    return (
      method === 'POST' &&
      noQuery() &&
      ['abort', 'prompt_async', 'revert', 'summarize', 'unrevert', 'init', 'command'].includes(
        segments[2]
      )
    );
  }
  if (segments.length === 4 && segments[2] === 'permissions') {
    return method === 'POST' && noQuery();
  }
  return false;
}

function parseRelativeApiUrl(path: string): URL | null {
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  try {
    const url = new URL(path, API_BASE);
    if (url.origin !== API_BASE) return null;
    if (url.pathname.length > MAX_PATH_LENGTH || url.search.length > MAX_QUERY_LENGTH) return null;
    return url;
  } catch {
    return null;
  }
}

function isSafePathSegment(segment: string) {
  if (!segment || segment === '.' || segment === '..') return false;
  if (segment.length > 512) return false;
  return !/%2f|%5c/i.test(segment);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getString(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function getBoundedString(value: unknown, maxLength: number, allowEmpty = false) {
  if (typeof value !== 'string') return null;
  if ((!allowEmpty && value.length === 0) || value.length > maxLength) return null;
  return value;
}

function getOptionalBoundedString(value: unknown, maxLength: number) {
  if (value === undefined || value === null) return undefined;
  return getBoundedString(value, maxLength) || undefined;
}

function getSafeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function getDesktopSessionPaneSide(value: unknown): DesktopSessionPaneSide | null {
  return value === 'left' || value === 'right' ? value : null;
}
