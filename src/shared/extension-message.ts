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
import { MAX_NATIVE_PDF_TOTAL_BYTES, isNativePdfAttachment } from './native-pdf';
import { isChatFontFamily, isResponseTimestampPlacement } from './provider-limit-config';
import { asRecord, isBoolean, isNumber, isString } from './type-utils';
import type { UnknownRecord } from './type-utils';

const KNOWN_TYPES = new Set<string>([
  'server/status',
  'server/restart-blocked',
  'server/event',
  'providers/refresh',
  'providers/status',
  'context/update',
  'terminal-selection/update',
  'files/dropped',
  'pdfs/picked',
  'pdfs/stored',
  'images/stored',
  'files/removed',
  'files/search-results',
  'config/update',
  'theme/update',
  'vscode/open-result',
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
export function parseExtensionMessage<T>(value: T): ExtensionMessage | null {
  const record = asRecord(value);
  if (!record) return null;
  const type = record.type;
  if (!isKnownExtensionMessageType(type)) return null;

  switch (type) {
    case 'command/new-session': {
      if (record.payload === undefined) return { type };
      const payload = asRecord(record.payload);
      if (!payload || !isString(payload.prefill)) return null;
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

    case 'providers/status': {
      const payload = asRecord(record.payload);
      if (!isBoolean(payload?.pending)) return null;
      return { type, payload: { pending: payload.pending } };
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
      if (!payload || !isString(payload.text) || !isString(payload.terminalName)) {
        return null;
      }
      return { type, payload: { text: payload.text, terminalName: payload.terminalName } };
    }

    case 'files/dropped': {
      if (!Array.isArray(record.payload)) return null;
      const payload = record.payload.filter(isDroppedFile);
      return payload.length === record.payload.length ? { type, payload } : null;
    }

    case 'pdfs/picked': {
      if (!Array.isArray(record.payload) || !record.payload.every(isNativePdfAttachment)) {
        return null;
      }
      const totalSize = record.payload.reduce((total, pdf) => total + pdf.size, 0);
      return totalSize <= MAX_NATIVE_PDF_TOTAL_BYTES ? { type, payload: record.payload } : null;
    }

    case 'pdfs/stored': {
      const payload = asRecord(record.payload);
      if (!isString(payload?.id) || !isDroppedFile(payload.contextFile)) return null;
      return { type, payload: { id: payload.id, contextFile: payload.contextFile } };
    }

    case 'images/stored': {
      const payload = asRecord(record.payload);
      if (!isString(payload?.id) || !isDroppedFile(payload.contextFile)) return null;
      return { type, payload: { id: payload.id, contextFile: payload.contextFile } };
    }

    case 'files/removed': {
      const payload = asRecord(record.payload);
      if (!payload || !isString(payload.path)) return null;
      return { type, payload: { path: payload.path } };
    }

    case 'files/search-results': {
      const payload = asRecord(record.payload);
      if (
        !payload ||
        !isNumber(payload.requestId) ||
        !isString(payload.query) ||
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
        !isDesktopSessionPaneSide(payload.desktopSessionPaneSide) ||
        !isPermissionMode(payload.defaultPermissionMode)
      ) {
        return null;
      }
      const config: Extract<ExtensionMessage, { type: 'config/update' }>['payload'] = {
        desktopSessionPaneSide: payload.desktopSessionPaneSide,
        defaultPermissionMode: payload.defaultPermissionMode,
      };
      if (isBoolean(payload.showInlineFileChanges)) {
        config.showInlineFileChanges = payload.showInlineFileChanges;
      }
      if (isBoolean(payload.showChangedFiles)) config.showChangedFiles = payload.showChangedFiles;
      if (isNumber(payload.chatFontSize)) config.chatFontSize = payload.chatFontSize;
      if (isChatFontFamily(payload.chatFontFamily)) {
        config.chatFontFamily = payload.chatFontFamily;
      }
      if (isBoolean(payload.showRequestTimestamps)) {
        config.showRequestTimestamps = payload.showRequestTimestamps;
      }
      if (isBoolean(payload.showResponseTimestamps)) {
        config.showResponseTimestamps = payload.showResponseTimestamps;
      }
      if (isResponseTimestampPlacement(payload.responseTimestamp)) {
        config.responseTimestamp = payload.responseTimestamp;
      }
      return { type, payload: config };
    }

    case 'theme/update': {
      const payload = asRecord(record.payload);
      if (!payload || !isWebviewThemeKind(payload.theme)) return null;
      return { type, payload: { theme: payload.theme } };
    }

    case 'vscode/open-result': {
      const payload = asRecord(record.payload);
      if (
        !payload ||
        !isNumber(payload.requestId) ||
        (payload.status !== 'opened' && payload.status !== 'unavailable')
      ) {
        return null;
      }
      return { type, payload: { requestId: payload.requestId, status: payload.status } };
    }

    case 'api/response': {
      const payload = asRecord(record.payload);
      if (!payload || !isNumber(payload.id)) return null;
      const response: Extract<ExtensionMessage, { type: 'api/response' }>['payload'] = {
        id: payload.id,
      };
      if (payload.error !== undefined) response.error = String(payload.error);
      if (payload.data !== undefined) response.data = payload.data;
      return { type, payload: response };
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
          // SAFETY: Ralph run payloads are host-owned snapshots; the loop above validates the only migration-only field.
          runs: runs as RalphStatePayload['runs'],
          activeIds: payload.activeIds.filter(isString),
        },
      };
    }

    default:
      return null;
  }
}

function parseRestartBlockedState<T>(value: T): RestartBlockedState | null {
  const payload = asRecord(value);
  if (
    !payload ||
    !isNumber(payload.totalSessionCount) ||
    !Number.isSafeInteger(payload.totalSessionCount) ||
    payload.totalSessionCount <= 0 ||
    !Array.isArray(payload.directories)
  ) {
    return null;
  }
  const directories = payload.directories.map((directoryValue) => {
    const row = asRecord(directoryValue);
    if (
      !row ||
      (row.directory !== null && !isString(row.directory)) ||
      !isNumber(row.sessionCount) ||
      !Number.isSafeInteger(row.sessionCount) ||
      row.sessionCount <= 0
    ) {
      return null;
    }
    return {
      directory: row.directory,
      sessionCount: row.sessionCount,
    };
  });
  if (directories.some((row) => row === null)) return null;
  const typedDirectories = directories.filter((row) => row !== null);
  if (
    typedDirectories.reduce((total, row) => total + row.sessionCount, 0) !==
    payload.totalSessionCount
  ) {
    return null;
  }
  const result: RestartBlockedState = {
    totalSessionCount: payload.totalSessionCount,
    directories: typedDirectories,
  };
  if (isNumber(payload.checkId) && Number.isSafeInteger(payload.checkId) && payload.checkId >= 0) {
    result.checkId = payload.checkId;
  }
  return result;
}

function isServerStatus(value: UnknownRecord | null): value is ServerStatus {
  if (!value) return false;
  switch (value.state) {
    case 'starting':
    case 'stopped':
      return true;
    case 'running':
      return isString(value.url);
    case 'error':
      return isString(value.message);
    default:
      return false;
  }
}

function isDesktopSessionPaneSide<T>(value: T): value is T & DesktopSessionPaneSide {
  return value === 'left' || value === 'right';
}

function isWebviewThemeKind<T>(value: T): value is T & WebviewThemeKind {
  return (
    value === 'light' ||
    value === 'dark' ||
    value === 'high-contrast' ||
    value === 'high-contrast-light'
  );
}

function isEditorContext<T>(value: T): value is T & EditorContext {
  const record = asRecord(value);
  if (!record) return false;
  if (record.workspacePath !== null && !isString(record.workspacePath)) return false;
  if (!isActiveFile(record.activeFile)) return false;
  if (!isSelection(record.selection)) return false;
  if (record.workspaceFolders !== undefined && !isWorkspaceFolders(record.workspaceFolders)) {
    return false;
  }
  if (record.editorText !== undefined && !isEditorText(record.editorText)) return false;
  if (!Array.isArray(record.diagnostics)) return false;
  if (
    record.diagnosticsTotal !== undefined &&
    (!isNumber(record.diagnosticsTotal) ||
      !Number.isInteger(record.diagnosticsTotal) ||
      record.diagnosticsTotal < 0)
  ) {
    return false;
  }
  return record.diagnostics.every(isDiagnostic);
}

function isWorkspaceFolders<T>(value: T): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      const record = asRecord(item);
      return !!record && isString(record.name) && isString(record.path);
    })
  );
}

