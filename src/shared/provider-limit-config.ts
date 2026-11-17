import type { DesktopSessionPaneSide, PermissionMode } from './protocol';
import type { RemoteImageMode } from './remote-images';

export const DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS = 120;
export const PROVIDER_LIMIT_STALE_RETENTION_MS = 15 * 60_000;
export const DEFAULT_RESET_WARNING_DAYS = 5;

export type ExtensionConfigState = {
  showFileDiffs?: boolean;
  expandThinking?: boolean;
  showChangedFiles?: boolean;
  showTurnTimer?: boolean;
  showEmptyStateHistogram?: boolean;
  remoteImages?: RemoteImageMode;
  promptCompletionModel?: string;
  followupsEnabled?: boolean;
  followupModel?: string;
  debugShowQuotaWarning?: boolean;
  debugResetWarningDays?: number;
  autoAttachProblems?: boolean;
  autoAttachActiveFile?: boolean;
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
  | 'showEmptyStateHistogram'
  | 'promptCompletionModel'
  | 'followupsEnabled'
  | 'followupModel'
  | 'debugShowQuotaWarning'
  | 'debugResetWarningDays'
  | 'autoAttachProblems'
  | 'autoAttachActiveFile'
  | 'desktopSessionPaneSide'
  | 'defaultPermissionMode'
>;

export type ExtensionConfigSnapshot = WebviewConfigUpdatePayload &
  Pick<
    ExtensionConfigState,
    'chatFontSize' | 'chatEditorFontSize' | 'chatFontFamily' | 'remoteImages'
  >;
