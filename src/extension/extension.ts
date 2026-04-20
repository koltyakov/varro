import * as vscode from 'vscode';
import { OpenCodeServer } from './server';
import { SidebarProvider } from './sidebar-provider';
import { ContextProvider } from './context-provider';
import { registerCommands } from './commands';
import { logger } from './logger';

let server: OpenCodeServer;
let contextProvider: ContextProvider;
let sidebarProvider: SidebarProvider;

export async function activate(context: vscode.ExtensionContext) {
  logger.info('Activating Varro extension');

  const config = vscode.workspace.getConfiguration('varro');
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

  registerCommands(context, sidebarProvider, contextProvider);

  vscode.commands.executeCommand('setContext', 'varro:activated', true);
  logger.info('Varro extension activated');

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
  vscode.commands.executeCommand('setContext', 'varro:activated', false);
  logger.info('Varro extension deactivated');
}