function isEditorText<T>(value: T): boolean {
  if (value === null) return true;
  const record = asRecord(value);
  return (
    !!record &&
    (record.kind === 'selection' || record.kind === 'dirty-buffer') &&
    (record.path === null || isString(record.path)) &&
    isString(record.relativePath) &&
    isString(record.language) &&
    isSelection(record.range) &&
    record.range !== null &&
    isString(record.text) &&
    isBoolean(record.truncated)
  );
}

function isActiveFile<T>(
  value: T
): value is T & ({ path: string; relativePath: string; language: string } | null) {
  if (value === null) return true;
  const record = asRecord(value);
  return (
    !!record && isString(record.path) && isString(record.relativePath) && isString(record.language)
  );
}

function isSelection<T>(value: T): value is T & ({ startLine: number; endLine: number } | null) {
  if (value === null) return true;
  const record = asRecord(value);
  return (
    !!record &&
    isNumber(record.startLine) &&
    isNumber(record.endLine) &&
    Number.isFinite(record.startLine) &&
    Number.isFinite(record.endLine)
  );
}

function isDiagnostic<T>(value: T): value is T & EditorContext['diagnostics'][number] {
  const record = asRecord(value);
  return (
    !!record &&
    isString(record.path) &&
    (record.severity === 'error' || record.severity === 'warning' || record.severity === 'info') &&
    isString(record.message) &&
    isNumber(record.line) &&
    Number.isFinite(record.line)
  );
}

function isLineRange<T>(value: T): value is T & ContextLineRange {
  const record = asRecord(value);
  return (
    !!record &&
    isNumber(record.startLine) &&
    isNumber(record.endLine) &&
    Number.isFinite(record.startLine) &&
    Number.isFinite(record.endLine)
  );
}

function isDroppedFile<T>(value: T): value is T & DroppedFile {
  const record = asRecord(value);
  if (!record) return false;
  if (!isString(record.path) || !isString(record.relativePath)) return false;
  if (record.type !== 'file' && record.type !== 'directory') return false;
  if (
    record.attachmentSequence !== undefined &&
    (!isNumber(record.attachmentSequence) || !Number.isFinite(record.attachmentSequence))
  ) {
    return false;
  }
  if (record.lineRanges === undefined) return true;
  return Array.isArray(record.lineRanges) && record.lineRanges.every(isLineRange);
}

function isKnownExtensionMessageType<T>(value: T): value is T & ExtensionMessage['type'] {
  return isString(value) && KNOWN_TYPES.has(value);
}
