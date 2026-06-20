import * as vscode from 'vscode';
import { OpenCodeServer } from './server';
import { SidebarProvider } from './sidebar-provider';
import { ContextProvider } from './context-provider';
import { registerCommands } from './commands';
import { logger } from './logger';

const DEFAULT_AUTO_COMPACTION_RESERVED_TOKENS = 4096;

function readCompactionSettings(config: vscode.WorkspaceConfiguration) {
  const rawReserved = config.get<number | null>(
    'chat.autoCompactionReservedTokens',
    DEFAULT_AUTO_COMPACTION_RESERVED_TOKENS
  );
  return {
    auto: config.get<boolean>('chat.autoCompact', true),
    reserved:
      typeof rawReserved === 'number' && Number.isInteger(rawReserved) && rawReserved >= 0
        ? rawReserved
        : null,
  };
}

let server: OpenCodeServer | null = null;
let contextProvider: ContextProvider | null = null;
let sidebarProvider: SidebarProvider | null = null;

async function disposeSafe(fn: () => PromiseLike<void> | void, label: string) {
  try {
    await fn();
  } catch (err) {
    logger.error(`Error during ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  logger.info('Activating Varro extension');

  const config = vscode.workspace.getConfiguration('varro');
  const port = config.get<number>('server.port', 4096);
  const autoStart = config.get<boolean>('server.autoStart', true);
  const command = config.get<string>('server.command', '');
  const simulateMissingCli = config.get<boolean>('debug.simulateMissingCli', false);
  const simulateNoProviders = config.get<boolean>('debug.simulateNoProviders', false);
  const compactionSettings = readCompactionSettings(config);

  server = new OpenCodeServer(port, autoStart, command, simulateMissingCli, compactionSettings);
  contextProvider = new ContextProvider((ctx) => {
    sidebarProvider?.post({ type: 'context/update', payload: ctx });
  });

  sidebarProvider = new SidebarProvider(
    context.extensionUri,
    context.workspaceState,
    contextProvider,
    server,
    context.extension.id,
    simulateNoProviders
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('varro.chat.autoCompact') ||
        event.affectsConfiguration('varro.chat.autoCompactionReservedTokens')
      ) {
        const nextConfig = vscode.workspace.getConfiguration('varro');
        void server?.updateCompactionSettings(readCompactionSettings(nextConfig));
      }
    })
  );

  registerCommands(context, sidebarProvider!, contextProvider!, server!);

  vscode.commands.executeCommand('setContext', 'varro:activated', true);
  logger.info('Varro extension activated; server startup is deferred until the chat view is used');
}

export async function deactivate() {
  await disposeSafe(() => sidebarProvider?.dispose(), 'sidebarProvider dispose');
  await disposeSafe(() => contextProvider?.dispose(), 'contextProvider dispose');
  await disposeSafe(() => server?.disconnect(), 'server disconnect');
  server = null;
  contextProvider = null;
  sidebarProvider = null;
  await disposeSafe(
    () => vscode.commands.executeCommand('setContext', 'varro:activated', false),
    'setContext deactivate'
  );
  logger.info('Varro extension deactivated');
  logger.dispose();
}
