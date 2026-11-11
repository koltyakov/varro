import * as vscode from 'vscode';
import { OpenCodeServer } from './server';
import { SidebarProvider } from './sidebar-provider';
import { ContextProvider } from './context-provider';
import { registerCommands } from './commands';
import { logger } from './logger';
import { readServerPortSetting, sweepStaleInjectedConfigDirectories } from './open-code-process';
import { disposeProcessInspection, prepareProcessInspection } from './process-inspection';
import { diagnosticTimeline } from './diagnostics';
import { measureStartupPhase } from '../shared/startup';
import { prepareVarroScratchDirectory } from './varro-state-paths';
import { readPromptTrace } from './extension-config';
import { configurePromptTrace } from './prompt-trace';

const CONTEXT_RESCOPE_RETRY_MS = 50;
const CONTEXT_RESTART_GRACE_MS = 3000;
const INITIAL_SIDEBAR_REVEAL_KEY = 'layout.initialSidebarReveal.v1';
const PRIMARY_SIDEBAR_MIGRATION_KEY = 'layout.cursorPrimarySidebar.v1';
const SECONDARY_SIDEBAR_REGISTRATION_KEY = 'layout.secondarySidebarRegistration.v2';
const PRIMARY_SIDEBAR_CONTAINER = 'workbench.view.extension.varro-primary';
const SECONDARY_SIDEBAR_CONTAINER = 'workbench.view.extension.varro';
const PRIMARY_SIDEBAR_HOSTS = ['cursor', 'windsurf', 'devin', 'trae', 'traecn'];
const SHOW_FILE_DIFFS_CONTEXT = 'varro:showFileDiffs';

