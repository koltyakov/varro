import * as vscode from 'vscode';
import { OpenCodeServer } from './server';
import { SidebarProvider } from './sidebar-provider';
import { ContextProvider } from './context-provider';
import { registerCommands } from './commands';
import { logger } from './logger';

let server: OpenCodeServer | null = null;
let contextProvider: ContextProvider | null = null;
let sidebarProvider: SidebarProvider | null = null;

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

  registerCommands(context, sidebarProvider!, contextProvider!, server!);

  vscode.commands.executeCommand('setContext', 'varro:activated', true);
  logger.info('Varro extension activated');

  server
    .start()
    .then((url) => {
      logger.info(`OpenCode server running at ${url}`);
    })
    .catch((err) => {
      const message = `Failed to start OpenCode server: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(message);
      vscode.window.showErrorMessage(message);
    });
}

export async function deactivate() {
  const disposeSafe = async (fn: () => Promise<void> | void, label: string) => {
    try {
      await fn();
    } catch (err) {
      logger.error(`Error during ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await disposeSafe(() => sidebarProvider?.dispose(), 'sidebarProvider dispose');
  await disposeSafe(() => contextProvider?.dispose(), 'contextProvider dispose');
  await disposeSafe(() => server?.dispose(), 'server dispose');
  server = null;
  contextProvider = null;
  sidebarProvider = null;
  try {
    vscode.commands.executeCommand('setContext', 'varro:activated', false);
  } catch {}
  logger.info('Varro extension deactivated');
  logger.dispose();
}
