import * as vscode from 'vscode';
import type { ExtensionConfigState } from '../shared/provider-limit-config';
import { isPermissionMode } from '../shared/protocol';
import { isNumber, isString } from '../shared/type-utils';

const DEFAULT_CHAT_FONT_SIZE = 13;
const DEFAULT_CHAT_FONT_FAMILY = 'default';

export function readExtensionConfigState(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro'),
  chatConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('chat')
): ExtensionConfigState {
  return {
    showFileDiffs: config.get<boolean>('chat.showFileDiffs', false),
    expandThinking: config.get<boolean>('chat.expandThinking', false),
    showChangedFiles: config.get<boolean>('chat.showChangedFiles', false),
    desktopSessionPaneSide: config.get<'left' | 'right'>('chat.desktopSessionPaneSide', 'left'),
    defaultPermissionMode: readDefaultPermissionMode(config),
    chatFontSize: readChatFontSize(config, chatConfig),
    chatFontFamily: readChatFontFamily(chatConfig),
  };
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
  return isNumber(value) && Number.isFinite(value) && value >= 6 && value <= 100
    ? value
    : DEFAULT_CHAT_FONT_SIZE;
}

function readChatFontFamily(config: vscode.WorkspaceConfiguration): string {
  const value = config.get<unknown>('fontFamily', DEFAULT_CHAT_FONT_FAMILY);
  return isString(value) ? value : DEFAULT_CHAT_FONT_FAMILY;
}
