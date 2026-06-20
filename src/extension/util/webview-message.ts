import type { DesktopSessionPaneSide, PermissionMode, WebviewMessage } from '../../shared/protocol';
import { asRecord } from '../../shared/type-utils';

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

    case 'providers/watch': {
      const payload = asRecord(message?.payload);
      return typeof payload?.active === 'boolean'
        ? { type, payload: { active: payload.active } }
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
      const defaultPermissionMode = getPermissionMode(payload?.defaultPermissionMode);
      return typeof payload?.expandThinkingByDefault === 'boolean' &&
        typeof payload?.showStickyUserPrompt === 'boolean' &&
        desktopSessionPaneSide &&
        defaultPermissionMode
        ? {
            type,
            payload: {
              expandThinkingByDefault: payload.expandThinkingByDefault,
              showStickyUserPrompt: payload.showStickyUserPrompt,
              desktopSessionPaneSide,
              defaultPermissionMode,
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

/**
 * Single source of truth for the webview -> OpenCode proxy security boundary.
 *
 * Each incoming `(method, path)` is matched against `API_ROUTES` top to bottom;
 * the first route whose path pattern matches decides the result (mirroring the
 * early-return semantics of the previous imperative cascade). A miss means the
 * request is rejected. Keep more specific patterns above the param/catch-all
 * patterns that could also match them (e.g. `/session/status` before
 * `/session/:id`, and `/session/:id/diff` before `/session/:id/:action`).
 */
export function isAllowedApiRequest(method: string, path: string) {
  const url = parseRelativeApiUrl(path);
  if (!url) return false;
  const segments = url.pathname.split('/').filter(Boolean);
  if (!segments.every(isSafePathSegment)) return false;

  for (const route of API_ROUTES) {
    const params = matchRouteSegments(route.segments, segments);
    if (params) return route.allow({ method, url, params });
  }
  return false;
}

interface RouteContext {
  method: string;
  url: URL;
  params: Record<string, string>;
}

interface ApiRoute {
  segments: string[];
  allow: (ctx: RouteContext) => boolean;
}

const SESSION_ACTIONS = new Set([
  'abort',
  'prompt_async',
  'revert',
  'summarize',
  'unrevert',
  'init',
  'command',
]);

const noQuery = (url: URL) => !url.search;

const onlyQuery = (url: URL, ...keys: string[]) => {
  for (const key of url.searchParams.keys()) {
    if (!keys.includes(key)) return false;
  }
  return true;
};

const requiredQuery = (url: URL, key: string) => Boolean(url.searchParams.get(key)?.trim());

const methodsNoQuery =
  (...methods: string[]) =>
  ({ method, url }: RouteContext) =>
    methods.includes(method) && noQuery(url);

const route = (pattern: string, allow: (ctx: RouteContext) => boolean): ApiRoute => ({
  segments: pattern.split('/').filter(Boolean),
  allow,
});

/**
 * Match a request's path segments against a route pattern. Pattern segments
 * prefixed with `:` capture any single (already validated) segment by name;
 * all other segments must match literally. Returns the captured params on a
 * match, or `null` when the shapes differ.
 */
function matchRouteSegments(pattern: string[], segments: string[]): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const patternSegment = pattern[i];
    if (patternSegment.startsWith(':')) {
      params[patternSegment.slice(1)] = segments[i];
      continue;
    }
    if (patternSegment !== segments[i]) return null;
  }
  return params;
}

const API_ROUTES: ApiRoute[] = [
  route('/global/health', methodsNoQuery('GET')),
  route('/global/config', methodsNoQuery('GET')),
  route('/config/providers', methodsNoQuery('GET')),
  route('/provider/auth', methodsNoQuery('GET')),
  route('/command', methodsNoQuery('GET')),
  route('/mcp', methodsNoQuery('GET')),
  route('/file/status', methodsNoQuery('GET')),
  route('/agent', methodsNoQuery('GET')),
  route('/question', methodsNoQuery('GET')),
  route('/permission', methodsNoQuery('GET')),
  route('/permission/:id/reply', methodsNoQuery('POST')),
  route('/session', methodsNoQuery('GET', 'POST')),
  route('/session/status', methodsNoQuery('GET')),
  route('/experimental/workspace/status', methodsNoQuery('GET')),
  route(
    '/varro/provider-limit',
    ({ method, url }) =>
      method === 'GET' &&
      onlyQuery(url, 'providerID', 'modelID') &&
      requiredQuery(url, 'providerID')
  ),
  route(
    '/varro/workspace-file',
    ({ method, url }) => method === 'GET' && onlyQuery(url, 'path') && requiredQuery(url, 'path')
  ),
  route(
    '/varro/workspace-path/resolve',
    ({ method, url }) => method === 'GET' && onlyQuery(url, 'path') && requiredQuery(url, 'path')
  ),
  route('/varro/workspace-file/pick', methodsNoQuery('GET')),
  route('/varro/opencode-config', methodsNoQuery('GET')),
  route('/varro/opencode-config/model-routing', methodsNoQuery('POST')),
  route('/varro/permission/judge', methodsNoQuery('POST')),
  route('/varro/session/:id/delete', methodsNoQuery('DELETE')),
  route('/varro/session-trash', methodsNoQuery('GET', 'DELETE')),
  route('/varro/plan/open', methodsNoQuery('POST')),
  route(
    '/varro/session-trash/:id/:action',
    ({ method, url, params }) =>
      noQuery(url) &&
      ((method === 'POST' && params.action === 'restore') ||
        (method === 'DELETE' && params.action === 'delete'))
  ),
  route(
    '/question/:id/:action',
    ({ method, url, params }) =>
      method === 'POST' && noQuery(url) && (params.action === 'reply' || params.action === 'reject')
  ),
  route(
    '/mcp/:id/:action',
    ({ method, url, params }) =>
      method === 'POST' &&
      noQuery(url) &&
      (params.action === 'connect' || params.action === 'disconnect')
  ),
  route(
    '/provider/:id/oauth/:action',
    ({ method, url, params }) =>
      method === 'POST' &&
      noQuery(url) &&
      (params.action === 'authorize' || params.action === 'callback')
  ),
  route('/experimental/workspace/warp', methodsNoQuery('POST')),
  route('/session/:id/diff', ({ method, url }) => method === 'GET' && onlyQuery(url, 'messageID')),
  route('/session/:id/message', methodsNoQuery('GET')),
  route('/session/:id/todo', methodsNoQuery('GET')),
  route(
    '/session/:id/:action',
    ({ method, url, params }) =>
      method === 'POST' && noQuery(url) && SESSION_ACTIONS.has(params.action)
  ),
  route('/session/:id', methodsNoQuery('GET', 'PATCH', 'DELETE')),
];

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

function getPermissionMode(value: unknown): PermissionMode | null {
  return value === 'default' || value === 'auto' || value === 'full' ? value : null;
}
