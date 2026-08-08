import type { DesktopSessionPaneSide, PermissionMode } from './protocol';

export const DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS = 120;

export type ExtensionConfigState = {
  showInlineFileChanges?: boolean;
  showChangedFiles?: boolean;
  desktopSessionPaneSide: DesktopSessionPaneSide;
  defaultPermissionMode: PermissionMode;
};

export type WebviewConfigUpdatePayload = Pick<
  ExtensionConfigState,
  'showInlineFileChanges' | 'showChangedFiles' | 'desktopSessionPaneSide' | 'defaultPermissionMode'
>;
