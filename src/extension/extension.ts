import * as vscode from 'vscode';
import { OpenCodeServer } from './server';
import { SidebarProvider } from './sidebar-provider';
import { ContextProvider } from './context-provider';
import { ContextTreeProvider, ContextDropController } from './context-tree';
import type { ContextFileItem } from './context-tree';
import { registerCommands } from './commands';
import { logger } from './logger';

let server: OpenCodeServer;
let contextProvider: ContextProvider;
let sidebarProvider: SidebarProvider;

export async function activate(context: vscode.ExtensionContext) {
  logger.info('Activating OpenCode extension');

  const config = vscode.workspace.getConfiguration('opencode');
  const port = config.get<number>('server.port', 4096);
  const autoStart = config.get<boolean>('server.autoStart', true);
  const command = config.get<string>('server.command', '');

  server = new OpenCodeServer(port, autoStart, command);
  contextProvider = new ContextProvider((ctx) => {
    sidebarProvider?.post({ type: 'context/update', payload: ctx });
  });

  sidebarProvider = new SidebarProvider(context.extensionUri, contextProvider, server);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  registerCommands(context, sidebarProvider);

  const contextTreeProvider = new ContextTreeProvider();
  sidebarProvider.setContextTreeProvider(contextTreeProvider);

  const contextDropController = new ContextDropController((paths) => {
    sidebarProvider.handleDroppedPaths(paths);
  });

  context.subscriptions.push(
    vscode.window.createTreeView('opencode.context', {
      treeDataProvider: contextTreeProvider,
      dragAndDropController: contextDropController,
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode.context.remove', (item: ContextFileItem) => {
      sidebarProvider.removeContextFile(item.path);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode.context.clearAll', () => {
      sidebarProvider.clearContextFiles();
    })
  );

  vscode.commands.executeCommand('setContext', 'opencode:activated', true);
  logger.info('OpenCode extension activated');

  server
    .start()
    .then((url) => {
      logger.info(`OpenCode server running at ${url}`);
    })
    .catch((err) => {
      logger.error(
        `Failed to start OpenCode server: ${err instanceof Error ? err.message : String(err)}`
      );
    });
}

export async function deactivate() {
  await server?.dispose();
  contextProvider?.dispose();
  sidebarProvider?.dispose();
  vscode.commands.executeCommand('setContext', 'opencode:activated', false);
  logger.info('OpenCode extension deactivated');
}
