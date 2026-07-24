import * as vscode from 'vscode';
import type { ExtensionConfigState } from '../shared/provider-limit-config';
import { isPermissionMode } from '../shared/protocol';
import {
  DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS,
  normalizeProviderLimitThresholdPercent,
  resolveProviderLimitPollIntervalSeconds,
} from '../shared/provider-limit-config';

export function readProviderLimitConfig(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
) {
  return {
    pollIntervalSeconds: resolveProviderLimitPollIntervalSeconds(
      config.get<boolean>('providerLimits.disabled') === true ||
        config.get<number>('providerLimits.pollIntervalSeconds') ===
          DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS
    ),
    thresholdPercent: normalizeProviderLimitThresholdPercent(
      config.get<number>('providerLimits.thresholdPercent')
    ),
  };
}

export function readExtensionConfigState(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
): ExtensionConfigState {
  const providerLimitConfig = readProviderLimitConfig(config);

  return {
    expandThinkingByDefault: config.get<boolean>('chat.expandThinkingByDefault') ?? false,
    showInlineFileChanges: config.get<boolean>('chat.showInlineFileChanges', false),
    showChangedFiles: config.get<boolean>('chat.showChangedFiles', false),
    desktopSessionPaneSide: config.get<'left' | 'right'>('chat.desktopSessionPaneSide', 'left'),
    defaultPermissionMode: readDefaultPermissionMode(config),
    providerLimitPollIntervalSeconds: providerLimitConfig.pollIntervalSeconds,
    providerLimitThresholdPercent: providerLimitConfig.thresholdPercent,
  };
}

function readDefaultPermissionMode(config: vscode.WorkspaceConfiguration) {
  const value = config.get<unknown>('chat.defaultPermissionMode');
  return isPermissionMode(value) ? value : 'default';
}