function syncShowFileDiffsContext(config: vscode.WorkspaceConfiguration): void {
  void vscode.commands.executeCommand(
    'setContext',
    SHOW_FILE_DIFFS_CONTEXT,
    config.get<boolean>('chat.showFileDiffs', false)
  );
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
  if (
    !context.globalState ||
    context.globalState.get<boolean>(PRIMARY_SIDEBAR_MIGRATION_KEY) ||
    context.globalState.get<boolean>(INITIAL_SIDEBAR_REVEAL_KEY)
  ) {
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

// TODO(v0.34.0): Remove this temporary migration, its marker, and its activation call for release.
async function migrateSecondarySidebarRegistration(
  context: vscode.ExtensionContext,
  sidebar: SidebarProvider
): Promise<void> {
  const globalState = context.globalState;
  if (!globalState || globalState.get<boolean>(SECONDARY_SIDEBAR_REGISTRATION_KEY)) return;

  try {
    if (globalState.get<boolean>(INITIAL_SIDEBAR_REVEAL_KEY)) {
      // Older releases could save Primary placement automatically. Correct existing profiles once,
      // including a relocated Secondary container, then leave subsequent user moves alone.
      await vscode.commands.executeCommand(
        `${SECONDARY_SIDEBAR_CONTAINER}.resetViewContainerLocation`
      );
      await vscode.commands.executeCommand('vscode.moveViews', {
        viewIds: [SidebarProvider.viewType],
        destinationId: SECONDARY_SIDEBAR_CONTAINER,
      });
      await vscode.commands.executeCommand(`${SidebarProvider.viewType}.focus`);
      if (!sidebar.view?.visible) {
        throw new Error('The host did not reveal Varro in the Secondary Sidebar');
      }
    }
  } catch (err) {
    logger.warn(
      `Failed to migrate Varro to the Secondary Sidebar: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  try {
    await globalState.update(SECONDARY_SIDEBAR_REGISTRATION_KEY, true);
  } catch (err) {
    logger.warn(
      `Failed to remember Varro's Secondary Sidebar registration: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function revealSidebarOnFirstActivation(
  context: vscode.ExtensionContext,
  revealSidebar: () => Promise<void>
): Promise<void> {
  const globalState = context.globalState;
  if (!globalState || globalState.get<boolean>(INITIAL_SIDEBAR_REVEAL_KEY)) return;

  try {
    await revealSidebar();
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

function createSidebarRevealer(
  sidebar: SidebarProvider,
  primarySidebarFallback: boolean
): () => Promise<void> {
  return async () => {
    try {
      // The host's view-focus command follows saved moves to either sidebar or the panel.
      await vscode.commands.executeCommand(`${SidebarProvider.viewType}.focus`);
      if (!primarySidebarFallback || sidebar.view?.visible) return;
    } catch (err) {
      if (!primarySidebarFallback) throw err;
      logger.warn(
        `Failed to reveal Varro in its saved location: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Restricted forks can hide third-party secondary views, even after an earlier migration.
    // Recover only an inaccessible view; do not move a working user-selected location.
    await vscode.commands.executeCommand('vscode.moveViews', {
      viewIds: [SidebarProvider.viewType],
      destinationId: PRIMARY_SIDEBAR_CONTAINER,
    });
    await vscode.commands.executeCommand(`${SidebarProvider.viewType}.focus`);
    if (!sidebar.view?.visible) {
      throw new Error('The host did not reveal Varro in the Primary Sidebar');
    }
  };
}

export async function activate(context: vscode.ExtensionContext) {
  const operationId = diagnosticTimeline.nextId('startup');
  return measureStartupPhase(
    'activation',
    () => activateExtension(context),
    (timing) =>
      diagnosticTimeline.record({
        event: 'startup-phase',
        operationId,
        ...timing,
        platform: process.platform,
        arch: process.arch,
        runtime: process.version,
        editorVersion: vscode.version,
        remoteKind: vscode.env?.remoteName ?? 'local',
      })
  );
}

async function activateExtension(context: vscode.ExtensionContext) {
  logger.info('Activating Varro extension');
  configurePromptTrace(readPromptTrace);
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejection values are untrusted and narrowed for logging.
  void prepareProcessInspection().catch((error: unknown) => {
    logger.warn(
      `Could not prepare Windows process inspection: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  if (!vscode.workspace.workspaceFolders?.length) await prepareVarroScratchDirectory();

  const config = vscode.workspace.getConfiguration('varro');
  const port = readServerPortSetting(config.get<unknown>('server.port', 'auto'));
  const autoStart = config.get<boolean>('server.autoStart', true);
  const command = config.get<string>('server.command', '');
  const simulateMissingCli = config.get<boolean>('debug.simulateMissingCli', false);
  const simulateNoProviders = config.get<boolean>('debug.simulateNoProviders', false);
  let legacyDefaultEndpoint = false;
  if (port === 'auto' && context.globalState) {
    const key = 'varro.server.legacyDefaultEndpoint';
    legacyDefaultEndpoint =
      context.globalState.get<boolean>(key) ??
      context.globalState.get<boolean>(INITIAL_SIDEBAR_REVEAL_KEY) === true;
    try {
      if (context.globalState.get<boolean>(key) === undefined)
        await context.globalState.update(key, legacyDefaultEndpoint);
    } catch (error) {
      logger.warn(
        `Could not remember automatic-port migration: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  syncShowFileDiffsContext(config);

  server = new OpenCodeServer(
    port,
    autoStart,
    command,
    simulateMissingCli,
    undefined,
    context.secrets,
    legacyDefaultEndpoint
  );
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
          if (ctx.workspaceFolders?.length === 0) {
            await prepareVarroScratchDirectory();
            if (generation !== contextUpdateGeneration) return;
          }
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
    context.globalState,
    contextProvider,
    server,
    context.extension.id,
    simulateNoProviders,
    undefined,
    context.secrets,
    context.globalStorageUri
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
      const launchSettingsChanged =
        event.affectsConfiguration('varro.server.autoStart') ||
        event.affectsConfiguration('varro.server.command');
      const fileDiffsChanged = event.affectsConfiguration('varro.chat.showFileDiffs');
      if (!portChanged && !launchSettingsChanged && !fileDiffsChanged) return;

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
      if (fileDiffsChanged) {
        syncShowFileDiffsContext(nextConfig);
      }
      if (launchSettingsChanged) {
        server?.updateLaunchSettings({
          autoStart: nextConfig.get<boolean>('server.autoStart', true),
          command: nextConfig.get<string>('server.command', ''),
        });
      }
    })
  );

  const primarySidebarFallback = usesPrimarySidebarForExtensions();
  const revealSidebar = createSidebarRevealer(sidebarProvider, primarySidebarFallback);
  registerCommands(context, sidebarProvider!, contextProvider!, server!, revealSidebar);
  // View commands can wait for this extension's activation before resolving.
  // Do not make activation wait for its own first-run reveal or placement.
  void (async () => {
    try {
      if (primarySidebarFallback) await placeViewInPrimarySidebar(context);
      else await migrateSecondarySidebarRegistration(context, sidebarProvider!);
      await revealSidebarOnFirstActivation(context, revealSidebar);
    } catch (err) {
      logger.warn(
        `Failed to initialize Varro's sidebar placement: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  })();

  void vscode.commands.executeCommand('setContext', 'varro:activated', true);
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
  configurePromptTrace(() => false);
  contextUpdateGeneration += 1;
  await disposeSafe(() => sidebarProvider?.dispose(), 'sidebarProvider dispose');
  await disposeSafe(() => contextProvider?.dispose(), 'contextProvider dispose');
  await disposeSafe(() => server?.disconnect(), 'server disconnect');
  disposeProcessInspection();
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
