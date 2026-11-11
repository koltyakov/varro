import * as vscode from 'vscode';
import type { ExtensionConfigState } from '../shared/provider-limit-config';
import { DEFAULT_RESET_WARNING_DAYS } from '../shared/provider-limit-config';
import { isPermissionMode } from '../shared/protocol';
import { isNumber, isString } from '../shared/type-utils';
import { parseRemoteImageMode } from '../shared/remote-images';

const DEFAULT_CHAT_FONT_SIZE = 13;
const DEFAULT_CHAT_EDITOR_FONT_SIZE = 12;
const DEFAULT_CHAT_FONT_FAMILY = 'default';

export function readExtensionConfigState(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro'),
  chatConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('chat')
): ExtensionConfigState {
  return {
    showFileDiffs: config.get<boolean>('chat.showFileDiffs', false),
    expandThinking: config.get<boolean>('chat.expandThinking', false),
    showChangedFiles: config.get<boolean>('chat.showChangedFiles', false),
    showTurnTimer: config.get<boolean>('chat.showTurnTimer', true),
    showEmptyStateHistogram: config.get<boolean>('chat.showEmptyStateHistogram', false),
    // Never let a repository opt the user into network requests through workspace settings.
    remoteImages: parseRemoteImageMode(config.inspect?.('chat.remoteImages')?.globalValue),
    promptCompletionModel: config.get<string>('chat.promptCompletionModel', ''),
    followupsEnabled: readFollowupsEnabled(config),
    followupModel: readFollowupModel(config),
    debugShowQuotaWarning: config.get<boolean>('debug.showQuotaWarning', false),
    debugResetWarningDays: readResetWarningDays(config),
    autoAttachProblems: config.get<boolean>('chat.autoAttachProblems', true),
    autoAttachActiveFile: config.get<boolean>('chat.autoAttachActiveFile', true),
    desktopSessionPaneSide: config.get<'left' | 'right'>('chat.desktopSessionPaneSide', 'left'),
    defaultPermissionMode: readDefaultPermissionMode(config),
    chatFontSize: readChatFontSize(config, chatConfig),
    chatEditorFontSize: readFontSize(
      vscode.workspace.getConfiguration('chat.editor').get<unknown>('fontSize'),
      DEFAULT_CHAT_EDITOR_FONT_SIZE
    ),
    chatFontFamily: readChatFontFamily(chatConfig),
  };
}

/** Repository settings must not override the user's follow-up preferences. */
export function readFollowupsEnabled(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
): boolean {
  return config.inspect?.<boolean>('chat.followupsEnabled')?.globalValue !== false;
}

export function readFollowupModel(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
): string {
  const value = config.inspect?.<string>('chat.followupModel')?.globalValue;
  return isString(value) ? value.trim() : '';
}

/** Session attribution is an explicit user opt-in, never a repository preference. */
export function readFollowupTrace(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
): boolean {
  return config.inspect?.<boolean>('chat.followupTrace')?.globalValue === true;
}

function readResetWarningDays(config: vscode.WorkspaceConfiguration): number {
  const value = config.get<unknown>('debug.resetWarningDays');
  return isNumber(value) && Number.isFinite(value) && value >= DEFAULT_RESET_WARNING_DAYS
    ? value
    : DEFAULT_RESET_WARNING_DAYS;
}

function readDefaultPermissionMode(config: vscode.WorkspaceConfiguration) {
  const value = config.get<unknown>('chat.defaultPermissionMode');
  return isPermissionMode(value) ? value : 'default';
}

function readChatFontSize(
  config: vscode.WorkspaceConfiguration,
  chatConfig: vscode.WorkspaceConfiguration
): number {
  const override = config.get<unknown>('chat.fontSize');
  if (isNumber(override) && Number.isFinite(override) && override >= 6 && override <= 100) {
    return override;
  }

  const value = chatConfig.get<unknown>('fontSize', DEFAULT_CHAT_FONT_SIZE);
  return readFontSize(value, DEFAULT_CHAT_FONT_SIZE);
}

function readFontSize<T>(value: T, fallback: number): number {
  return isNumber(value) && Number.isFinite(value) && value >= 6 && value <= 100 ? value : fallback;
}

function readChatFontFamily(config: vscode.WorkspaceConfiguration): string {
  const value = config.get<unknown>('fontFamily', DEFAULT_CHAT_FONT_FAMILY);
  return isString(value) ? value : DEFAULT_CHAT_FONT_FAMILY;
}
