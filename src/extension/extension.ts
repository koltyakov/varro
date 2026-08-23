/* oxlint-disable anti-slop/no-runtime-typeof -- VS Code configuration values require runtime validation at activation. */
import * as vscode from 'vscode';
import { OpenCodeServer } from './server';
import { SidebarProvider } from './sidebar-provider';
import { ContextProvider } from './context-provider';
import { registerCommands } from './commands';
import { logger } from './logger';
import { sweepStaleInjectedConfigDirectories, validateServerPort } from './open-code-process';

const DEFAULT_AUTO_COMPACTION_RESERVED_TOKENS = 4096;
const CONTEXT_RESCOPE_RETRY_MS = 50;
const CONTEXT_RESTART_GRACE_MS = 3000;
const INITIAL_SIDEBAR_REVEAL_KEY = 'layout.initialSidebarReveal.v1';
const PRIMARY_SIDEBAR_MIGRATION_KEY = 'layout.cursorPrimarySidebar.v1';
const PRIMARY_SIDEBAR_CONTAINER = 'workbench.view.extension.varro-primary';
const SECONDARY_SIDEBAR_CONTAINER = 'workbench.view.extension.varro';
const PRIMARY_SIDEBAR_HOSTS = ['cursor', 'windsurf', 'devin'];

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

function usesPrimarySidebarForExtensions(): boolean {
  const appName = vscode.env.appName.toLowerCase();
  const uriScheme = vscode.env.uriScheme.toLowerCase();
  return PRIMARY_SIDEBAR_HOSTS.some(
    (host) =>
      appName === host ||
      appName.startsWith(`${host} `) ||
      uriScheme === host ||
      uriScheme.startsWith(`${host}-`)
  );
}

async function placeViewInPrimarySidebar(context: vscode.ExtensionContext): Promise<void> {
  if (!usesPrimarySidebarForExtensions()) return;
  if (context.globalState.get<boolean>(PRIMARY_SIDEBAR_MIGRATION_KEY)) {
    return;
  }

  try {
    const commandIds = await vscode.commands.getCommands();
    if (!commandIds.includes('vscode.moveViews')) {
      logger.warn(
        'The host does not expose the command required to move Varro to the Primary Sidebar'
      );
      return;
    }

    await vscode.commands.executeCommand('vscode.moveViews', {
      viewIds: [SidebarProvider.viewType],
      destinationId: PRIMARY_SIDEBAR_CONTAINER,
    });
  } catch (err) {
    logger.warn(
      `Failed to move Varro to the Primary Sidebar: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  try {
    await context.globalState.update(PRIMARY_SIDEBAR_MIGRATION_KEY, true);
  } catch (err) {
    logger.warn(
      `Failed to remember Varro's Primary Sidebar placement: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function revealSidebarOnFirstActivation(
  context: vscode.ExtensionContext,
  destinationId: string
): Promise<void> {
  const globalState = context.globalState;
  if (!globalState || globalState.get<boolean>(INITIAL_SIDEBAR_REVEAL_KEY)) return;

  try {
    await vscode.commands.executeCommand(destinationId);
    await vscode.commands.executeCommand(`${SidebarProvider.viewType}.focus`);
  } catch (err) {
    logger.warn(
      `Failed to reveal Varro after installation: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  try {
    await globalState.update(INITIAL_SIDEBAR_REVEAL_KEY, true);
  } catch (err) {
    logger.warn(
      `Failed to remember Varro's initial sidebar reveal: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function createSidebarRevealer(destinationId: string): () => Promise<void> {
  return async () => {
    try {
      await vscode.commands.executeCommand('vscode.moveViews', {
        viewIds: [SidebarProvider.viewType],
        destinationId,
      });
    } catch (err) {
      logger.warn(
        `Failed to restore Varro's sidebar placement: ${err instanceof Error ? err.message : String(err)}`
      );
      await vscode.commands.executeCommand(`${SidebarProvider.viewType}.resetViewLocation`);
    }
  };
}

export async function activate(context: vscode.ExtensionContext) {
  logger.info('Activating Varro extension');

  const config = vscode.workspace.getConfiguration('varro');
  const port = validateServerPort(config.get<unknown>('server.port', 4096));
  const autoStart = config.get<boolean>('server.autoStart', true);
  const command = config.get<string>('server.command', '');
  const simulateMissingCli = config.get<boolean>('debug.simulateMissingCli', false);
  const simulateNoProviders = config.get<boolean>('debug.simulateNoProviders', false);
  const compactionSettings = readCompactionSettings(config);

  server = new OpenCodeServer(port, autoStart, command, simulateMissingCli, compactionSettings);
  let scopedWorkspacePath: string | null | undefined;
  contextProvider = new ContextProvider((ctx) => {
    if (scopedWorkspacePath === ctx.workspacePath) {
      sidebarProvider?.post({ type: 'context/update', payload: ctx });
      return;
    }
    scopedWorkspacePath = ctx.workspacePath;
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
  }, context.workspaceState);
  if (process.env.VARRO_SANDBOX_SCENARIO === 'file-link-open') {
    context.subscriptions.push(
      vscode.commands.registerCommand('varro.test.openPath', (path: string, line?: number) =>
        contextProvider?.openPath(path, { kind: 'file', line })
      )
    );
  }

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
    vscode.window.registerWebviewPanelSerializer(SidebarProvider.editorViewType, sidebarProvider)
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      const portChanged = event.affectsConfiguration('varro.server.port');
      const compactionChanged =
        event.affectsConfiguration('varro.chat.autoCompact') ||
        event.affectsConfiguration('varro.chat.autoCompactionReservedTokens');
      const launchSettingsChanged =
        event.affectsConfiguration('varro.server.autoStart') ||
        event.affectsConfiguration('varro.server.command');
      if (!portChanged && !compactionChanged && !launchSettingsChanged) return;

      if (portChanged) {
        void vscode.window
          .showInformationMessage(
            'Reload VS Code to apply the new Varro server port.',
            'Reload Window'
          )
          .then((selection) => {
            if (selection === 'Reload Window') {
              void vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
          });
      }

      const nextConfig = vscode.workspace.getConfiguration('varro');
      if (compactionChanged) {
        void server?.updateCompactionSettings(readCompactionSettings(nextConfig));
      }
      if (launchSettingsChanged) {
        server?.updateLaunchSettings({
          autoStart: nextConfig.get<boolean>('server.autoStart', true),
          command: nextConfig.get<string>('server.command', ''),
        });
      }
    })
  );

  await placeViewInPrimarySidebar(context);
  const sidebarDestination = usesPrimarySidebarForExtensions()
    ? PRIMARY_SIDEBAR_CONTAINER
    : SECONDARY_SIDEBAR_CONTAINER;
  registerCommands(
    context,
    sidebarProvider!,
    contextProvider!,
    server!,
    createSidebarRevealer(sidebarDestination)
  );
  await revealSidebarOnFirstActivation(context, sidebarDestination);

  vscode.commands.executeCommand('setContext', 'varro:activated', true);
  sidebarProvider.startProviderFileObservation();
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
