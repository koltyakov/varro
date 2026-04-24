import type { ExtensionMessage, ServerEventName, ServerStatus } from './protocol';

const KNOWN_TYPES = new Set<ExtensionMessage['type']>([
  'server/status',
  'server/event',
  'pending-attention/update',
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
    case 'command/abort':
      return { type };

    case 'server/status': {
      const payload = asRecord(record.payload);
      return isServerStatus(payload) ? { type, payload } : null;
    }

    case 'server/event': {
      const payload = asRecord(record.payload);
      if (!payload) return null;
      const eventType = typeof payload.type === 'string' ? payload.type : null;
      if (!eventType) return null;
      return {
        type,
        payload: {
          type: eventType as ServerEventName,
          properties: asRecord(payload.properties) as Record<string, unknown> | undefined,
        },
      };
    }

    case 'pending-attention/update': {
      const payload = asRecord(record.payload);
      if (!payload || !Array.isArray(payload.sessionIds)) return null;
      const sessionIds = payload.sessionIds.filter(
        (item): item is string => typeof item === 'string'
      );
      return { type, payload: { sessionIds } };
    }

    case 'context/update': {
      const payload = asRecord(record.payload);
      return payload ? ({ type, payload } as unknown as ExtensionMessage) : null;
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
      return { type, payload: record.payload } as unknown as ExtensionMessage;
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
        !Array.isArray(payload.files)
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
      } as unknown as ExtensionMessage;
    }

    case 'config/update': {
      const payload = asRecord(record.payload);
      if (
        !payload ||
        typeof payload.expandThinkingByDefault !== 'boolean' ||
        typeof payload.showStickyUserPrompt !== 'boolean' ||
        (payload.desktopSessionPaneSide !== 'left' && payload.desktopSessionPaneSide !== 'right')
      ) {
        return null;
      }
      return {
        type,
        payload: {
          expandThinkingByDefault: payload.expandThinkingByDefault,
          showStickyUserPrompt: payload.showStickyUserPrompt,
          desktopSessionPaneSide: payload.desktopSessionPaneSide,
        },
      };
    }

    case 'theme/update': {
      const payload = asRecord(record.payload);
      if (!payload || typeof payload.theme !== 'string') return null;
      return { type, payload: { theme: payload.theme as never } };
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
