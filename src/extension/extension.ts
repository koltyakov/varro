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
  const simulateMissingCli = config.get<boolean>('debug.simulateMissingCli', false);
  const simulateNoProviders = config.get<boolean>('debug.simulateNoProviders', false);

  server = new OpenCodeServer(port, autoStart, command, simulateMissingCli);
  contextProvider = new ContextProvider((ctx) => {
    sidebarProvider?.post({ type: 'context/update', payload: ctx });
  });

  sidebarProvider = new SidebarProvider(
    context.extensionUri,
    context.workspaceState,
    contextProvider,
    server,
    simulateNoProviders
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  registerCommands(context, sidebarProvider!, contextProvider!, server!);

  vscode.commands.executeCommand('setContext', 'varro:activated', true);
  logger.info('Varro extension activated; server startup is deferred until first use');
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
  await disposeSafe(() => server?.disconnect(), 'server disconnect');
  server = null;
  contextProvider = null;
  sidebarProvider = null;
  try {
    vscode.commands.executeCommand('setContext', 'varro:activated', false);
  } catch {}
  logger.info('Varro extension deactivated');
  logger.dispose();
}
