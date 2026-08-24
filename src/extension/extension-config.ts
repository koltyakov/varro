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
    showInlineFileChanges: config.get<boolean>('chat.showInlineFileChanges', false),
    showChangedFiles: config.get<boolean>('chat.showChangedFiles', false),
    desktopSessionPaneSide: config.get<'left' | 'right'>('chat.desktopSessionPaneSide', 'left'),
    defaultPermissionMode: readDefaultPermissionMode(config),
    chatFontSize: readChatFontSize(chatConfig),
    chatFontFamily: readChatFontFamily(chatConfig),
  };
}

function readDefaultPermissionMode(config: vscode.WorkspaceConfiguration) {
  const value = config.get<unknown>('chat.defaultPermissionMode');
  return isPermissionMode(value) ? value : 'default';
}

function readChatFontSize(config: vscode.WorkspaceConfiguration): number {
  const value = config.get<unknown>('fontSize', DEFAULT_CHAT_FONT_SIZE);
  return isNumber(value) && Number.isFinite(value) && value >= 6 && value <= 100
    ? value
    : DEFAULT_CHAT_FONT_SIZE;
}

function readChatFontFamily(config: vscode.WorkspaceConfiguration): string {
  const value = config.get<unknown>('fontFamily', DEFAULT_CHAT_FONT_FAMILY);
  return isString(value) ? value : DEFAULT_CHAT_FONT_FAMILY;
}
