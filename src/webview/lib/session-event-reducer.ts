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
  if (isNormalizedPermission(props)) return props;
  const id =
    typeof props.id === 'string'
      ? props.id
      : typeof props.permissionID === 'string'
        ? props.permissionID
        : typeof props.requestID === 'string'
          ? props.requestID
          : null;
  const sessionID = typeof props.sessionID === 'string' ? props.sessionID : null;
  if (!id || !sessionID) return null;

  const tool = (props.tool as { messageID?: string; callID?: string } | undefined) || undefined;
  const permissionName = typeof props.permission === 'string' ? props.permission : '';
  const patterns = Array.isArray(props.patterns)
    ? (props.patterns.filter((p): p is string => typeof p === 'string') as string[])
    : undefined;
  const title = [permissionName, patterns ? patterns.join(', ') : ''].filter(Boolean).join(' ');

  return {
    id,
    type: permissionName,
    pattern: patterns,
    sessionID,
    messageID: typeof tool?.messageID === 'string' ? tool.messageID : '',
    callID: tool?.callID,
    title,
    metadata: (props.metadata as { [key: string]: unknown } | undefined) || {},
    time: { created: Date.now() / 1000 },
  };
}
