import {
  parseServerEvent,
  type DesktopSessionPaneSide,
  type DroppedFile,
  type EditorContext,
  type ExtensionMessage,
  type PermissionMode,
  type ServerStatus,
  type WebviewThemeKind,
} from './protocol';
import {
  DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS,
  normalizeProviderLimitThresholdPercent,
} from './provider-limit-config';

const KNOWN_TYPES = new Set<ExtensionMessage['type']>([
  'server/status',
  'server/event',
  'providers/refresh',
  'context/update',
  'terminal-selection/update',
  'files/dropped',
  'files/removed',
  'files/search-results',
  'config/update',
  'theme/update',
  'api/response',
  'command/new-session',
  'command/focus-input',
  'command/open-attention-sessions',
  'command/abort',
]);

/**
 * Validate an incoming extension->webview message. Returns the message
 * typed if it matches a known shape, or null if it should be ignored.
 * This is a shallow structural check; it does not deep-validate payloads
 * beyond what is necessary to route the message safely.
 */
export function parseExtensionMessage(value: unknown): ExtensionMessage | null {
  const record = asRecord(value);
  if (!record) return null;
  const type = record.type;
  if (typeof type !== 'string' || !KNOWN_TYPES.has(type as ExtensionMessage['type'])) {
    return null;
  }

  switch (type) {
    case 'command/new-session':
    case 'command/focus-input':
    case 'command/open-attention-sessions':
    case 'command/abort':
    case 'providers/refresh':
      return { type };

    case 'server/status': {
      const payload = asRecord(record.payload);
      return isServerStatus(payload) ? { type, payload } : null;
    }

    case 'server/event': {
      const payload = parseServerEvent(record.payload);
      return payload ? { type, payload } : null;
    }

    case 'context/update': {
      const payload = asRecord(record.payload);
      return isEditorContext(payload) ? { type, payload } : null;
    }

    case 'terminal-selection/update': {
      if (record.payload === null) return { type, payload: null };
      const payload = asRecord(record.payload);
      if (
        !payload ||
        typeof payload.text !== 'string' ||
        typeof payload.terminalName !== 'string'
      ) {
        return null;
      }
      return { type, payload: { text: payload.text, terminalName: payload.terminalName } };
    }

    case 'files/dropped': {
      if (!Array.isArray(record.payload)) return null;
      const payload = record.payload.filter(isDroppedFile);
      return payload.length === record.payload.length ? { type, payload } : null;
    }

    case 'files/removed': {
      const payload = asRecord(record.payload);
      if (!payload || typeof payload.path !== 'string') return null;
      return { type, payload: { path: payload.path } };
    }

    case 'files/search-results': {
      const payload = asRecord(record.payload);
      if (
        !payload ||
        typeof payload.requestId !== 'number' ||
        typeof payload.query !== 'string' ||
        !Array.isArray(payload.files) ||
        !payload.files.every(isDroppedFile)
      ) {
        return null;
      }
      return {
        type,
        payload: {
          requestId: payload.requestId,
          query: payload.query,
          files: payload.files,
        },
      };
    }

    case 'config/update': {
      const payload = asRecord(record.payload);
      if (
        !payload ||
        typeof payload.expandThinkingByDefault !== 'boolean' ||
        typeof payload.showStickyUserPrompt !== 'boolean' ||
        !isDesktopSessionPaneSide(payload.desktopSessionPaneSide) ||
        !isPermissionMode(payload.defaultPermissionMode)
      ) {
        return null;
      }
      return {
        type,
        payload: {
          expandThinkingByDefault: payload.expandThinkingByDefault,
          showStickyUserPrompt: payload.showStickyUserPrompt,
          desktopSessionPaneSide: payload.desktopSessionPaneSide,
          defaultPermissionMode: payload.defaultPermissionMode,
          ...(typeof payload.providerLimitPollIntervalSeconds === 'number' &&
          Number.isFinite(payload.providerLimitPollIntervalSeconds)
            ? {
                providerLimitPollIntervalSeconds: payload.providerLimitPollIntervalSeconds,
              }
            : {}),
          ...(payload.providerLimitsDisabled === undefined
            ? {}
            : {
                providerLimitsDisabled: payload.providerLimitsDisabled === true,
              }),
          ...(payload.providerLimitPollIntervalSeconds ===
          DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS
            ? { providerLimitsDisabled: true }
            : {}),
          ...(payload.providerLimitThresholdPercent === undefined
            ? {}
            : {
                providerLimitThresholdPercent: normalizeProviderLimitThresholdPercent(
                  payload.providerLimitThresholdPercent
                ),
              }),
        },
      };
    }

    case 'theme/update': {
      const payload = asRecord(record.payload);
      if (!payload || !isWebviewThemeKind(payload.theme)) return null;
      return { type, payload: { theme: payload.theme } };
    }

    case 'api/response': {
      const payload = asRecord(record.payload);
      if (!payload || typeof payload.id !== 'number') return null;
      return {
        type,
        payload: {
          id: payload.id,
          ...(payload.error !== undefined ? { error: String(payload.error) } : {}),
          ...(payload.data !== undefined ? { data: payload.data } : {}),
        },
      };
    }

    default:
      return null;
  }
}

