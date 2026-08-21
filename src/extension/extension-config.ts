import * as vscode from 'vscode';
import {
  type ExtensionConfigState,
  isChatFontFamily,
  isResponseTimestampPlacement,
} from '../shared/provider-limit-config';
import { isPermissionMode } from '../shared/protocol';
import { isBoolean } from '../shared/type-utils';

export function readExtensionConfigState(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
): ExtensionConfigState {
  return {
    showInlineFileChanges: config.get<boolean>('chat.showInlineFileChanges', false),
    showChangedFiles: config.get<boolean>('chat.showChangedFiles', false),
    desktopSessionPaneSide: config.get<'left' | 'right'>('chat.desktopSessionPaneSide', 'left'),
    defaultPermissionMode: readDefaultPermissionMode(config),
    chatFontSize: readChatFontSize(config),
    chatFontFamily: readChatFontFamily(config),
    showRequestTimestamps: readBoolean(config, 'chat.showRequestTimestamps', true),
    showResponseTimestamps: readBoolean(config, 'chat.showResponseTimestamps', true),
    responseTimestamp: readResponseTimestamp(config),
  };
}

function readDefaultPermissionMode(config: vscode.WorkspaceConfiguration) {
  const value = config.get<unknown>('chat.defaultPermissionMode');
  return isPermissionMode(value) ? value : 'default';
}

function readChatFontSize(config: vscode.WorkspaceConfiguration): number | undefined {
  const value = config.get<number>('chat.fontSize');
  const rounded = Math.round(value ?? 0);
  return rounded > 0 ? rounded : undefined;
}

function readBoolean(
  config: vscode.WorkspaceConfiguration,
  key: string,
  fallback: boolean
): boolean {
  const value = config.get<unknown>(key);
  return isBoolean(value) ? value : fallback;
}

function readChatFontFamily(config: vscode.WorkspaceConfiguration) {
  const value = config.get<unknown>('chat.fontFamily');
  return isChatFontFamily(value) ? value : 'default';
}

function readResponseTimestamp(config: vscode.WorkspaceConfiguration) {
  const value = config.get<unknown>('chat.responseTimestamp');
  return isResponseTimestampPlacement(value) ? value : 'turn-end';
}
