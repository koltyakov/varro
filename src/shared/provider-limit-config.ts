import type { DesktopSessionPaneSide, PermissionMode } from './protocol';

export const DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS = 120;

export type ResponseTimestampPlacement = 'turn-end' | 'each-step';

export type ChatFontFamily = 'default' | 'editor' | 'sans' | 'mono' | 'serif';

export function isResponseTimestampPlacement<T>(
  value: T
): value is T & ResponseTimestampPlacement {
  return value === 'turn-end' || value === 'each-step';
}

export function isChatFontFamily<T>(value: T): value is T & ChatFontFamily {
  return (
    value === 'default' || value === 'editor' || value === 'sans' || value === 'mono' || value === 'serif'
  );
}

export type ExtensionConfigState = {
  showInlineFileChanges?: boolean;
  showChangedFiles?: boolean;
  desktopSessionPaneSide: DesktopSessionPaneSide;
  defaultPermissionMode: PermissionMode;
  chatFontSize?: number;
  chatFontFamily?: ChatFontFamily;
  showRequestTimestamps?: boolean;
  showResponseTimestamps?: boolean;
  responseTimestamp?: ResponseTimestampPlacement;
};

export type WebviewConfigUpdatePayload = Pick<
  ExtensionConfigState,
  | 'showInlineFileChanges'
  | 'showChangedFiles'
  | 'desktopSessionPaneSide'
  | 'defaultPermissionMode'
  | 'chatFontSize'
  | 'chatFontFamily'
  | 'showRequestTimestamps'
  | 'showResponseTimestamps'
  | 'responseTimestamp'
>;
