import type { Permission, SessionStatus } from '../types';
import { asRecord, isNumber, isString, type UnknownRecord, isObject } from './runtime-values';

/**
 * Pure helpers that normalize raw server-event payloads into domain shapes.
 *
 * Extracted from `useOpenCode` so this logic can be unit-tested without
 * spinning up SolidJS stores. Keep these dependency-free: no imports from
 * the global webview `state`, no side effects.
 */

/**
 * True when a session status represents active work (`busy` or `retry`).
 * Centralized so every layer (store, status ops, watchdog, event handlers)
 * agrees on what "running" means instead of re-deriving it inline.
 */
export function isRunningSessionStatus(status: SessionStatus | null | undefined): boolean {
  return status?.type === 'busy' || status?.type === 'retry';
}

export function isNormalizedPermission(props: UnknownRecord): props is Permission {
  return (
    isString(props.id) &&
    isString(props.sessionID) &&
    isString(props.type) &&
    isString(props.messageID) &&
    !!props.time &&
    isObject(props.time)
  );
}

export function normalizePermissionEvent<T>(props: T): Permission | null {
  // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
  const record = props && isObject(props) ? (props as UnknownRecord) : null;
  if (!record) return null;
  const source =
    // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
    record.info && isObject(record.info) ? (record.info as UnknownRecord) : record;
  if (isNormalizedPermission(source)) return source;
  const id = isString(source.id)
    ? source.id
    : isString(source.permissionID)
      ? source.permissionID
      : isString(source.requestID)
        ? source.requestID
        : null;
  const sessionID = isString(source.sessionID) ? source.sessionID : null;
  if (!id || !sessionID) return null;

  // SAFETY: The surrounding shape or discriminator check establishes the owner type contract used below.
  const tool = (source.tool as { messageID?: string; callID?: string } | undefined) || undefined;
  const v2Source =
    // SAFETY: The surrounding shape or discriminator check establishes the owner type contract used below.
    source.source && isObject(source.source)
      ? (source.source as { messageID?: string; callID?: string })
      : undefined;
  const permissionName = isString(source.permission)
    ? source.permission
    : isString(source.type)
      ? source.type
      : isString(source.action)
        ? source.action
        : '';
  const patternValue = source.patterns ?? source.pattern ?? source.resources;
  // SAFETY: The surrounding shape or discriminator check establishes the string contract used below.
  const patterns = Array.isArray(patternValue)
    ? (patternValue.filter((p): p is string => isString(p)) as string[])
    : isString(patternValue)
      ? patternValue
      : undefined;
  const title =
    isString(source.title) && source.title.trim().length > 0
      ? source.title
      : [permissionName, Array.isArray(patterns) ? patterns.join(', ') : patterns]
          .filter(Boolean)
          .join(' ') || 'Permission required';
  const created = asRecord(source.time)?.created;
  const createdAt = isNumber(created) ? created : Date.now();

  return {
    id,
    type: permissionName,
    pattern: patterns,
    sessionID,
    messageID: isString(source.messageID)
      ? source.messageID
      : isString(tool?.messageID)
        ? tool.messageID
        : isString(v2Source?.messageID)
          ? v2Source.messageID
          : '',
    callID: isString(source.callID)
      ? source.callID
      : isString(tool?.callID)
        ? tool.callID
        : isString(v2Source?.callID)
          ? v2Source.callID
          : undefined,
    title,
    metadata: asRecord(source.metadata) ?? {},
    time: { created: createdAt },
    recoveredIncomplete: source.recoveredIncomplete === true ? true : undefined,
  };
}
