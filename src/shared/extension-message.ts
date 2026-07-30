import {
  isPermissionMode,
  parseServerEvent,
  type ContextLineRange,
  type DesktopSessionPaneSide,
  type DroppedFile,
  type EditorContext,
  type ExtensionMessage,
  type RalphStatePayload,
  type RestartBlockedState,
  type ServerStatus,
  type WebviewThemeKind,
} from './protocol';
import {
  DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS,
  normalizeProviderLimitThresholdPercent,
} from './provider-limit-config';
import { asRecord } from './type-utils';

const KNOWN_TYPES = new Set<ExtensionMessage['type']>([
  'server/status',
  'server/restart-blocked',
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
  'command/search-sessions',
  'command/open-attention-sessions',
  'command/switch-session',
  'command/abort',
  'ralph/state',
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
    case 'command/new-session': {
      if (record.payload === undefined) return { type };
      const payload = asRecord(record.payload);
      if (!payload || typeof payload.prefill !== 'string') return null;
      return { type, payload: { prefill: payload.prefill } };
    }

    case 'command/focus-input':
    case 'command/search-sessions':
    case 'command/open-attention-sessions':
    case 'command/abort':
      return { type };

    case 'providers/refresh': {
      if (record.payload === undefined) return { type };
      const payload = asRecord(record.payload);
      if (payload?.revalidateAuth !== true) return null;
      return { type, payload: { revalidateAuth: true } };
    }

    case 'command/switch-session': {
      const payload = asRecord(record.payload);
      if (payload?.direction !== 'previous' && payload?.direction !== 'next') return null;
      return { type, payload: { direction: payload.direction } };
    }

    case 'server/status': {
      const payload = asRecord(record.payload);
      return isServerStatus(payload) ? { type, payload } : null;
    }

    case 'server/restart-blocked': {
      const payload = parseRestartBlockedState(record.payload);
      return payload ? { type, payload } : null;
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
        !isDesktopSessionPaneSide(payload.desktopSessionPaneSide) ||
        !isPermissionMode(payload.defaultPermissionMode)
      ) {
        return null;
      }
      return {
        type,
        payload: {
          expandThinkingByDefault: payload.expandThinkingByDefault,
          ...(typeof payload.showInlineFileChanges === 'boolean'
            ? { showInlineFileChanges: payload.showInlineFileChanges }
            : {}),
          ...(typeof payload.showChangedFiles === 'boolean'
            ? { showChangedFiles: payload.showChangedFiles }
            : {}),
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

    case 'ralph/state': {
      const payload = asRecord(record.payload);
      const runs = asRecord(payload?.runs);
      if (!payload || !runs || !Array.isArray(payload.activeIds)) return null;
      for (const run of Object.values(runs)) {
        const acknowledged = asRecord(run)?.legacyMigrationAcknowledged;
        if (acknowledged !== undefined && acknowledged !== true) return null;
      }
      return {
        type,
        payload: {
          runs: runs as RalphStatePayload['runs'],
          activeIds: payload.activeIds.filter((id): id is string => typeof id === 'string'),
        },
      };
    }

    default:
      return null;
  }
}

function parseRestartBlockedState(value: unknown): RestartBlockedState | null {
  const payload = asRecord(value);
  if (
    !payload ||
    !Number.isSafeInteger(payload.totalSessionCount) ||
    (payload.totalSessionCount as number) <= 0 ||
    !Array.isArray(payload.directories)
  ) {
    return null;
  }
  const directories = payload.directories.map((directoryValue) => {
    const row = asRecord(directoryValue);
    if (
      !row ||
      (row.directory !== null && typeof row.directory !== 'string') ||
      !Number.isSafeInteger(row.sessionCount) ||
      (row.sessionCount as number) <= 0
    ) {
      return null;
    }
    return {
      directory: row.directory as string | null,
      sessionCount: row.sessionCount as number,
    };
  });
  if (directories.some((row) => row === null)) return null;
  const typedDirectories = directories as RestartBlockedState['directories'];
  if (
    typedDirectories.reduce((total, row) => total + row.sessionCount, 0) !==
    payload.totalSessionCount
  ) {
    return null;
  }
  return {
    totalSessionCount: payload.totalSessionCount as number,
    directories: typedDirectories,
    ...(Number.isSafeInteger(payload.checkId) && (payload.checkId as number) >= 0
      ? { checkId: payload.checkId as number }
      : {}),
  };
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
  if (record.workspaceFolders !== undefined && !isWorkspaceFolders(record.workspaceFolders)) {
    return false;
  }
  if (record.editorText !== undefined && !isEditorText(record.editorText)) return false;
  if (!Array.isArray(record.diagnostics)) return false;
  if (
    record.diagnosticsTotal !== undefined &&
    (!Number.isInteger(record.diagnosticsTotal) || (record.diagnosticsTotal as number) < 0)
  ) {
    return false;
  }
  return record.diagnostics.every(isDiagnostic);
}

function isWorkspaceFolders(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      const record = asRecord(item);
      return !!record && typeof record.name === 'string' && typeof record.path === 'string';
    })
  );
}

function isEditorText(value: unknown): boolean {
  if (value === null) return true;
  const record = asRecord(value);
  return (
    !!record &&
    (record.kind === 'selection' || record.kind === 'dirty-buffer') &&
    (record.path === null || typeof record.path === 'string') &&
    typeof record.relativePath === 'string' &&
    typeof record.language === 'string' &&
    isSelection(record.range) &&
    record.range !== null &&
    typeof record.text === 'string' &&
    typeof record.truncated === 'boolean'
  );
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

function isDiagnostic(value: unknown): value is EditorContext['diagnostics'][number] {
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

function isLineRange(value: unknown): value is ContextLineRange {
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
