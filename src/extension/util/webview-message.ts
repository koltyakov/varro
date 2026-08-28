/* oxlint-disable anti-slop/no-object-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- This module is the webview I/O decoder and must inspect untrusted message representations. */
/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Webview assertions occur only after bounded structural validation. */
import { Buffer } from 'buffer';
import {
  MAX_DROPPED_CONTENT_FILES,
  MAX_DROPPED_CONTENT_FILE_BYTES,
  MAX_DROPPED_CONTENT_TOTAL_BYTES,
} from '../../shared/dropped-content-policy';
import { OPENCODE_TERMINAL_COMMANDS } from '../../shared/opencode-install';
import {
  isPermissionMode,
  isSafePersistedSessionId,
  VARRO_API_ENDPOINTS,
} from '../../shared/protocol';
import type {
  ChatModelSelection,
  DesktopSessionPaneSide,
  PermissionMode,
  WebviewMessage,
} from '../../shared/protocol';
import type {
  RalphConfig,
  RalphIteration,
  RalphIterationTokens,
  RalphRun,
  RalphSelectedModel,
} from '../../shared/ralph';
import { MAX_RALPH_ITERATIONS, normalizeRalphWorkspaceDirectory } from '../../shared/ralph';
import { asRecord } from '../../shared/type-utils';
import {
  parseModelPreferences,
  parseRequiredModelPreferences,
} from '../../shared/model-preferences';
import type { UnknownRecord } from '../../shared/type-utils';
import {
  MAX_NATIVE_PDF_TOTAL_BYTES,
  MAX_NATIVE_PDF_FILENAME_LENGTH,
  NATIVE_PDF_MIME,
  getPdfDataUrlSize,
  isPdfBytes,
  isNativePdfAttachment,
} from '../../shared/native-pdf';

// The webview may only ask for commands Varro itself authored: the auth flows
// plus the install and update commands the server-status recovery states offer.
// Anything else is dropped, so a compromised webview cannot run arbitrary
// shell text in the user's terminal.
const ALLOWED_TERMINAL_COMMANDS = new Set<string>([
  'opencode auth login',
  'opencode auth',
  'opencode providers logout',
  ...OPENCODE_TERMINAL_COMMANDS,
]);

const MAX_PATH_LENGTH = 4096;
const MAX_QUERY_LENGTH = 2048;
const MAX_LOG_FIELD_LENGTH = 10_000;
const MAX_SEARCH_QUERY_LENGTH = 200;
/** Full tool output opened in an editor tab; generous but bounded so a runaway
 *  tool cannot push an unbounded string through the bridge. */
const MAX_OPEN_TEXT_LENGTH = 2_000_000;
const MAX_OPEN_TEXT_TITLE_LENGTH = 200;
const OPEN_TEXT_LANGUAGES = new Set(['plaintext', 'json', 'markdown', 'shellscript', 'xml']);
const MAX_DROPPED_PATHS = 100;
const MAX_DROPPED_CONTENT_NAME_LENGTH = 512;
const MAX_DROPPED_CONTENT_BASE64_LENGTH = Math.ceil(MAX_DROPPED_CONTENT_FILE_BYTES / 3) * 4;
const MAX_NATIVE_PDF_BASE64_LENGTH = Math.ceil(MAX_NATIVE_PDF_TOTAL_BYTES / 3) * 4;
const MAX_RALPH_ID_LENGTH = 512;
const MAX_RALPH_PROMPT_LENGTH = 100_000;
const MAX_RALPH_LEGACY_RUNS = 100;
const MAX_RALPH_LEGACY_ITERATIONS = 5_000;
const MAX_RALPH_ITERATIONS_PER_RUN = MAX_RALPH_ITERATIONS;
const MAX_RALPH_FILES_CHANGED = 500;
const MAX_RALPH_VERIFICATIONS = 100;
const MAX_RALPH_REPAIR_SESSIONS = 100;
const MAX_RALPH_NOTE_LENGTH = 10_000;
const MAX_RALPH_TOTAL_NODES = 100_000;
const MAX_RALPH_TOTAL_STRING_BYTES = 8 * 1024 * 1024;
const MAX_RALPH_TOTAL_PATH_ENTRIES = 20_000;
const MAX_RALPH_DEPTH = 20;
const MAX_API_BODY_DEPTH = 25;
const MAX_API_BODY_NODES = 20_000;
const MAX_API_BODY_STRING_BYTES = 40 * 1024 * 1024;
const MAX_API_BODY_SINGLE_STRING_BYTES = 8 * 1024 * 1024;
const MAX_API_BODY_ARRAY_LENGTH = 5_000;
const MAX_API_BODY_OBJECT_KEYS = 2_000;
const MAX_API_BODY_KEY_BYTES = 512;
const API_BASE = 'http://varro.local';

const INVALID_JSON_VALUE = Symbol('invalid-json-value');

type SanitizedJsonValue =
  | null
  | boolean
  | number
  | string
  | SanitizedJsonValue[]
  | { [key: string]: SanitizedJsonValue };

interface StructuralBudget {
  nodes: number;
  stringBytes: number;
}

interface RalphContentBudget {
  pathEntries: number;
}

/**
 * Single source of truth for the accepted webview message types. Exported so
 * tests can assert their own tables stay exhaustive as the protocol grows.
 */
export const WEBVIEW_MESSAGE_TYPES = {
  'context/request': true,
  'workspace/select': true,
  'commands/state': true,
  'session/seen': true,
  'session-model/update': true,
  'session-models/migrate': true,
  'session-plan-state/update': true,
  'session-unread-state/update': true,
  'model-preferences/update': true,
  'model-preferences/migrate': true,
  'webview/focus': true,
  'permission/reveal': true,
  'providers/watch': true,
  'providers/refresh': true,
  'providers/auth-changed': true,
  'terminal-selection/clear': true,
  'terminal/run': true,
  'session/open-in-editor': true,
  'session/open-in-sidebar': true,
  'session/open-in-opencode': true,
  'chat/new-editor': true,
  'editor/route-changed': true,
  'session/export': true,
  'usage/report': true,
  'webview/reload': true,
  'vscode/open-folder': true,
  'vscode/open-settings': true,
  'vscode/show-output': true,
  'vscode/mermaid-preview': true,
  'files/drop': true,
  'files/drop-content': true,
  'pdfs/store': true,
  'images/store': true,
  'images/release': true,
  'files/remove': true,
  'files/clear': true,
  'queued-messages/update': true,
  'queued-messages/claim': true,
  'queued-messages/release': true,
  'recovery/interrupted-sessions-ack': true,
  'permission-mode/update': true,
  'permission-modes/migrate': true,
  'composer/images-update': true,
  'files/pick': true,
  'files/search': true,
  'file/read': true,
  'vscode/open': true,
  'vscode/open-text': true,
  'vscode/open-external': true,
  'config/update': true,
  ready: true,
  'api/request': true,
  'api/cancel': true,
  'ralph/start': true,
  'ralph/stop': true,
  'ralph/pause': true,
  'ralph/resume': true,
  'ralph/update-model': true,
  'ralph/sync': true,
  log: true,
  'server/restart': true,
  'server/restart/check': true,
} as const satisfies Record<WebviewMessage['type'], true>;

