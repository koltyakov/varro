import type { DesktopSessionPaneSide, InitialWebviewState, PermissionMode } from './protocol';

export const DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS = 120;
export const DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS = -1;
export const DEFAULT_PROVIDER_LIMIT_THRESHOLD_PERCENT = 100;

export type ExtensionConfigState = {
  expandThinkingByDefault: boolean;
  showStickyUserPrompt: boolean;
  showInlineFileChanges?: boolean;
  showChangedFiles?: boolean;
  desktopSessionPaneSide: DesktopSessionPaneSide;
  defaultPermissionMode: PermissionMode;
  providerLimitPollIntervalSeconds: number;
  providerLimitThresholdPercent: number;
};

export type WebviewConfigUpdatePayload = Pick<
  ExtensionConfigState,
  | 'expandThinkingByDefault'
  | 'showStickyUserPrompt'
  | 'showInlineFileChanges'
  | 'showChangedFiles'
  | 'desktopSessionPaneSide'
  | 'defaultPermissionMode'
>;

export function resolveProviderLimitPollIntervalSeconds(disabled: boolean) {
  return disabled
    ? DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS
    : DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS;
}

export function normalizeProviderLimitThresholdPercent(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : DEFAULT_PROVIDER_LIMIT_THRESHOLD_PERCENT;
}

export function readProviderLimitPollIntervalSeconds(
  initialWebviewState: Partial<InitialWebviewState>
) {
  return resolveProviderLimitPollIntervalSeconds(
    initialWebviewState.providerLimitsDisabled === true ||
      initialWebviewState.providerLimitPollIntervalSeconds ===
        DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS
  );
}

export function readProviderLimitThresholdPercent(
  initialWebviewState: Partial<InitialWebviewState>
) {
  return normalizeProviderLimitThresholdPercent(initialWebviewState.providerLimitThresholdPercent);
}
