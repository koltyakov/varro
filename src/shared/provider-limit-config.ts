import type { DesktopSessionPaneSide, PermissionMode } from './protocol';

export const DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS = 120;

export type ExtensionConfigState = {
  showFileDiffs?: boolean;
  expandThinking?: boolean;
  showChangedFiles?: boolean;
  showTurnTimer?: boolean;
  desktopSessionPaneSide: DesktopSessionPaneSide;
  defaultPermissionMode: PermissionMode;
  chatFontSize: number;
  chatEditorFontSize: number;
  chatFontFamily: string;
};

export type WebviewConfigUpdatePayload = Pick<
  ExtensionConfigState,
  | 'showFileDiffs'
  | 'expandThinking'
  | 'showChangedFiles'
  | 'showTurnTimer'
  | 'desktopSessionPaneSide'
  | 'defaultPermissionMode'
>;

export type ExtensionConfigSnapshot = WebviewConfigUpdatePayload &
  Pick<ExtensionConfigState, 'chatFontSize' | 'chatEditorFontSize' | 'chatFontFamily'>;
