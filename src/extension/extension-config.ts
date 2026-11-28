import * as vscode from 'vscode';
import type { ExtensionConfigState } from '../shared/provider-limit-config';
import {
  DEFAULT_PROMPT_CACHE_WARNING_TOKENS,
  DEFAULT_RESET_WARNING_DAYS,
} from '../shared/provider-limit-config';
import {
  isPermissionMode,
  type DesktopSessionPaneSide,
  type PermissionMode,
} from '../shared/protocol';
import { isNumber, isString } from '../shared/type-utils';
import { parseRemoteImageMode } from '../shared/remote-images';
import { readRenamedString } from './renamed-settings';

const DEFAULT_CHAT_FONT_SIZE = 13;
const DEFAULT_CHAT_EDITOR_FONT_SIZE = 12;
const DEFAULT_CHAT_FONT_FAMILY = 'default';
// These mirror the contributed defaults in package.json.
const DEFAULT_DESKTOP_SESSION_PANE_SIDE: DesktopSessionPaneSide = 'right';
const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';
/** Least to most permissive. */
const PERMISSION_MODE_RANK: Record<PermissionMode, number> = { default: 0, auto: 1, full: 2 };

export function readExtensionConfigState(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro'),
  chatConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('chat')
): ExtensionConfigState {
  return {
    showFileDiffs: config.get<boolean>('chat.showFileDiffs', false),
    expandThinking: config.get<boolean>('chat.expandThinking', false),
    showChangedFiles: config.get<boolean>('chat.showChangedFiles', false),
    showTurnTimer: config.get<boolean>('chat.showTurnTimer', true),
    groupComposerBlocks: config.get<boolean>('chat.tabbedPanels', true),
    // Never let a repository opt the user into network requests through workspace settings.
    remoteImages: parseRemoteImageMode(config.inspect?.('chat.remoteImages')?.globalValue),
    promptCompletionModel: readPromptCompletionModel(config),
    followupsEnabled: readFollowupsEnabled(config),
    followupModel: readFollowupModel(config),
    debugShowQuotaWarning: config.get<boolean>('debug.showQuotaWarning', false),
    debugResetWarningDays: readResetWarningDays(config),
    promptCacheWarningTokens: readPromptCacheWarningTokens(config),
    autoAttachProblems: config.get<boolean>('chat.autoAttachProblems', false),
    autoAttachActiveFile: config.get<boolean>('chat.autoAttachActiveFile', true),
    desktopSessionPaneSide: readDesktopSessionPaneSide(config),
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
  return config.inspect?.<unknown>('followups.enabled')?.globalValue !== false;
}

export function readFollowupModel(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
): string {
  const value = config.inspect?.<unknown>('followups.model')?.globalValue;
  return isString(value) ? value.trim() : '';
}

export function readPromptCompletionModel(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
): string {
  const value = config.get<unknown>('promptCompletion.model');
  return isString(value) ? value : '';
}

/** Session attribution is an explicit user opt-in, never a repository preference. */
export function readPromptTrace(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
): boolean {
  return config.inspect?.<unknown>('promptTracing.enabled')?.globalValue === true;
}

export type PermissionGuidanceSetting =
  | { mode: 'default' }
  | { mode: 'off' }
  | { mode: 'custom'; text: string };

/** Guidance is injected into system prompts, so repository settings must never supply or remove it. */
export function readPermissionGuidance(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
): PermissionGuidanceSetting {
  const mode = config.inspect?.<unknown>('permissions.onReject')?.globalValue;
  if (mode === 'off') return { mode: 'off' };
  if (mode !== 'custom') return { mode: 'default' };
  const text = config.inspect?.<unknown>('permissions.onRejectCustom')?.globalValue;
  return isString(text) && text.trim()
    ? { mode: 'custom', text: text.trim() }
    : { mode: 'default' };
}

function readResetWarningDays(config: vscode.WorkspaceConfiguration): number {
  const value = config.get<unknown>('debug.resetWarningDays');
  return isNumber(value) && Number.isFinite(value) && value >= DEFAULT_RESET_WARNING_DAYS
    ? value
    : DEFAULT_RESET_WARNING_DAYS;
}

function readPromptCacheWarningTokens(config: vscode.WorkspaceConfiguration): number {
  const value = config.get<unknown>('chat.cacheWarningTokens');
  return isNumber(value) && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : DEFAULT_PROMPT_CACHE_WARNING_TOKENS;
}

function readDesktopSessionPaneSide(config: vscode.WorkspaceConfiguration): DesktopSessionPaneSide {
  const value = config.get<unknown>('chat.sessionsPaneSide');
  return value === 'left' || value === 'right' ? value : DEFAULT_DESKTOP_SESSION_PANE_SIDE;
}

/** A repository may start new chats in a stricter mode than the user's, never a more permissive one. */
function readDefaultPermissionMode(config: vscode.WorkspaceConfiguration): PermissionMode {
  const setting = config.inspect?.<unknown>('permissions.defaultMode');
  const user = isPermissionMode(setting?.globalValue)
    ? setting.globalValue
    : DEFAULT_PERMISSION_MODE;
  const workspace = setting?.workspaceFolderValue ?? setting?.workspaceValue;
  return isPermissionMode(workspace) && PERMISSION_MODE_RANK[workspace] < PERMISSION_MODE_RANK[user]
    ? workspace
    : user;
}

/** An executable path comes from user or remote settings, never from a repository's settings. */
export function readServerCommand(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
): string {
  const value = config.inspect?.<unknown>('server.command')?.globalValue;
  return isString(value) ? value : '';
}

/** Whether workspace or folder settings carry a `varro.server.command` that Varro ignores. */
export function hasIgnoredWorkspaceServerCommand(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
): boolean {
  const setting = config.inspect?.<unknown>('server.command');
  return [setting?.workspaceFolderValue, setting?.workspaceValue].some(
    (value) => isString(value) && value.trim() !== ''
  );
}

export function readAutoApproveModel(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
): string {
  return readRenamedString('permissions.approveModel', config) ?? '';
}

export function readAutoApproveDecisionModel(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
): string {
  const value = config.inspect?.<unknown>('permissions.decisionModel')?.globalValue;
  return isString(value) ? value : '';
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
