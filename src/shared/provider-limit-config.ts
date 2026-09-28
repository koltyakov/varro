import type { DesktopSessionPaneSide, PermissionMode } from './protocol';

export const DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS = 120;
export const DEFAULT_RESET_WARNING_DAYS = 5;

export type ExtensionConfigState = {
  showFileDiffs?: boolean;
  expandThinking?: boolean;
  showChangedFiles?: boolean;
  showTurnTimer?: boolean;
  debugShowQuotaWarning?: boolean;
  debugResetWarningDays?: number;
  enableProblemsContext?: boolean;
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
  | 'debugShowQuotaWarning'
  | 'debugResetWarningDays'
  | 'enableProblemsContext'
  | 'desktopSessionPaneSide'
  | 'defaultPermissionMode'
>;

export type ExtensionConfigSnapshot = WebviewConfigUpdatePayload &
  Pick<ExtensionConfigState, 'chatFontSize' | 'chatEditorFontSize' | 'chatFontFamily'>;
