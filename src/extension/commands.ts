import * as vscode from 'vscode';
import { basename } from 'path';
import type { SidebarProvider } from './sidebar-provider';
import type { ContextProvider } from './context-provider';

export function registerCommands(
  context: vscode.ExtensionContext,
  sidebar: SidebarProvider,
  contextProvider: ContextProvider
) {
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode.chat.focus', async () => {
      await captureTerminalSelectionForContext(sidebar, contextProvider, { silent: true });
      await vscode.commands.executeCommand('workbench.view.extension.opencode');
      sidebar.requestInputFocus();
    }),

    vscode.commands.registerCommand('opencode.chat.newSession', () => {
      sidebar.postCommand('new-session');
    }),

    vscode.commands.registerCommand('opencode.chat.abort', () => {
      sidebar.postCommand('abort');
    }),

    vscode.commands.registerCommand('opencode.chat.addTerminalSelectionToContext', async () => {
      const ok = await captureTerminalSelectionForContext(sidebar, contextProvider);
      if (!ok) {
        return;
      }
      vscode.commands.executeCommand('workbench.view.extension.opencode');
    }),

    vscode.commands.registerCommand(
      'opencode.chat.addToContext',
      async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const targets = uris && uris.length > 0 ? uris : uri ? [uri] : [];

        if (targets.length === 0) {
          const editor = vscode.window.activeTextEditor;
          if (!editor) return;
          targets.push(editor.document.uri);
        }

        const files = await Promise.all(
          targets.map(async (target) => {
            try {
              const stat = await vscode.workspace.fs.stat(target);
              const workspaceFolder = vscode.workspace.getWorkspaceFolder(target);
              const relativePath = getDroppedRelativePath(target, workspaceFolder);
              return {
                path: target.fsPath,
                relativePath,
                type:
                  stat.type & vscode.FileType.Directory
                    ? ('directory' as const)
                    : ('file' as const),
              };
            } catch {
              return null;
            }
          })
        );

        const valid = files.filter(
          (f): f is { path: string; relativePath: string; type: 'file' | 'directory' } => f !== null
        );
        if (valid.length > 0) {
          sidebar.postDroppedFiles(valid);
          vscode.commands.executeCommand('workbench.view.extension.opencode');
        }
      }
    )
  );
}

async function captureTerminalSelectionForContext(
  sidebar: SidebarProvider,
  contextProvider: ContextProvider,
  options?: { silent?: boolean }
) {
  const result = await contextProvider.captureTerminalSelection();
  if (!result.ok) {
    if (!options?.silent) {
      const message =
        result.reason === 'no-terminal'
          ? 'Open and focus a terminal first.'
          : 'Select text in the terminal first.';
      vscode.window.showWarningMessage(`OpenCode: ${message}`);
    }
    return false;
  }

  sidebar.postTerminalSelection(contextProvider.terminalSelection);
  return true;
}

function getDroppedRelativePath(
  uri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder | undefined
) {
  if (!workspaceFolder) return basename(uri.fsPath);

  const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  return relativePath || '.';
}