export function parseWebviewMessage(value: unknown): WebviewMessage | null {
  const message = asRecord(value);
  const type = getString(message?.type);
  if (!type || !hasOwn(WEBVIEW_MESSAGE_TYPES, type)) return null;

  switch (type) {
    case 'ready':
    case 'context/request':
    case 'providers/refresh':
    case 'providers/auth-changed':
    case 'terminal-selection/clear':
    case 'files/clear':
    case 'files/pick':
    case 'webview/reload':
    case 'vscode/open-folder':
    case 'vscode/show-output':
    case 'chat/new-editor':
      return { type };

    case 'usage/report': {
      const payload = asRecord(message?.payload);
      return typeof payload?.includeAllTime === 'boolean'
        ? { type, payload: { includeAllTime: payload.includeAllTime } }
        : null;
    }

    case 'model-preferences/update': {
      const payload = asRecord(message?.payload);
      if (!payload) return null;
      const base = asRecord(payload.base);
      const preferences = asRecord(payload.preferences);
      if (!base || !preferences) return null;
      const parsedBase = parseRequiredModelPreferences(base);
      const parsedPreferences = parseRequiredModelPreferences(preferences);
      if (!parsedBase || !parsedPreferences) return null;
      return {
        type,
        payload: {
          base: parsedBase,
          preferences: parsedPreferences,
        },
      };
    }

    case 'model-preferences/migrate': {
      const payload = asRecord(message?.payload);
      if (!payload) return null;
      return { type, payload: parseModelPreferences(payload) };
    }

    case 'session/seen': {
      const payload = asRecord(message?.payload);
      const sessionId = payload?.sessionId;
      return isSafePersistedSessionId(sessionId) ? { type, payload: { sessionId } } : null;
    }

    case 'vscode/mermaid-preview': {
      const payload = asRecord(message?.payload);
      return typeof payload?.open === 'boolean' ? { type, payload: { open: payload.open } } : null;
    }

    case 'server/restart': {
      const payload = asRecord(message?.payload);
      return payload?.force === true ? { type, payload: { force: true } } : { type };
    }

    case 'queued-messages/update': {
      const payload = asRecord(message?.payload);
      const messages = sanitizeQueuedMessages(payload?.messages);
      if (!messages) {
        return null;
      }
      return {
        type,
        payload: {
          messages,
        },
      };
    }

    case 'queued-messages/claim': {
      const payload = asRecord(message?.payload);
      const requestId = getSafeInteger(payload?.requestId);
      const itemId = getBoundedString(payload?.itemId, 512);
      const sessionId = getBoundedString(payload?.sessionId, 512);
      const mode = payload?.mode;
      if (
        requestId === null ||
        requestId < 0 ||
        !itemId ||
        !sessionId ||
        (mode !== undefined && mode !== 'next' && mode !== 'steer')
      ) {
        return null;
      }
      return {
        type,
        payload:
          mode === undefined
            ? { requestId, itemId, sessionId }
            : { requestId, itemId, sessionId, mode },
      };
    }

    case 'queued-messages/release': {
      const payload = asRecord(message?.payload);
      const itemId = getBoundedString(payload?.itemId, 512);
      const sessionId = getBoundedString(payload?.sessionId, 512);
      const lease = getSafeInteger(payload?.lease);
      return itemId && sessionId && lease !== null && lease > 0
        ? { type, payload: { itemId, sessionId, lease } }
        : null;
    }

    case 'recovery/interrupted-sessions-ack': {
      const payload = asRecord(message?.payload);
      const claimId = getSafeInteger(payload?.claimId);
      const consumedSessionIds = payload?.consumedSessionIds;
      if (
        claimId === null ||
        claimId <= 0 ||
        !Array.isArray(consumedSessionIds) ||
        consumedSessionIds.length > 1_000 ||
        !consumedSessionIds.every(isSafePersistedSessionId)
      ) {
        return null;
      }
      return {
        type,
        payload: { claimId, consumedSessionIds: [...new Set(consumedSessionIds)] },
      };
    }

    case 'permission-mode/update': {
      const payload = asRecord(message?.payload);
      if (!payload) return null;
      const sessionId = payload.sessionId;
      if (!isSafePersistedSessionId(sessionId)) return null;
      const mode = payload.mode;
      if (mode !== null && !isPermissionMode(mode)) return null;
      return { type, payload: { sessionId, mode } };
    }

    case 'permission-modes/migrate': {
      const payload = asRecord(message?.payload);
      const modes = asRecord(payload?.modes);
      if (!modes || Object.keys(modes).length > 5_000) return null;
      const entries: Array<[string, PermissionMode]> = [];
      for (const [sessionId, mode] of Object.entries(modes)) {
        if (!isSafePersistedSessionId(sessionId) || !isPermissionMode(mode)) return null;
        entries.push([sessionId, mode]);
      }
      return { type, payload: { modes: Object.fromEntries(entries) } };
    }

    case 'session-model/update': {
      const payload = asRecord(message?.payload);
      const sessionId = payload?.sessionId;
      if (!isSafePersistedSessionId(sessionId)) return null;
      if (payload?.model === null) return { type, payload: { sessionId, model: null } };
      const model = asRecord(payload?.model);
      const providerID = getBoundedString(model?.providerID, MAX_RALPH_ID_LENGTH);
      const modelID = getBoundedString(model?.modelID, MAX_RALPH_ID_LENGTH);
      if (!providerID || !modelID) return null;
      const variant =
        model?.variant === undefined
          ? undefined
          : getBoundedString(model.variant, MAX_RALPH_ID_LENGTH);
      if (model?.variant !== undefined && !variant) return null;
      return {
        type,
        payload: {
          sessionId,
          model: variant ? { providerID, modelID, variant } : { providerID, modelID },
        },
      };
    }

    case 'session-models/migrate': {
      const payload = asRecord(message?.payload);
      const models = asRecord(payload?.models);
      if (!models || Object.keys(models).length > 5_000) return null;
      const entries: Array<[string, ChatModelSelection]> = [];
      for (const [sessionId, modelValue] of Object.entries(models)) {
        if (!isSafePersistedSessionId(sessionId)) return null;
        const model = parseChatModelSelection(modelValue);
        if (!model) return null;
        entries.push([sessionId, model]);
      }
      return { type, payload: { models: Object.fromEntries(entries) } };
    }

    case 'session-plan-state/update': {
      const payload = asRecord(message?.payload);
      const sessionId = payload?.sessionId;
      if (!isSafePersistedSessionId(sessionId)) return null;
      const skippedAt = payload?.skippedAt;
      if (skippedAt !== undefined && skippedAt !== null && !Number.isFinite(skippedAt)) return null;
      const rawAgent = payload?.agent;
      const agent = rawAgent === undefined ? undefined : getString(rawAgent);
      if (rawAgent !== undefined && !agent?.trim()) return null;
      if (skippedAt === undefined && agent === undefined) return null;
      const result: Extract<WebviewMessage, { type: 'session-plan-state/update' }> = {
        type,
        payload: { sessionId },
      };
      if (skippedAt !== undefined) result.payload.skippedAt = skippedAt as number | null;
      if (agent) result.payload.agent = agent;
      return result;
    }

    case 'session-unread-state/update': {
      const payload = asRecord(message?.payload);
      const sessionId = payload?.sessionId;
      const kind = payload?.kind;
      const unread = payload?.unread;
      if (
        !isSafePersistedSessionId(sessionId) ||
        (kind !== 'completed' && kind !== 'plan-ready') ||
        typeof unread !== 'boolean'
      ) {
        return null;
      }
      return { type, payload: { sessionId, kind, unread } };
    }

    case 'composer/images-update': {
      const payload = asRecord(message?.payload);
      const images = sanitizeClipboardImages(payload?.images);
      if (!images) return null;
      return {
        type,
        payload: { images },
      };
    }

    case 'server/restart/check': {
      const payload = asRecord(message?.payload);
      return Number.isSafeInteger(payload?.checkId) && (payload?.checkId as number) >= 0
        ? { type, payload: { checkId: payload?.checkId as number } }
        : null;
    }

    case 'session/open-in-editor': {
      const payload = asRecord(message?.payload);
      const sessionId = getBoundedString(payload?.sessionId, 512);
      const rootSessionId = getBoundedString(payload?.rootSessionId, 512);
      const title = getBoundedString(payload?.title, 512);
      if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
      if (
        payload?.rootSessionId !== undefined &&
        (!rootSessionId || !/^[A-Za-z0-9_-]+$/.test(rootSessionId))
      ) {
        return null;
      }
      const model = parseChatModelSelection(payload?.model);
      if (payload?.model !== undefined && !model) return null;
      const parsedPayload: Extract<WebviewMessage, { type: 'session/open-in-editor' }>['payload'] =
        { sessionId };
      if (rootSessionId) parsedPayload.rootSessionId = rootSessionId;
      if (title) parsedPayload.title = title;
      if (model) parsedPayload.model = model;
      return { type, payload: parsedPayload };
    }

    case 'session/open-in-sidebar':
    case 'session/open-in-opencode': {
      const payload = asRecord(message?.payload);
      const sessionId = getBoundedString(payload?.sessionId, 512);
      return sessionId && /^[A-Za-z0-9_-]+$/.test(sessionId)
        ? { type, payload: { sessionId } }
        : null;
    }

    case 'editor/route-changed': {
      const payload = asRecord(message?.payload);
      const route = asRecord(payload?.route);
      if (route?.type === 'new-session')
        return { type, payload: { route: { type: 'new-session' } } };
      const sessionId = getBoundedString(route?.sessionId, 512);
      const rootSessionId = getBoundedString(route?.rootSessionId, 512);
      const title = getBoundedString(route?.title, 512);
      if (route?.type !== 'session' || !sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
        return null;
      }
      if (
        route.rootSessionId !== undefined &&
        (!rootSessionId || !/^[A-Za-z0-9_-]+$/.test(rootSessionId))
      ) {
        return null;
      }
      const parsedRoute: Extract<
        WebviewMessage,
        { type: 'editor/route-changed' }
      >['payload']['route'] = { type: 'session', sessionId };
      if (rootSessionId) parsedRoute.rootSessionId = rootSessionId;
      if (title) parsedRoute.title = title;
      return { type, payload: { route: parsedRoute } };
    }

    case 'session/export': {
      const payload = asRecord(message?.payload);
      const sessionId = getBoundedString(payload?.sessionId, 512);
      return sessionId ? { type, payload: { sessionId } } : null;
    }

    case 'workspace/select': {
      const payload = asRecord(message?.payload);
      const path = getBoundedString(payload?.path, MAX_PATH_LENGTH);
      return path ? { type, payload: { path } } : null;
    }

    case 'commands/state': {
      const payload = asRecord(message?.payload);
      if (
        typeof payload?.canAbort !== 'boolean' ||
        typeof payload.canSwitchSessions !== 'boolean'
      ) {
        return null;
      }
      if (payload.model === null) {
        const sessionId = parseOptionalSessionId(payload.sessionId);
        if (!sessionId.valid) return null;
        const commandState: Extract<WebviewMessage, { type: 'commands/state' }>['payload'] = {
          canAbort: payload.canAbort,
          canSwitchSessions: payload.canSwitchSessions,
          model: null,
        };
        if (sessionId.value !== undefined) commandState.sessionId = sessionId.value;
        return { type, payload: commandState };
      }
      const model = asRecord(payload.model);
      const providerID = getBoundedString(model?.providerID, MAX_RALPH_ID_LENGTH);
      const modelID = getBoundedString(model?.modelID, MAX_RALPH_ID_LENGTH);
      if (!providerID || !modelID) return null;
      const variant =
        model?.variant === undefined
          ? undefined
          : getBoundedString(model.variant, MAX_RALPH_ID_LENGTH);
      if (model?.variant !== undefined && !variant) return null;
      const selectedModel: NonNullable<
        Extract<WebviewMessage, { type: 'commands/state' }>['payload']['model']
      > = { providerID, modelID };
      if (variant) selectedModel.variant = variant;
      const sessionId = parseOptionalSessionId(payload.sessionId);
      if (!sessionId.valid) return null;
      const commandState: Extract<WebviewMessage, { type: 'commands/state' }>['payload'] = {
        canAbort: payload.canAbort,
        canSwitchSessions: payload.canSwitchSessions,
        model: selectedModel,
      };
      if (sessionId.value !== undefined) commandState.sessionId = sessionId.value;
      return { type, payload: commandState };
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

    case 'permission/reveal': {
      const payload = asRecord(message?.payload);
      const permissionId = getBoundedString(payload?.permissionId, 512);
      return permissionId ? { type, payload: { permissionId } } : null;
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
      if (!command || !ALLOWED_TERMINAL_COMMANDS.has(command)) return null;
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
      let totalSize = 0;
      for (const entry of payload.files) {
        const record = asRecord(entry);
        const name = getBoundedString(record?.name, MAX_DROPPED_CONTENT_NAME_LENGTH);
        const content = getBoundedString(record?.content, MAX_DROPPED_CONTENT_BASE64_LENGTH, true);
        const size = getSafeInteger(record?.size);
        if (
          !name ||
          content === null ||
          size === null ||
          size > MAX_DROPPED_CONTENT_FILE_BYTES ||
          getBase64DecodedSize(content) !== size
        ) {
          return null;
        }
        totalSize += size;
        if (totalSize > MAX_DROPPED_CONTENT_TOTAL_BYTES) return null;
        files.push({ name, content, size });
      }
      return { type, payload: { files } };
    }

    case 'pdfs/store': {
      const payload = asRecord(message?.payload);
      const id = getBoundedString(payload?.id, 512);
      const name = getBoundedString(payload?.name, MAX_DROPPED_CONTENT_NAME_LENGTH);
      const content = getBoundedString(payload?.content, MAX_NATIVE_PDF_BASE64_LENGTH, true);
      const size = getSafeInteger(payload?.size);
      if (
        !id ||
        !name ||
        content === null ||
        size === null ||
        size > MAX_NATIVE_PDF_TOTAL_BYTES ||
        getBase64DecodedSize(content) !== size ||
        !isPdfBytes(Buffer.from(content.slice(0, 8), 'base64'))
      ) {
        return null;
      }
      return { type, payload: { id, name, content, size } };
    }

    case 'images/store': {
      const payload = asRecord(message?.payload);
      const id = getBoundedString(payload?.id, 512);
      const name = getBoundedString(payload?.name, MAX_DROPPED_CONTENT_NAME_LENGTH);
      const content = getBoundedString(payload?.content, MAX_DROPPED_CONTENT_BASE64_LENGTH, true);
      const size = getSafeInteger(payload?.size);
      if (
        !id ||
        !name ||
        content === null ||
        size === null ||
        size > MAX_DROPPED_CONTENT_FILE_BYTES ||
        getBase64DecodedSize(content) !== size
      ) {
        return null;
      }
      return { type, payload: { id, name, content, size } };
    }

    case 'images/release': {
      const payload = asRecord(message?.payload);
      if (!Array.isArray(payload?.paths) || payload.paths.length > 5) return null;
      const paths = payload.paths.map((path) => getBoundedString(path, MAX_PATH_LENGTH));
      if (!paths.every((path): path is string => Boolean(path))) return null;
      if (typeof payload.deferred !== 'boolean') return null;
      const sessionId = getBoundedString(payload.sessionId, 512);
      if (payload.sessionId !== undefined && !sessionId) return null;
      const releasePayload: Extract<WebviewMessage, { type: 'images/release' }>['payload'] = {
        paths,
        deferred: payload.deferred,
      };
      if (sessionId) releasePayload.sessionId = sessionId;
      return {
        type,
        payload: releasePayload,
      };
    }

    case 'files/remove':
    case 'file/read': {
      const payload = asRecord(message?.payload);
      const path = getBoundedString(payload?.path, MAX_PATH_LENGTH);
      return path ? { type, payload: { path } } : null;
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
      const view = payload?.view;
      const sessionID = getOptionalBoundedString(payload?.sessionID, 512);
      const requestId =
        payload?.requestId === undefined ? undefined : getSafeInteger(payload.requestId);
      if (!path || (payload?.line !== undefined && line === null)) return null;
      if (payload?.requestId !== undefined && requestId === null) return null;
      if (payload?.sessionID !== undefined && !sessionID) return null;
      if (kind !== undefined && kind !== 'auto' && kind !== 'file' && kind !== 'directory')
        return null;
      if (view !== undefined && view !== 'diff') return null;
      const openPayload: Extract<WebviewMessage, { type: 'vscode/open' }>['payload'] = { path };
      if (line !== undefined && line !== null) openPayload.line = line;
      if (kind) openPayload.kind = kind;
      if (view) openPayload.view = view;
      if (sessionID) openPayload.sessionID = sessionID;
      if (requestId !== undefined && requestId !== null) openPayload.requestId = requestId;
      return { type, payload: openPayload };
    }

    case 'vscode/open-text': {
      const payload = asRecord(message?.payload);
      const content = getBoundedString(payload?.content, MAX_OPEN_TEXT_LENGTH, true);
      const title = getBoundedString(payload?.title, MAX_OPEN_TEXT_TITLE_LENGTH);
      const language = getOptionalBoundedString(payload?.language, 40);
      if (content === null || !title) return null;
      if (language !== undefined && !OPEN_TEXT_LANGUAGES.has(language)) return null;
      const openTextPayload: Extract<WebviewMessage, { type: 'vscode/open-text' }>['payload'] = {
        content,
        title,
      };
      if (language) openTextPayload.language = language;
      return { type, payload: openTextPayload };
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
      return desktopSessionPaneSide && defaultPermissionMode
        ? {
            type,
            payload: {
              desktopSessionPaneSide,
              defaultPermissionMode,
            },
          }
        : null;
    }

    case 'api/request': {
      const payload = asRecord(message?.payload);
      const id = getSafeInteger(payload?.id);
      const cancelKey =
        payload?.cancelKey === undefined ? undefined : getBoundedString(payload.cancelKey, 128);
      const method = getBoundedString(payload?.method, 16)?.toUpperCase() || null;
      const path = getBoundedString(payload?.path, MAX_PATH_LENGTH + MAX_QUERY_LENGTH);
      const permissionAutomationLease = getSafeInteger(payload?.permissionAutomationLease);
      const queuedMessageDispatch = asRecord(payload?.queuedMessageDispatch);
      const queuedMessageItemId = getBoundedString(queuedMessageDispatch?.itemId, 512);
      const queuedMessageLease = getSafeInteger(queuedMessageDispatch?.lease);
      if (
        id === null ||
        (payload?.cancelKey !== undefined && !cancelKey) ||
        (payload?.permissionAutomationLease !== undefined && permissionAutomationLease === null) ||
        (payload?.queuedMessageDispatch !== undefined &&
          (!queuedMessageDispatch ||
            !queuedMessageItemId ||
            queuedMessageLease === null ||
            queuedMessageLease <= 0)) ||
        !method ||
        !path ||
        !isAllowedApiRequest(method, path)
      ) {
        return null;
      }
      const requestPayload: Extract<WebviewMessage, { type: 'api/request' }>['payload'] = {
        id,
        method,
        path,
      };
      if (cancelKey) requestPayload.cancelKey = cancelKey;
      if (permissionAutomationLease !== null) {
        requestPayload.permissionAutomationLease = permissionAutomationLease;
      }
      if (queuedMessageItemId && queuedMessageLease !== null) {
        requestPayload.queuedMessageDispatch = {
          itemId: queuedMessageItemId,
          lease: queuedMessageLease,
        };
      }
      if (payload?.body === undefined) {
        return { type, payload: requestPayload };
      }
      const body = /\/session\/[^/]+\/prompt_async(?:\?|$)/.test(path)
        ? sanitizePromptBodyWithNativePdfs(payload.body)
        : sanitizeApiRequestBody(payload.body);
      if (body === INVALID_JSON_VALUE) return null;
      requestPayload.body = body;
      return { type, payload: requestPayload };
    }

    case 'api/cancel': {
      const payload = asRecord(message?.payload);
      const id = getSafeInteger(payload?.id);
      const cancelKey = getBoundedString(payload?.cancelKey, 128);
      return id === null || !cancelKey ? null : { type, payload: { id, cancelKey } };
    }

    case 'ralph/start': {
      const payload = asRecord(message?.payload);
      if (!payload || !isWithinRalphStructuralBudget(payload)) return null;
      const config = parseRalphConfig(payload?.config, MAX_RALPH_ITERATIONS, false);
      return config ? { type, payload: { config } } : null;
    }

    case 'ralph/stop':
    case 'ralph/pause':
    case 'ralph/resume': {
      const payload = asRecord(message?.payload);
      if (!payload || !isWithinRalphStructuralBudget(payload)) return null;
      const managerSessionId = getSafeRalphId(payload.managerSessionId);
      return managerSessionId ? { type, payload: { managerSessionId } } : null;
    }

    case 'ralph/update-model': {
      const payload = asRecord(message?.payload);
      if (!payload || !isWithinRalphStructuralBudget(payload)) return null;
      const managerSessionId = getSafeRalphId(payload.managerSessionId);
      if (!managerSessionId) return null;
      if (payload?.model === null) {
        return { type, payload: { managerSessionId, model: null } };
      }
      const model = parseRalphSelectedModel(payload?.model);
      return model ? { type, payload: { managerSessionId, model } } : null;
    }

    case 'ralph/sync': {
      const payload = asRecord(message?.payload);
      if (!payload || !isWithinRalphStructuralBudget(payload)) return null;
      if (payload.legacyRuns === undefined) return { type, payload: {} };
      const legacyRuns = parseRalphRuns(payload.legacyRuns, { pathEntries: 0 });
      return legacyRuns ? { type, payload: { legacyRuns } } : null;
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
      const logPayload: Extract<WebviewMessage, { type: 'log' }>['payload'] = { msg };
      if (data) logPayload.data = data;
      if (error) logPayload.error = error;
      if (level) logPayload.level = level;
      return { type, payload: logPayload };
    }

    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

function parseChatModelSelection(value: unknown) {
  const model = asRecord(value);
  const providerID = getBoundedString(model?.providerID, MAX_RALPH_ID_LENGTH);
  const modelID = getBoundedString(model?.modelID, MAX_RALPH_ID_LENGTH);
  if (!providerID || !modelID) return null;
  const variant =
    model?.variant === undefined ? undefined : getBoundedString(model.variant, MAX_RALPH_ID_LENGTH);
  if (model?.variant !== undefined && !variant) return null;
  return variant ? { providerID, modelID, variant } : { providerID, modelID };
}

function parseRalphConfig(
  value: unknown,
  maxIterations: number,
  allowMissingWorkspace: boolean
): RalphConfig | null {
  const record = asRecord(value);
  const managerSessionId = getSafeRalphId(record?.managerSessionId);
  const rawWorkspaceDirectory = record?.workspaceDirectory ?? record?.workspacePath;
  const workspaceDirectory = normalizeRalphWorkspaceDirectory(rawWorkspaceDirectory);
  const planDocPath = getBoundedString(record?.planDocPath, MAX_PATH_LENGTH);
  const iterations = getBoundedInteger(record?.iterations, 1, maxIterations);
  const promptTemplate = getBoundedString(record?.promptTemplate, MAX_RALPH_PROMPT_LENGTH);
  const permissionMode = getPermissionMode(record?.permissionMode);
  const createdAt = getSafeInteger(record?.createdAt);
  if (
    !record ||
    !managerSessionId ||
    (!workspaceDirectory && !allowMissingWorkspace) ||
    (rawWorkspaceDirectory !== undefined &&
      rawWorkspaceDirectory !== null &&
      !workspaceDirectory) ||
    !planDocPath ||
    iterations === null ||
    !promptTemplate ||
    !permissionMode ||
    createdAt === null
  ) {
    return null;
  }

  let model: RalphSelectedModel | null;
  if (record.model === null) {
    model = null;
  } else {
    model = parseRalphSelectedModel(record.model);
    if (!model) return null;
  }

  let agent: string | null;
  if (record.agent === null) {
    agent = null;
  } else {
    agent = getBoundedString(record.agent, MAX_RALPH_ID_LENGTH);
    if (!agent) return null;
  }

  return {
    managerSessionId,
    workspaceDirectory,
    planDocPath,
    iterations,
    promptTemplate,
    permissionMode,
    model,
    agent,
    createdAt,
  };
}

function parseRalphSelectedModel(value: unknown): RalphSelectedModel | null {
  const record = asRecord(value);
  const providerID = getBoundedString(record?.providerID, MAX_RALPH_ID_LENGTH);
  const modelID = getBoundedString(record?.modelID, MAX_RALPH_ID_LENGTH);
  if (!providerID || !modelID) return null;

  if (record?.variant === undefined) return { providerID, modelID };
  const variant = getBoundedString(record.variant, MAX_RALPH_ID_LENGTH);
  return variant ? { providerID, modelID, variant } : null;
}

function parseRalphRuns(
  value: unknown,
  contentBudget: RalphContentBudget
): Record<string, RalphRun> | null {
  const record = asRecord(value);
  if (!record) return null;
  const entries = Object.entries(record);
  if (entries.length > MAX_RALPH_LEGACY_RUNS) return null;

  let totalIterations = 0;
  const runs: Record<string, RalphRun> = {};
  for (const [managerSessionId, rawRun] of entries) {
    if (!isSafeRalphRecordKey(managerSessionId)) return null;
    const rawIterations = asRecord(rawRun)?.iterations;
    if (!Array.isArray(rawIterations)) return null;
    totalIterations += rawIterations.length;
    if (totalIterations > MAX_RALPH_LEGACY_ITERATIONS) return null;

    const run = parseRalphRun(rawRun, contentBudget);
    if (!run || run.config.managerSessionId !== managerSessionId) return null;
    runs[managerSessionId] = run;
  }
  return runs;
}

function parseRalphRun(value: unknown, contentBudget: RalphContentBudget): RalphRun | null {
  const record = asRecord(value);
  const config = parseRalphConfig(record?.config, MAX_RALPH_ITERATIONS, true);
  const status = getRalphStatus(record?.status);
  const currentIteration = getBoundedInteger(
    record?.currentIteration,
    0,
    config?.iterations ?? MAX_RALPH_ITERATIONS
  );
  const updatedAt = getSafeInteger(record?.updatedAt);
  if (
    !record ||
    !config ||
    !status ||
    currentIteration === null ||
    updatedAt === null ||
    !Array.isArray(record.iterations) ||
    record.iterations.length > MAX_RALPH_ITERATIONS_PER_RUN
  ) {
    return null;
  }

  const iterations: RalphIteration[] = [];
  const indexes = new Set<number>();
  for (const rawIteration of record.iterations) {
    const iteration = parseRalphIteration(rawIteration, config.iterations, contentBudget);
    if (!iteration || indexes.has(iteration.index)) return null;
    indexes.add(iteration.index);
    iterations.push(iteration);
  }

  const run: RalphRun = { config, status, currentIteration, iterations, updatedAt };
  if (record.note !== undefined) {
    const note = getBoundedString(record.note, MAX_RALPH_NOTE_LENGTH);
    if (!note) return null;
    run.note = note;
  }
  if (record.stopReason === undefined) return run;
  const stopReason = getRalphStopReason(record.stopReason);
  if (!stopReason) return null;
  run.stopReason = stopReason;
  return run;
}

function parseRalphIteration(
  value: unknown,
  maxIndex: number,
  contentBudget: RalphContentBudget
): RalphIteration | null {
  const record = asRecord(value);
  const index = getBoundedInteger(record?.index, 1, maxIndex);
  const status = getRalphIterationStatus(record?.status);
  const childSessionId = getNullableSafeRalphId(record?.childSessionId);
  const startedAt = getNullableSafeInteger(record?.startedAt);
  const endedAt = getNullableSafeInteger(record?.endedAt);
  if (
    !record ||
    index === null ||
    !status ||
    childSessionId === undefined ||
    startedAt === undefined ||
    endedAt === undefined ||
    !Array.isArray(record.filesChanged) ||
    record.filesChanged.length > MAX_RALPH_FILES_CHANGED
  ) {
    return null;
  }

  const filesChanged = record.filesChanged.map((path) => getBoundedString(path, MAX_PATH_LENGTH));
  if (!filesChanged.every((path): path is string => Boolean(path))) return null;
  contentBudget.pathEntries += filesChanged.length;
  if (contentBudget.pathEntries > MAX_RALPH_TOTAL_PATH_ENTRIES) return null;

  const verification = parseRalphVerification(record.verification);
  if (!verification) return null;
  const phase = getRalphIterationPhase(record.phase);
  if (record.phase !== undefined && !phase) return null;

  const iteration: RalphIteration = {
    index,
    childSessionId,
    status,
    startedAt,
    endedAt,
    filesChanged,
    verification,
  };
  if (phase) iteration.phase = phase;

  if (record.tokens !== undefined) {
    const tokens = parseRalphIterationTokens(record.tokens);
    if (!tokens) return null;
    iteration.tokens = tokens;
  }
  if (record.cost !== undefined) {
    const cost = getBoundedNumber(record.cost, 0, Number.MAX_SAFE_INTEGER);
    if (cost === null) return null;
    iteration.cost = cost;
  }
  if (record.note !== undefined) {
    const note = getBoundedString(record.note, MAX_RALPH_NOTE_LENGTH);
    if (!note) return null;
    iteration.note = note;
  }
  if (record.repairSessionIds !== undefined) {
    if (
      !Array.isArray(record.repairSessionIds) ||
      record.repairSessionIds.length > MAX_RALPH_REPAIR_SESSIONS
    ) {
      return null;
    }
    const repairSessionIds = record.repairSessionIds.map(getSafeRalphId);
    if (!repairSessionIds.every((id): id is string => Boolean(id))) return null;
    iteration.repairSessionIds = repairSessionIds;
  }

  return iteration;
}

function getRalphIterationPhase(value: unknown): RalphIteration['phase'] | null {
  return value === 'primary' || value === 'verification' || value === 'repair' ? value : null;
}

function parseRalphVerification(value: unknown): RalphIteration['verification'] | null {
  const record = asRecord(value);
  if (!record) return null;
  const entries = Object.entries(record);
  if (entries.length > MAX_RALPH_VERIFICATIONS) return null;

  const verification: RalphIteration['verification'] = {};
  for (const [name, rawVerdict] of entries) {
    if (!isSafeRalphRecordKey(name, 100)) return null;
    const verdict = getRalphVerificationVerdict(rawVerdict);
    if (!verdict) return null;
    verification[name] = verdict;
  }
  return verification;
}

function parseRalphIterationTokens(value: unknown): RalphIterationTokens | null {
  const record = asRecord(value);
  if (!record) return null;
  const input = getSafeInteger(record.input);
  const output = getSafeInteger(record.output);
  const reasoning = getSafeInteger(record.reasoning);
  const cacheRead = getSafeInteger(record.cacheRead);
  const cacheWrite = getSafeInteger(record.cacheWrite);
  const total = getSafeInteger(record.total);
  return input !== null &&
    output !== null &&
    reasoning !== null &&
    cacheRead !== null &&
    cacheWrite !== null &&
    total !== null
    ? { input, output, reasoning, cacheRead, cacheWrite, total }
    : null;
}

function getRalphStatus(value: unknown): RalphRun['status'] | null {
  return value === 'running' ||
    value === 'paused' ||
    value === 'stopped' ||
    value === 'done' ||
    value === 'incomplete' ||
    value === 'failed'
    ? value
    : null;
}

function getRalphStopReason(value: unknown): RalphRun['stopReason'] | null {
  return value === 'iteration_limit' ||
    value === 'iteration_limit_with_gap' ||
    value === 'consecutive_passes' ||
    value === 'done_marker' ||
    value === 'manual_stop' ||
    value === 'iteration_error'
    ? value
    : null;
}

function getRalphIterationStatus(value: unknown): RalphIteration['status'] | null {
  return value === 'pending' ||
    value === 'running' ||
    value === 'passed' ||
    value === 'failed' ||
    value === 'aborted'
    ? value
    : null;
}

function getRalphVerificationVerdict(
  value: unknown
): RalphIteration['verification'][string] | null {
  return value === 'pass' || value === 'fail' || value === 'skipped' ? value : null;
}

function getSafeRalphId(value: unknown): string | null {
  const id = getBoundedString(value, MAX_RALPH_ID_LENGTH);
  return id && isSafeRalphRecordKey(id) ? id : null;
}

function getNullableSafeRalphId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return getSafeRalphId(value) ?? undefined;
}

function isSafeRalphRecordKey(value: string, maxLength = MAX_RALPH_ID_LENGTH) {
  return (
    value.length > 0 &&
    value.length <= maxLength &&
    value !== '__proto__' &&
    value !== 'prototype' &&
    value !== 'constructor'
  );
}

function isWithinRalphStructuralBudget(value: unknown): boolean {
  try {
    return visitRalphValue(value, { nodes: 0, stringBytes: 0 }, 0, new WeakSet<object>());
  } catch {
    return false;
  }
}

function visitRalphValue(
  value: unknown,
  budget: StructuralBudget,
  depth: number,
  ancestors: WeakSet<object>
): boolean {
  budget.nodes += 1;
  if (budget.nodes > MAX_RALPH_TOTAL_NODES || depth > MAX_RALPH_DEPTH) return false;
  if (typeof value === 'string') {
    budget.stringBytes += Buffer.byteLength(value, 'utf8');
    return budget.stringBytes <= MAX_RALPH_TOTAL_STRING_BYTES;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return true;
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = getArrayDataValues(value);
      if (!items || items.length > MAX_RALPH_TOTAL_NODES) return false;
      for (const item of items) {
        if (!visitRalphValue(item, budget, depth + 1, ancestors)) return false;
      }
      return true;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const entries = getObjectDataEntries(value);
    if (!entries) return false;
    budget.nodes += entries.length;
    if (budget.nodes > MAX_RALPH_TOTAL_NODES) return false;
    for (const [key, entry] of entries) {
      if (!isSafeRalphRecordKey(key, MAX_RALPH_TOTAL_STRING_BYTES)) return false;
      budget.stringBytes += Buffer.byteLength(key, 'utf8');
      if (budget.stringBytes > MAX_RALPH_TOTAL_STRING_BYTES) return false;
      if (!visitRalphValue(entry, budget, depth + 1, ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

function sanitizeApiRequestBody(value: unknown): SanitizedJsonValue | typeof INVALID_JSON_VALUE {
  try {
    return sanitizeJsonValue(value, { nodes: 0, stringBytes: 0 }, 0, new WeakSet<object>());
  } catch {
    return INVALID_JSON_VALUE;
  }
}

export function sanitizeQueuedMessages(
  value: unknown
): Extract<WebviewMessage, { type: 'queued-messages/update' }>['payload']['messages'] | null {
  if (!Array.isArray(value) || value.length > 1_000) return null;
  const withoutPdfs: unknown[] = [];
  const pdfsByIndex: Array<
    Extract<
      WebviewMessage,
      { type: 'queued-messages/update' }
    >['payload']['messages'][number]['nativePdfs']
  > = [];
  let queuedPdfBytes = 0;
  for (const item of value) {
    const record = asRecord(item);
    if (!record) return null;
    const nativePdfs = record.nativePdfs === undefined ? [] : record.nativePdfs;
    if (!Array.isArray(nativePdfs)) return null;
    const validPdfs = nativePdfs.filter(isNativePdfAttachment);
    if (validPdfs.length !== nativePdfs.length) return null;
    queuedPdfBytes += validPdfs.reduce((total, pdf) => total + pdf.size, 0);
    if (queuedPdfBytes > MAX_NATIVE_PDF_TOTAL_BYTES) return null;
    const copy = { ...record };
    delete copy.nativePdfs;
    withoutPdfs.push(copy);
    pdfsByIndex.push(validPdfs);
  }
  const sanitized = sanitizeApiRequestBody(withoutPdfs);
  if (sanitized === INVALID_JSON_VALUE || !Array.isArray(sanitized)) return null;
  const messages: Extract<
    WebviewMessage,
    { type: 'queued-messages/update' }
  >['payload']['messages'] = [];
  for (const [index, item] of sanitized.entries()) {
    const record = asRecord(item);
    if (!record || !isValidQueuedMessageRouting(record)) return null;
    messages.push({
      ...(record as unknown as (typeof messages)[number]),
      nativePdfs: pdfsByIndex[index]!,
    });
  }
  return messages;
}

function isValidQueuedMessageRouting(record: UnknownRecord) {
  if (!isSafePersistedSessionId(record.id) || !isSafePersistedSessionId(record.sessionId)) {
    return false;
  }
  if (getBoundedString(record.text, MAX_API_BODY_SINGLE_STRING_BYTES, true) === null) return false;
  if (record.ownerViewId !== undefined && !isSafePersistedSessionId(record.ownerViewId))
    return false;
  if (record.messageId !== undefined && !isSafePersistedSessionId(record.messageId)) return false;
  if (record.agent !== undefined && !getBoundedString(record.agent, MAX_RALPH_ID_LENGTH))
    return false;
  if (record.paused !== undefined && typeof record.paused !== 'boolean') return false;
  if (!Array.isArray(record.droppedFiles) || !Array.isArray(record.clipboardImages)) return false;
  if (record.attachedDiagnostics !== undefined && !asRecord(record.attachedDiagnostics))
    return false;
  const queuedContext = asRecord(record.queuedContext);
  if (record.queuedContext !== undefined && !queuedContext) return false;
  if (
    queuedContext?.visionDelegationAvailable !== undefined &&
    typeof queuedContext.visionDelegationAvailable !== 'boolean'
  ) {
    return false;
  }
  if (record.terminalSelection === null) return true;
  const terminalSelection = asRecord(record.terminalSelection);
  return (
    !!terminalSelection &&
    getBoundedString(terminalSelection.text, MAX_API_BODY_SINGLE_STRING_BYTES, true) !== null &&
    !!getBoundedString(terminalSelection.terminalName, MAX_DROPPED_CONTENT_NAME_LENGTH)
  );
}

function sanitizeClipboardImages(
  value: unknown
): Extract<WebviewMessage, { type: 'composer/images-update' }>['payload']['images'] | null {
  if (!Array.isArray(value) || value.length > 5) return null;
  const images: Extract<WebviewMessage, { type: 'composer/images-update' }>['payload']['images'] =
    [];
  for (const item of value) {
    const record = asRecord(item);
    const id = getBoundedString(record?.id, 512);
    const mime = getBoundedString(record?.mime, 256);
    const filename = getBoundedString(record?.filename, MAX_DROPPED_CONTENT_NAME_LENGTH);
    const size = getSafeInteger(record?.size);
    const url = getBoundedString(record?.url, MAX_API_BODY_SINGLE_STRING_BYTES);
    if (!id || !mime || !filename || size === null || !url || size > 5 * 1024 * 1024) return null;
    const prefix = `data:${mime};base64,`;
    if (!url.startsWith(prefix) || getBase64DecodedSize(url.slice(prefix.length)) !== size)
      return null;
    const contentKey = getBoundedString(record?.contentKey, 512);
    const attachmentSequence = getSafeInteger(record?.attachmentSequence);
    const contextFile = parseClipboardImageContextFile(record?.contextFile);
    if (record?.contentKey !== undefined && !contentKey) return null;
    if (record?.attachmentSequence !== undefined && attachmentSequence === null) return null;
    if (record?.contextFile !== undefined && !contextFile) return null;
    const image: (typeof images)[number] = {
      id,
      url,
      mime,
      filename,
      size,
    };
    if (contentKey) image.contentKey = contentKey;
    if (attachmentSequence !== null) image.attachmentSequence = attachmentSequence;
    if (contextFile) image.contextFile = contextFile;
    images.push(image);
  }
  return images;
}

function parseClipboardImageContextFile(
  value: unknown
):
  | Extract<
      WebviewMessage,
      { type: 'composer/images-update' }
    >['payload']['images'][number]['contextFile']
  | null {
  const record = asRecord(value);
  const path = getBoundedString(record?.path, MAX_PATH_LENGTH);
  const relativePath = getBoundedString(record?.relativePath, MAX_PATH_LENGTH);
  return record?.type === 'file' &&
    path &&
    relativePath &&
    !path.includes('\0') &&
    !relativePath.includes('\0')
    ? { path, relativePath, type: 'file' }
    : null;
}

function sanitizePromptBodyWithNativePdfs(
  value: unknown
): SanitizedJsonValue | typeof INVALID_JSON_VALUE {
  const body = asRecord(value);
  if (!body || !Array.isArray(body.parts)) return sanitizeApiRequestBody(value);
  let totalPdfBytes = 0;
  const pdfUrls = new Map<number, string>();
  const parts = body.parts.map((part, index) => {
    const record = asRecord(part);
    if (record?.type !== 'file' || record.mime !== NATIVE_PDF_MIME) return part;
    const keys = Object.keys(record);
    if (
      keys.some((key) => !['type', 'mime', 'filename', 'url'].includes(key)) ||
      typeof record.filename !== 'string' ||
      record.filename.length === 0 ||
      record.filename.length > MAX_NATIVE_PDF_FILENAME_LENGTH ||
      typeof record.url !== 'string'
    ) {
      return INVALID_JSON_VALUE;
    }
    const size = getPdfDataUrlSize(record.url);
    if (size === null) return INVALID_JSON_VALUE;
    totalPdfBytes += size;
    if (totalPdfBytes > MAX_NATIVE_PDF_TOTAL_BYTES) return INVALID_JSON_VALUE;
    pdfUrls.set(index, record.url);
    return { type: 'file', mime: NATIVE_PDF_MIME, filename: record.filename, url: '' };
  });
  if (parts.includes(INVALID_JSON_VALUE)) return INVALID_JSON_VALUE;
  const sanitized = sanitizeApiRequestBody({ ...body, parts });
  if (sanitized === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
  const sanitizedBody = sanitized as { [key: string]: SanitizedJsonValue };
  const sanitizedParts = sanitizedBody.parts;
  if (!Array.isArray(sanitizedParts)) return INVALID_JSON_VALUE;
  for (const [index, url] of pdfUrls) {
    const part = sanitizedParts[index];
    if (!part || Array.isArray(part) || typeof part !== 'object') return INVALID_JSON_VALUE;
    part.url = url;
  }
  return sanitizedBody;
}

function sanitizeJsonValue(
  value: unknown,
  budget: StructuralBudget,
  depth: number,
  ancestors: WeakSet<object>
): SanitizedJsonValue | typeof INVALID_JSON_VALUE {
  budget.nodes += 1;
  if (budget.nodes > MAX_API_BODY_NODES || depth > MAX_API_BODY_DEPTH) {
    return INVALID_JSON_VALUE;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID_JSON_VALUE;
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_API_BODY_SINGLE_STRING_BYTES) return INVALID_JSON_VALUE;
    budget.stringBytes += bytes;
    return budget.stringBytes <= MAX_API_BODY_STRING_BYTES ? value : INVALID_JSON_VALUE;
  }
  if (typeof value !== 'object' || ancestors.has(value)) return INVALID_JSON_VALUE;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = getArrayDataValues(value);
      if (!items || items.length > MAX_API_BODY_ARRAY_LENGTH) {
        return INVALID_JSON_VALUE;
      }
      const output: SanitizedJsonValue[] = [];
      for (const item of items) {
        const sanitized = sanitizeJsonValue(item, budget, depth + 1, ancestors);
        if (sanitized === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
        output.push(sanitized);
      }
      return output;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return INVALID_JSON_VALUE;
    const entries = getObjectDataEntries(value);
    if (!entries || entries.length > MAX_API_BODY_OBJECT_KEYS) {
      return INVALID_JSON_VALUE;
    }

    const output: { [key: string]: SanitizedJsonValue } = {};
    budget.nodes += entries.length;
    if (budget.nodes > MAX_API_BODY_NODES) return INVALID_JSON_VALUE;
    for (const [key, entry] of entries) {
      const keyBytes = Buffer.byteLength(key, 'utf8');
      if (!isSafeRalphRecordKey(key, MAX_API_BODY_KEY_BYTES) || keyBytes > MAX_API_BODY_KEY_BYTES) {
        return INVALID_JSON_VALUE;
      }
      budget.stringBytes += keyBytes;
      if (budget.stringBytes > MAX_API_BODY_STRING_BYTES) return INVALID_JSON_VALUE;
      if (entry === undefined) continue;
      const sanitized = sanitizeJsonValue(entry, budget, depth + 1, ancestors);
      if (sanitized === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
      output[key] = sanitized;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function getArrayDataValues(value: unknown[]): unknown[] | null {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => typeof key === 'symbol')) return null;
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    output.push(descriptor.value);
  }
  return output;
}

function getObjectDataEntries(value: object): Array<[string, unknown]> | null {
  const output: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    output.push([key, descriptor.value]);
  }
  return output;
}

function getBase64DecodedSize(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
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
  'fork',
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
const MAX_SESSION_PAGE_LIMIT = 1_000_000;

const singleRequiredQuery = (url: URL, key: string) => {
  const values = url.searchParams.getAll(key);
  return values.length === 1 && Boolean(values[0]?.trim());
};

const positiveIntegerQuery = (url: URL, key: string) => {
  const values = url.searchParams.getAll(key);
  if (values.length !== 1 || !/^\d+$/.test(values[0]!)) return false;
  const value = Number(values[0]);
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_SESSION_PAGE_LIMIT;
};

const optionalDirectoryQuery = (url: URL) => {
  const directories = url.searchParams.getAll('directory');
  return (
    onlyQuery(url, 'directory') &&
    directories.length <= 1 &&
    (directories.length === 0 || requiredQuery(url, 'directory'))
  );
};

const sessionSearchQuery = (url: URL) =>
  onlyQuery(url, 'limit', 'search', 'roots') &&
  positiveIntegerQuery(url, 'limit') &&
  singleRequiredQuery(url, 'search') &&
  url.searchParams.getAll('roots').length === 1 &&
  url.searchParams.get('roots') === 'true';

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
    const patternSegment = pattern[i]!;
    if (patternSegment.startsWith(':')) {
      params[patternSegment.slice(1)] = segments[i]!;
      continue;
    }
    if (patternSegment !== segments[i]) return null;
  }
  return params;
}

const API_ROUTES: ApiRoute[] = [
  route('/global/health', methodsNoQuery('GET')),
  route('/global/config', methodsNoQuery('GET')),
  route('/model/default', methodsNoQuery('GET')),
  route('/config/providers', methodsNoQuery('GET')),
  route('/provider', methodsNoQuery('GET')),
  route('/provider/auth', methodsNoQuery('GET')),
  route('/auth/:id', methodsNoQuery('PUT', 'DELETE')),
  route('/command', methodsNoQuery('GET')),
  route('/mcp', methodsNoQuery('GET')),
  route('/lsp', methodsNoQuery('GET')),
  route('/vcs/status', methodsNoQuery('GET')),
  route('/agent', methodsNoQuery('GET')),
  route('/question', methodsNoQuery('GET')),
  route('/permission', methodsNoQuery('GET')),
  route('/permission/:id/reply', methodsNoQuery('POST')),
  route(
    '/session',
    ({ method, url }) =>
      (method === 'GET' &&
        (noQuery(url) ||
          (onlyQuery(url, 'limit') && positiveIntegerQuery(url, 'limit')) ||
          sessionSearchQuery(url))) ||
      (method === 'POST' && optionalDirectoryQuery(url))
  ),
  route('/session/status', methodsNoQuery('GET')),
  route('/experimental/workspace/status', methodsNoQuery('GET')),
  route(
    VARRO_API_ENDPOINTS.providerLimit,
    ({ method, url }) =>
      method === 'GET' &&
      onlyQuery(url, 'providerID', 'modelID') &&
      requiredQuery(url, 'providerID')
  ),
  route(
    VARRO_API_ENDPOINTS.workspaceFile,
    ({ method, url }) => method === 'GET' && onlyQuery(url, 'path') && requiredQuery(url, 'path')
  ),
  route(
    VARRO_API_ENDPOINTS.workspacePathResolve,
    ({ method, url }) => method === 'GET' && onlyQuery(url, 'path') && requiredQuery(url, 'path')
  ),
  route(VARRO_API_ENDPOINTS.workspaceFilePick, methodsNoQuery('GET')),
  route(VARRO_API_ENDPOINTS.openCodeConfig, methodsNoQuery('GET')),
  route(VARRO_API_ENDPOINTS.openCodeConfigModelRouting, methodsNoQuery('POST')),
  route(VARRO_API_ENDPOINTS.permissionJudge, methodsNoQuery('POST')),
  route(
    VARRO_API_ENDPOINTS.permissionJudgeModel,
    ({ method, url }) => method === 'GET' && onlyQuery(url, 'providerID', 'modelID', 'variant')
  ),
  route(
    `${VARRO_API_ENDPOINTS.session}/:id/diff-summary`,
    ({ method, url }) => method === 'GET' && onlyQuery(url, 'revision')
  ),
  route(`${VARRO_API_ENDPOINTS.session}/:id/pin`, methodsNoQuery('POST')),
  route(`${VARRO_API_ENDPOINTS.session}/:id/permission-mode`, methodsNoQuery('POST')),
  route(`${VARRO_API_ENDPOINTS.session}/:id/rename-if-untitled`, methodsNoQuery('POST')),
  route(`${VARRO_API_ENDPOINTS.session}/:id/delete`, methodsNoQuery('DELETE')),
  route(VARRO_API_ENDPOINTS.sessionTrash, methodsNoQuery('GET', 'DELETE')),
  route(VARRO_API_ENDPOINTS.planOpen, methodsNoQuery('POST')),
  route(
    `${VARRO_API_ENDPOINTS.sessionTrash}/:id/:action`,
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
  route('/mcp/:id/auth/authenticate', methodsNoQuery('POST')),
  route('/mcp/:id/auth', methodsNoQuery('POST', 'DELETE')),
  route('/mcp/:id/auth/callback', methodsNoQuery('POST')),
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
  route(
    '/session/:id/message',
    ({ method, url }) =>
      method === 'GET' &&
      onlyQuery(url, 'limit', 'before') &&
      (!url.searchParams.has('before') || requiredQuery(url, 'limit'))
  ),
  route('/session/:id/message/:messageId', methodsNoQuery('DELETE')),
  route('/session/:id/todo', methodsNoQuery('GET')),
  route(
    '/session/:id/share',
    ({ method, url }) => (method === 'POST' || method === 'DELETE') && optionalDirectoryQuery(url)
  ),
  route(
    '/session/:id/:action',
    ({ method, url, params }) =>
      method === 'POST' &&
      SESSION_ACTIONS.has(params.action!) &&
      (params.action === 'prompt_async' ? optionalDirectoryQuery(url) : noQuery(url))
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

function parseOptionalSessionId(
  value: unknown
): { valid: true; value: string | null | undefined } | { valid: false } {
  if (value === undefined || value === null) return { valid: true, value };
  const sessionId = getBoundedString(value, 512);
  return sessionId ? { valid: true, value: sessionId } : { valid: false };
}

function getSafeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function getBoundedInteger(value: unknown, min: number, max: number) {
  const number = getSafeInteger(value);
  return number !== null && number >= min && number <= max ? number : null;
}

function getBoundedNumber(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function getNullableSafeInteger(value: unknown) {
  if (value === null) return null;
  return getSafeInteger(value) ?? undefined;
}

function hasOwn<T extends object>(object: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function getDesktopSessionPaneSide(value: unknown): DesktopSessionPaneSide | null {
  return value === 'left' || value === 'right' ? value : null;
}

function getPermissionMode(value: unknown): PermissionMode | null {
  return isPermissionMode(value) ? value : null;
}
