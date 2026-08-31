import {
  isPermissionMode,
  isSafePersistedSessionId,
  parseServerEvent,
  type ChatModelSelection,
  type ClipboardImageSnapshot,
  type ContextLineRange,
  type DesktopSessionPaneSide,
  type DroppedFile,
  type EditorContext,
  type ExtensionMessage,
  type RalphStatePayload,
  type RestartBlockedState,
  type ServerStatus,
  type SiblingWorkspaceAlert,
  type WebviewThemeKind,
} from './protocol';
import { MAX_NATIVE_PDF_TOTAL_BYTES, isNativePdfAttachment } from './native-pdf';
import { parseModelPreferences } from './model-preferences';
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
  'composer/images-sync',
  'files/removed',
  'files/search-results',
  'config/update',
  'session/catalog-invalidated',
  'theme/update',
  'vscode/open-result',
  'api/response',
  'queued-messages/sync',
  'queued-messages/session-status',
  'queued-messages/claim-result',
  'permission-modes/sync',
  'session-models/sync',
  'session-plan-state/sync',
  'session-plan-state/update',
  'model-preferences/sync',
  'editor-tabs/state',
  'sibling-workspace-alerts/update',
  'permission-automation/update',
  'permission/actionable',
  'recovery/interrupted-sessions',
  'command/new-session',
  'command/open-session',
  'command/focus-input',
  'command/search-sessions',
  'command/open-attention-sessions',
  'command/open-completed-sessions',
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

    case 'command/open-session': {
      const payload = asRecord(record.payload);
      if (!payload || !isString(payload.sessionId)) return null;
      if (payload.directory !== undefined && !isString(payload.directory)) return null;
      const parsedPayload: Extract<ExtensionMessage, { type: 'command/open-session' }>['payload'] =
        { sessionId: payload.sessionId };
      if (isString(payload.directory)) parsedPayload.directory = payload.directory;
      return { type, payload: parsedPayload };
    }

    case 'command/focus-input':
    case 'command/search-sessions':
    case 'command/open-attention-sessions':
    case 'command/open-completed-sessions':
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

    case 'sibling-workspace-alerts/update': {
      const payload = parseSiblingWorkspaceAlerts(record.payload);
      return payload ? { type, payload } : null;
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

    case 'composer/images-sync': {
      const payload = asRecord(record.payload);
      if (!payload || !Array.isArray(payload.images) || !payload.images.every(isClipboardImage)) {
        return null;
      }
      return { type, payload: { images: payload.images } };
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
        !isPermissionMode(payload.defaultPermissionMode) ||
        !isChatFontSize(payload.chatFontSize) ||
        !isChatFontSize(payload.chatEditorFontSize) ||
        !isString(payload.chatFontFamily)
      ) {
        return null;
      }
      const config: Extract<ExtensionMessage, { type: 'config/update' }>['payload'] = {
        desktopSessionPaneSide: payload.desktopSessionPaneSide,
        defaultPermissionMode: payload.defaultPermissionMode,
        chatFontSize: payload.chatFontSize,
        chatEditorFontSize: payload.chatEditorFontSize,
        chatFontFamily: payload.chatFontFamily,
      };
      if (isBoolean(payload.showFileDiffs)) {
        config.showFileDiffs = payload.showFileDiffs;
      }
      if (isBoolean(payload.expandThinking)) config.expandThinking = payload.expandThinking;
      if (isBoolean(payload.showChangedFiles)) config.showChangedFiles = payload.showChangedFiles;
      if (isBoolean(payload.showTurnTimer)) config.showTurnTimer = payload.showTurnTimer;
      return { type, payload: config };
    }

    case 'session/catalog-invalidated':
      return { type };

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

    case 'queued-messages/sync': {
      const payload = asRecord(record.payload);
      if (!payload || !Array.isArray(payload.messages)) return null;
      for (const message of payload.messages) {
        const item = asRecord(message);
        const queuedContext = asRecord(item?.queuedContext);
        if (
          !item ||
          !isString(item.id) ||
          !isString(item.sessionId) ||
          !isString(item.text) ||
          (item.ownerViewId !== undefined && !isString(item.ownerViewId)) ||
          (item.queuedContext !== undefined && !queuedContext) ||
          (queuedContext?.visionDelegationAvailable !== undefined &&
            !isBoolean(queuedContext.visionDelegationAvailable))
        ) {
          return null;
        }
      }
      return {
        type,
        payload: {
          // SAFETY: The extension owns this snapshot; routing-critical queue fields are validated above.
          messages: payload.messages as Extract<
            ExtensionMessage,
            { type: 'queued-messages/sync' }
          >['payload']['messages'],
        },
      };
    }

    case 'queued-messages/session-status': {
      const payload = asRecord(record.payload);
      if (
        !isString(payload?.sessionId) ||
        (payload.status !== 'busy' && payload.status !== 'idle')
      ) {
        return null;
      }
      return { type, payload: { sessionId: payload.sessionId, status: payload.status } };
    }

    case 'queued-messages/claim-result': {
      const payload = asRecord(record.payload);
      const lease = payload?.lease;
      if (
        !payload ||
        !isNumber(payload.requestId) ||
        !Number.isSafeInteger(payload.requestId) ||
        payload.requestId < 0 ||
        !isString(payload.itemId) ||
        !isString(payload.sessionId) ||
        !isBoolean(payload.granted) ||
        (lease !== undefined && (!isNumber(lease) || !Number.isSafeInteger(lease) || lease <= 0)) ||
        (payload.granted ? lease === undefined : lease !== undefined)
      ) {
        return null;
      }
      const result: Extract<ExtensionMessage, { type: 'queued-messages/claim-result' }>['payload'] =
        {
          requestId: payload.requestId,
          itemId: payload.itemId,
          sessionId: payload.sessionId,
          granted: payload.granted,
        };
      if (lease !== undefined) result.lease = lease;
      return { type, payload: result };
    }

    case 'permission-modes/sync': {
      const payload = asRecord(record.payload);
      const modes = asRecord(payload?.modes);
      if (!modes) return null;
      const entries: Array<
        [
          string,
          Extract<ExtensionMessage, { type: 'permission-modes/sync' }>['payload']['modes'][string],
        ]
      > = [];
      for (const [sessionId, mode] of Object.entries(modes)) {
        if (!isSafePersistedSessionId(sessionId) || !isPermissionMode(mode)) return null;
        entries.push([sessionId, mode]);
      }
      const recoveringSessionIds = payload?.recoveringSessionIds;
      if (
        recoveringSessionIds !== undefined &&
        (!Array.isArray(recoveringSessionIds) ||
          !recoveringSessionIds.every(isSafePersistedSessionId))
      ) {
        return null;
      }
      const parsedPayload: Extract<ExtensionMessage, { type: 'permission-modes/sync' }>['payload'] =
        {
          modes: Object.fromEntries(entries),
        };
      if (recoveringSessionIds) parsedPayload.recoveringSessionIds = recoveringSessionIds;
      return {
        type,
        payload: parsedPayload,
      };
    }

    case 'session-models/sync': {
      const payload = asRecord(record.payload);
      const models = asRecord(payload?.models);
      if (!models) return null;
      const entries: Array<[string, ChatModelSelection]> = [];
      for (const [sessionId, modelValue] of Object.entries(models)) {
        if (!isSafePersistedSessionId(sessionId)) return null;
        const model = asRecord(modelValue);
        if (!model || !isString(model.providerID) || !isString(model.modelID)) return null;
        if (model.variant !== undefined && !isString(model.variant)) return null;
        entries.push([
          sessionId,
          model.variant
            ? { providerID: model.providerID, modelID: model.modelID, variant: model.variant }
            : { providerID: model.providerID, modelID: model.modelID },
        ]);
      }
      return { type, payload: { models: Object.fromEntries(entries) } };
    }

    case 'session-plan-state/sync': {
      const payload = asRecord(record.payload);
      const state = asRecord(payload?.state);
      const agents = asRecord(payload?.agents);
      if (!state || !agents) return null;
      const entries: Array<[string, number | null]> = [];
      for (const [sessionId, skippedAt] of Object.entries(state)) {
        if (
          !isSafePersistedSessionId(sessionId) ||
          (skippedAt !== null && (!isNumber(skippedAt) || !Number.isFinite(skippedAt)))
        ) {
          return null;
        }
        entries.push([sessionId, skippedAt]);
      }
      const agentEntries: Array<[string, string]> = [];
      for (const [sessionId, agent] of Object.entries(agents)) {
        if (!isSafePersistedSessionId(sessionId) || !isString(agent) || !agent.trim()) return null;
        agentEntries.push([sessionId, agent]);
      }
      return {
        type,
        payload: {
          state: Object.fromEntries(entries),
          agents: Object.fromEntries(agentEntries),
        },
      };
    }

    case 'session-plan-state/update': {
      const payload = asRecord(record.payload);
      const sessionId = payload?.sessionId;
      if (!isSafePersistedSessionId(sessionId)) return null;
      const skippedAt = payload?.skippedAt;
      if (
        skippedAt !== undefined &&
        skippedAt !== null &&
        (!isNumber(skippedAt) || !Number.isFinite(skippedAt))
      ) {
        return null;
      }
      const agent = payload?.agent;
      if (agent !== undefined && (!isString(agent) || !agent.trim())) return null;
      if (skippedAt === undefined && agent === undefined) return null;
      const result: Extract<ExtensionMessage, { type: 'session-plan-state/update' }> = {
        type,
        payload: { sessionId },
      };
      if (skippedAt !== undefined) result.payload.skippedAt = skippedAt;
      if (agent !== undefined) result.payload.agent = agent;
      return result;
    }

    case 'model-preferences/sync': {
      if (!asRecord(record.payload)) return null;
      return { type, payload: parseModelPreferences(record.payload) };
    }

    case 'editor-tabs/state': {
      const payload = asRecord(record.payload);
      return payload &&
        isBoolean(payload.open) &&
        Array.isArray(payload.sessionIds) &&
        payload.sessionIds.every(isString) &&
        Array.isArray(payload.openSessionIds) &&
        payload.openSessionIds.every(isString)
        ? {
            type,
            payload: {
              open: payload.open,
              sessionIds: payload.sessionIds,
              openSessionIds: payload.openSessionIds,
            },
          }
        : null;
    }

    case 'permission-automation/update': {
      const payload = asRecord(record.payload);
      return payload &&
        isBoolean(payload.owner) &&
        isNumber(payload.lease) &&
        Number.isSafeInteger(payload.lease) &&
        payload.lease >= 0
        ? { type, payload: { owner: payload.owner, lease: payload.lease } }
        : null;
    }

    case 'permission/actionable': {
      const payload = asRecord(record.payload);
      return payload && isString(payload.permissionId)
        ? { type, payload: { permissionId: payload.permissionId } }
        : null;
    }

    case 'recovery/interrupted-sessions': {
      const payload = asRecord(record.payload);
      return payload &&
        isNumber(payload.claimId) &&
        Number.isSafeInteger(payload.claimId) &&
        payload.claimId > 0 &&
        Array.isArray(payload.sessionIds) &&
        payload.sessionIds.every(isString)
        ? {
            type,
            payload: { claimId: payload.claimId, sessionIds: [...new Set(payload.sessionIds)] },
          }
        : null;
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

function isChatFontSize<T>(value: T): value is T & number {
  return isNumber(value) && Number.isFinite(value) && value >= 6 && value <= 100;
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

export function isEditorContext<T>(value: T): value is T & EditorContext {
  const record = asRecord(value);
  if (!record) return false;
  if (record.workspacePath !== null && !isString(record.workspacePath)) return false;
  if (
    record.activeWorkspacePath !== undefined &&
    record.activeWorkspacePath !== null &&
    !isString(record.activeWorkspacePath)
  ) {
    return false;
  }
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

function parseSiblingWorkspaceAlerts<T>(value: T): SiblingWorkspaceAlert[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const alerts: SiblingWorkspaceAlert[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (
      !record ||
      !isString(record.name) ||
      !isString(record.path) ||
      !isNumber(record.count) ||
      !Number.isSafeInteger(record.count) ||
      record.count < 1 ||
      !Array.isArray(record.kinds) ||
      record.kinds.length < 1 ||
      record.kinds.length > 4 ||
      new Set(record.kinds).size !== record.kinds.length ||
      record.kinds.some(
        (kind) =>
          kind !== 'attention' && kind !== 'completed' && kind !== 'error' && kind !== 'plan-ready'
      )
    ) {
      return null;
    }
    alerts.push({
      name: record.name,
      path: record.path,
      count: record.count,
      kinds: record.kinds,
    });
  }
  return alerts;
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

function isClipboardImage<T>(value: T): value is T & ClipboardImageSnapshot {
  const record = asRecord(value);
  return (
    !!record &&
    isString(record.id) &&
    isString(record.url) &&
    isString(record.mime) &&
    isString(record.filename) &&
    isNumber(record.size) &&
    Number.isFinite(record.size) &&
    (record.contentKey === undefined || isString(record.contentKey)) &&
    (record.attachmentSequence === undefined ||
      (isNumber(record.attachmentSequence) && Number.isSafeInteger(record.attachmentSequence))) &&
    (record.contextFile === undefined || isDroppedFile(record.contextFile))
  );
}

function isKnownExtensionMessageType<T>(value: T): value is T & ExtensionMessage['type'] {
  return isString(value) && KNOWN_TYPES.has(value);
}
