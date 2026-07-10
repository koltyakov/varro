import * as vscode from 'vscode';
import { OpenCodeServer } from './server';
import { SidebarProvider } from './sidebar-provider';
import { ContextProvider } from './context-provider';
import { registerCommands } from './commands';
import { logger } from './logger';
import { sweepStaleInjectedConfigDirectories } from './open-code-process';

const DEFAULT_AUTO_COMPACTION_RESERVED_TOKENS = 4096;
const CONTEXT_RESCOPE_RETRY_MS = 50;
const CONTEXT_RESTART_GRACE_MS = 3000;

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
let contextUpdateGeneration = 0;

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
    const generation = ++contextUpdateGeneration;
    void (async () => {
      let restartGraceDeadline = 0;
      for (;;) {
        if (generation !== contextUpdateGeneration) return;
        try {
          const result = await server?.rescopeEventStream(ctx.workspacePath || undefined);
          if (generation !== contextUpdateGeneration || result?.state === 'superseded') return;
          if (result?.state === 'cancelled') {
            restartGraceDeadline ||= Date.now() + CONTEXT_RESTART_GRACE_MS;
            await new Promise((resolve) => setTimeout(resolve, CONTEXT_RESCOPE_RETRY_MS));
            continue;
          }
          if (
            result?.state === 'inactive' &&
            restartGraceDeadline > 0 &&
            Date.now() < restartGraceDeadline
          ) {
            await new Promise((resolve) => setTimeout(resolve, CONTEXT_RESCOPE_RETRY_MS));
            continue;
          }
        } catch (err) {
          logger.warn(
            `Failed to rescope OpenCode event stream: ${err instanceof Error ? err.message : String(err)}`
          );
          return;
        }
        sidebarProvider?.post({ type: 'context/update', payload: ctx });
        return;
      }
    })();
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
  void sidebarProvider.initializeProviderFileSignature().catch((err) => {
    logger.warn(
      `Failed to initialize provider file observation: ${err instanceof Error ? err.message : String(err)}`
    );
  });
  void (async () => {
    try {
      await sweepStaleInjectedConfigDirectories();
    } catch (err) {
      logger.warn(
        `Failed to clean up stale temporary config directories: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  })();
  logger.info('Varro extension activated; server startup is deferred until the chat view is used');
}

export async function deactivate() {
  contextUpdateGeneration += 1;
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
