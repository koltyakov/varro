import * as vscode from 'vscode';

export function createSidebarProviderHostBindings(callbacks: {
  updateStatusBarItem(): void;
  postConfigState(): void;
}) {
  const windowStateDisposable = vscode.window.onDidChangeWindowState(() => {
    callbacks.updateStatusBarItem();
  });

  const configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration('varro.chat.expandThinkingByDefault') ||
      event.affectsConfiguration('varro.chat.showStickyUserPrompt') ||
      event.affectsConfiguration('varro.chat.desktopSessionPaneSide')
    ) {
      callbacks.postConfigState();
    }
  });

  return { windowStateDisposable, configDisposable };
}