function isServerStatus(value: Record<string, unknown> | null): value is ServerStatus {
  if (!value) return false;
  switch (value.state) {
    case 'starting':
    case 'stopped':
      return true;
    case 'running':
      return typeof value.url === 'string';
    case 'error':
      return typeof value.message === 'string';
    default:
      return false;
  }
}

function isDesktopSessionPaneSide(value: unknown): value is DesktopSessionPaneSide {
  return value === 'left' || value === 'right';
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'default' || value === 'auto' || value === 'full';
}

function isWebviewThemeKind(value: unknown): value is WebviewThemeKind {
  return (
    value === 'light' ||
    value === 'dark' ||
    value === 'high-contrast' ||
    value === 'high-contrast-light'
  );
}

function isEditorContext(value: unknown): value is EditorContext {
  const record = asRecord(value);
  if (!record) return false;
  if (record.workspacePath !== null && typeof record.workspacePath !== 'string') return false;
  if (!isActiveFile(record.activeFile)) return false;
  if (!isSelection(record.selection)) return false;
  if (!Array.isArray(record.diagnostics)) return false;
  return record.diagnostics.every(isDiagnostic);
}

function isActiveFile(
  value: unknown
): value is { path: string; relativePath: string; language: string } | null {
  if (value === null) return true;
  const record = asRecord(value);
  return (
    !!record &&
    typeof record.path === 'string' &&
    typeof record.relativePath === 'string' &&
    typeof record.language === 'string'
  );
}

function isSelection(value: unknown): value is { startLine: number; endLine: number } | null {
  if (value === null) return true;
  const record = asRecord(value);
  return (
    !!record &&
    typeof record.startLine === 'number' &&
    typeof record.endLine === 'number' &&
    Number.isFinite(record.startLine) &&
    Number.isFinite(record.endLine)
  );
}

function isDiagnostic(value: unknown): boolean {
  const record = asRecord(value);
  return (
    !!record &&
    typeof record.path === 'string' &&
    (record.severity === 'error' || record.severity === 'warning' || record.severity === 'info') &&
    typeof record.message === 'string' &&
    typeof record.line === 'number' &&
    Number.isFinite(record.line)
  );
}

function isLineRange(value: unknown): boolean {
  const record = asRecord(value);
  return (
    !!record &&
    typeof record.startLine === 'number' &&
    typeof record.endLine === 'number' &&
    Number.isFinite(record.startLine) &&
    Number.isFinite(record.endLine)
  );
}

function isDroppedFile(value: unknown): value is DroppedFile {
  const record = asRecord(value);
  if (!record) return false;
  if (typeof record.path !== 'string' || typeof record.relativePath !== 'string') return false;
  if (record.type !== 'file' && record.type !== 'directory') return false;
  if (
    record.attachmentSequence !== undefined &&
    (typeof record.attachmentSequence !== 'number' || !Number.isFinite(record.attachmentSequence))
  ) {
    return false;
  }
  if (record.lineRanges === undefined) return true;
  return Array.isArray(record.lineRanges) && record.lineRanges.every(isLineRange);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
