import * as vscode from 'vscode';
import { getSelectionRangesFromEditorContext } from '../shared/context-files';
import type { SidebarProvider } from './sidebar-provider';
import type { ContextProvider } from './context-provider';
import type { OpenCodeServer } from './server';
import { getRelativePath } from './util/path';
import { logger } from './logger';

export function registerCommands(
  context: vscode.ExtensionContext,
  sidebar: SidebarProvider,
  contextProvider: ContextProvider,
  server: OpenCodeServer
) {
  context.subscriptions.push(
    vscode.commands.registerCommand('varro.chat.focus', async () => {
      try {
        await captureTerminalSelectionForContext(sidebar, contextProvider, { silent: true });
        await vscode.commands.executeCommand('workbench.view.extension.varro');
        sidebar.requestInputFocus();
      } catch (err) {
        logger.error(`varro.chat.focus: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand('varro.chat.newSession', () => {
      sidebar.postCommand('new-session');
    }),

    vscode.commands.registerCommand('varro.chat.abort', () => {
      sidebar.postCommand('abort');
    }),

    vscode.commands.registerCommand('varro.server.restart', async () => {
      try {
        await server.dispose();
        server
          .start()
          .then((url) => {
            logger.info(`OpenCode server restarted at ${url}`);
          })
          .catch((err) => {
            const message = `Failed to restart server: ${err instanceof Error ? err.message : String(err)}`;
            logger.error(message);
            if (server.status.state !== 'error') {
              vscode.window.showErrorMessage(message);
            }
          });
      } catch (err) {
        logger.error(`varro.server.restart: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand('varro.chat.addTerminalSelectionToContext', async () => {
      try {
        const ok = await captureTerminalSelectionForContext(sidebar, contextProvider);
        if (!ok) {
          return;
        }
        vscode.commands.executeCommand('workbench.view.extension.varro');
      } catch (err) {
        logger.error(
          `varro.chat.addTerminalSelectionToContext: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('varro.chat.addSelectionToContext', async () => {
      try {
        const selectionTarget = await getEditorSelectionTarget();
        if (!selectionTarget) return;
        sidebar.postDroppedFiles([selectionTarget]);
        vscode.commands.executeCommand('workbench.view.extension.varro');
      } catch (err) {
        logger.error(
          `varro.chat.addSelectionToContext: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand(
      'varro.chat.addToContext',
      async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        try {
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
                const relativePath = getRelativePath(target, workspaceFolder);
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
            (f): f is { path: string; relativePath: string; type: 'file' | 'directory' } =>
              f !== null
          );
          if (valid.length > 0) {
            sidebar.postDroppedFiles(valid);
            vscode.commands.executeCommand('workbench.view.extension.varro');
          }
        } catch (err) {
          logger.error(
            `varro.chat.addToContext: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    )
  );
}

async function getEditorSelectionTarget() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return null;

  const document = editor.document;
  if (document.isUntitled || document.uri.scheme === 'untitled') return null;

  try {
    const stat = await vscode.workspace.fs.stat(document.uri);
    if (stat.type & vscode.FileType.Directory) return null;

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    return {
      path: document.uri.fsPath,
      relativePath: getRelativePath(document.uri, workspaceFolder),
      type: 'file' as const,
      lineRanges: getSelectionRangesFromEditorContext({
        startLine: editor.selection.start.line + 1,
        endLine: editor.selection.end.line + 1,
      }),
    };
  } catch {
    return null;
  }
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
      vscode.window.showWarningMessage(`Varro: ${message}`);
    }
    return false;
  }

  sidebar.postTerminalSelection(contextProvider.terminalSelection);
  return true;
}
