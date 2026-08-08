import * as vscode from 'vscode';
import type { ExtensionConfigState } from '../shared/provider-limit-config';
import { isPermissionMode } from '../shared/protocol';

export function readExtensionConfigState(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
): ExtensionConfigState {
  return {
    showInlineFileChanges: config.get<boolean>('chat.showInlineFileChanges', false),
    showChangedFiles: config.get<boolean>('chat.showChangedFiles', false),
    desktopSessionPaneSide: config.get<'left' | 'right'>('chat.desktopSessionPaneSide', 'left'),
    defaultPermissionMode: readDefaultPermissionMode(config),
  };
}

function readDefaultPermissionMode(config: vscode.WorkspaceConfiguration) {
  const value = config.get<unknown>('chat.defaultPermissionMode');
  return isPermissionMode(value) ? value : 'default';
}
