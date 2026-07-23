import * as vscode from 'vscode';
import type { ExtensionConfigState } from '../shared/provider-limit-config';
import { isPermissionMode } from '../shared/protocol';
import {
  DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS,
  normalizeProviderLimitThresholdPercent,
  resolveProviderLimitPollIntervalSeconds,
} from '../shared/provider-limit-config';

const DEFAULT_ENABLED_PROVIDER_LIMIT_ADAPTERS = [
  'anthropic',
  'github-copilot',
  'openrouter',
  'zai',
  'minimax',
  'openai',
] as const;

export function readProviderLimitConfig(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
) {
  const rawEnabledAdapters = config.get<unknown>('providerLimits.enabledAdapters');
  const enabledAdapters = Array.isArray(rawEnabledAdapters)
    ? rawEnabledAdapters.filter(isNonEmptyString)
    : [...DEFAULT_ENABLED_PROVIDER_LIMIT_ADAPTERS];

  return {
    enabledAdapters: new Set(enabledAdapters),
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
    showStickyUserPrompt: config.get<boolean>('chat.showStickyUserPrompt', true),
    showInlineFileChanges: config.get<boolean>('chat.showInlineFileChanges', false),
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
