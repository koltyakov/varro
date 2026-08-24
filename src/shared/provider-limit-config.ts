import type { DesktopSessionPaneSide, PermissionMode } from './protocol';

export const DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS = 120;

export type ExtensionConfigState = {
  showInlineFileChanges?: boolean;
  showChangedFiles?: boolean;
  desktopSessionPaneSide: DesktopSessionPaneSide;
  defaultPermissionMode: PermissionMode;
  chatFontSize: number;
  chatFontFamily: string;
};

export type WebviewConfigUpdatePayload = Pick<
  ExtensionConfigState,
  'showInlineFileChanges' | 'showChangedFiles' | 'desktopSessionPaneSide' | 'defaultPermissionMode'
>;

export type ExtensionConfigSnapshot = WebviewConfigUpdatePayload &
  Pick<ExtensionConfigState, 'chatFontSize' | 'chatFontFamily'>;
