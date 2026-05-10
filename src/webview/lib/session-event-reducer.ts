import type { Permission } from '../types';

/**
 * Pure helpers that normalize raw server-event payloads into domain shapes.
 *
 * Extracted from `useOpenCode` so this logic can be unit-tested without
 * spinning up SolidJS stores. Keep these dependency-free: no imports from
 * the global webview `state`, no side effects.
 */

export function isNormalizedPermission(props: Record<string, unknown>): props is Permission {
  return (
    typeof props.id === 'string' &&
    typeof props.sessionID === 'string' &&
    typeof props.type === 'string' &&
    typeof props.messageID === 'string' &&
    !!props.time &&
    typeof props.time === 'object'
  );
}

export function normalizePermissionEvent(props: Record<string, unknown>): Permission | null {
  const source =
    props.info && typeof props.info === 'object' ? (props.info as Record<string, unknown>) : props;
  if (isNormalizedPermission(source)) return source;
  const id =
    typeof source.id === 'string'
      ? source.id
      : typeof source.permissionID === 'string'
        ? source.permissionID
        : typeof source.requestID === 'string'
          ? source.requestID
          : null;
  const sessionID = typeof source.sessionID === 'string' ? source.sessionID : null;
  if (!id || !sessionID) return null;

  const tool = (source.tool as { messageID?: string; callID?: string } | undefined) || undefined;
  const permissionName =
    typeof source.permission === 'string'
      ? source.permission
      : typeof source.type === 'string'
        ? source.type
        : '';
  const patternValue = source.patterns ?? source.pattern;
  const patterns = Array.isArray(patternValue)
    ? (patternValue.filter((p): p is string => typeof p === 'string') as string[])
    : typeof patternValue === 'string'
      ? patternValue
      : undefined;
  const title =
    typeof source.title === 'string' && source.title.trim().length > 0
      ? source.title
      : [permissionName, Array.isArray(patterns) ? patterns.join(', ') : patterns]
          .filter(Boolean)
          .join(' ') || 'Permission required';
  const createdAt =
    source.time &&
    typeof source.time === 'object' &&
    typeof (source.time as { created?: unknown }).created === 'number'
      ? (source.time as { created: number }).created
      : Date.now();

  return {
    id,
    type: permissionName,
    pattern: patterns,
    sessionID,
    messageID:
      typeof source.messageID === 'string'
        ? source.messageID
        : typeof tool?.messageID === 'string'
          ? tool.messageID
          : '',
    callID:
      typeof source.callID === 'string'
        ? source.callID
        : typeof tool?.callID === 'string'
          ? tool.callID
          : undefined,
    title,
    metadata: (source.metadata as { [key: string]: unknown } | undefined) || {},
    time: { created: createdAt },
  };
}
