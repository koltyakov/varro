import * as vscode from 'vscode';
import { getSelectionRangesFromEditorContext } from '../shared/context-files';
import { MINIMUM_SUPPORTED_OPENCODE_VERSION } from '../shared/opencode-compatibility';
import type { SidebarProvider } from './sidebar-provider';
import type { ContextProvider } from './context-provider';
import type { OpenCodeServer, OpenCodeServerInfo } from './server';
import { getOpenCodeConfigDirectory } from './open-code-process';
import { getRelativePath } from './util/path';
import { errorHub } from './error-hub';
import { logger } from './logger';

type ExtensionPackageJson = {
  name?: unknown;
  displayName?: unknown;
  version?: unknown;
  dependencies?: unknown;
};

export function registerCommands(
  context: vscode.ExtensionContext,
  sidebar: SidebarProvider,
  contextProvider: ContextProvider,
  server: OpenCodeServer
) {
  context.subscriptions.push(
    vscode.commands.registerCommand('varro.chat.focus', async () => {
      try {
        await vscode.commands.executeCommand('workbench.view.extension.varro');
        sidebar.requestInputFocus();
      } catch (err) {
        logger.error(`varro.chat.focus: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand('varro.chat.statusBarClick', async () => {
      try {
        await vscode.commands.executeCommand('workbench.view.extension.varro');
        if (sidebar.hasPendingAttention()) {
          sidebar.openAttentionSessions();
          return;
        }
        sidebar.requestInputFocus();
      } catch (err) {
        logger.error(
          `varro.chat.statusBarClick: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('varro.chat.newSession', () => {
      sidebar.postCommand('new-session');
    }),

    vscode.commands.registerCommand('varro.chat.searchSessions', async () => {
      try {
        await vscode.commands.executeCommand('workbench.view.extension.varro');
        sidebar.searchSessions();
      } catch (err) {
        logger.error(
          `varro.chat.searchSessions: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('varro.chat.abort', () => {
      sidebar.postCommand('abort');
    }),

    vscode.commands.registerCommand('varro.chat.previousSession', () => {
      sidebar.switchSession('previous');
    }),

    vscode.commands.registerCommand('varro.chat.nextSession', () => {
      sidebar.switchSession('next');
    }),

    vscode.commands.registerCommand('varro.about', async () => {
      try {
        const serverInfo = await server.readServerInfo();
        const document = await vscode.workspace.openTextDocument({
          language: 'markdown',
          content: renderAboutMarkdown(context, serverInfo),
        });
        await vscode.window.showTextDocument(document, { preview: false });
      } catch (err) {
        const message = `Failed to open Varro about: ${err instanceof Error ? err.message : String(err)}`;
        logger.error(message);
        vscode.window.showErrorMessage(message);
      }
    }),

    vscode.commands.registerCommand('varro.showOutput', () => {
      logger.show();
    }),

    vscode.commands.registerCommand('varro.openSourceControl', async () => {
      await vscode.commands.executeCommand('workbench.view.scm');
    }),

    vscode.commands.registerCommand('varro.agents.openGlobal', async () => {
      try {
        await openAgentsFile(vscode.Uri.file(getOpenCodeConfigDirectory()));
      } catch (err) {
        showAgentsFileError('global', err);
      }
    }),

    vscode.commands.registerCommand('varro.agents.initializeProject', async () => {
      const workspacePath = contextProvider.context.workspacePath;
      if (!workspacePath) {
        vscode.window.showWarningMessage('Varro: Open a project before initializing AGENTS.md.');
        return;
      }

      try {
        await openAgentsFile(vscode.Uri.file(workspacePath));
        await vscode.commands.executeCommand('workbench.view.extension.varro');
        sidebar.post({ type: 'command/new-session', payload: { prefill: '/init' } });
        sidebar.requestInputFocus();
      } catch (err) {
        showAgentsFileError('project', err);
      }
    }),

    vscode.commands.registerCommand('varro.server.restart', async () => {
      try {
        const url = await server.restart();
        sidebar.post({ type: 'providers/refresh' });
        logger.info(`OpenCode server restarted at ${url}`);
      } catch (err) {
        const message = `Failed to restart server: ${err instanceof Error ? err.message : String(err)}`;
        if (server.status.state !== 'error') {
          errorHub.report({ code: 'server-start', message });
        } else {
          logger.error(message);
        }
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

async function openAgentsFile(directoryUri: vscode.Uri) {
  const fileUri = vscode.Uri.joinPath(directoryUri, 'AGENTS.md');
  await vscode.workspace.fs.createDirectory(directoryUri);

  try {
    await vscode.workspace.fs.stat(fileUri);
  } catch (err) {
    if (!isFileNotFoundError(err)) throw err;
    await vscode.workspace.fs.writeFile(fileUri, new Uint8Array());
  }

  const document = await vscode.workspace.openTextDocument(fileUri);
  await vscode.window.showTextDocument(document, { preview: false });
}

function isFileNotFoundError(err: unknown) {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'FileNotFound'
  );
}

function showAgentsFileError(scope: 'global' | 'project', err: unknown) {
  const message = `Failed to open ${scope} AGENTS.md: ${err instanceof Error ? err.message : String(err)}`;
  logger.error(message);
  vscode.window.showErrorMessage(message);
}

function renderAboutMarkdown(context: vscode.ExtensionContext, serverInfo: OpenCodeServerInfo) {
  const pkg = readPackageJson(context);
  const name = getString(pkg.displayName) || getString(pkg.name) || 'Varro';
  const version = getString(pkg.version) || 'unknown';
  const sdkVersion = readDependencyVersion(pkg, '@opencode-ai/sdk');
  const status = formatServerStatus(serverInfo);
  const autoUpdate = vscode.workspace
    .getConfiguration('varro')
    .get<boolean>('server.autoUpdate', true);
  const cliVersion = serverInfo.cliVersionError
    ? `error: ${serverInfo.cliVersionError}`
    : serverInfo.cliVersion || 'not found';

  return [
    `# ${name} About`,
    '',
    '## Varro',
    `- Version: ${version}`,
    '',
    '## OpenCode',
    `- SDK version: ${sdkVersion}`,
    `- Minimum supported version: ${MINIMUM_SUPPORTED_OPENCODE_VERSION}`,
    `- CLI version: ${cliVersion}`,
    `- Server status: ${status}`,
    `- Server URL: ${serverInfo.url}`,
    `- Server port: ${serverInfo.port}`,
    `- Server health: ${serverInfo.health.healthy ? 'healthy' : 'unhealthy'}`,
    `- Server version: ${serverInfo.health.version || 'unknown'}`,
    `- Auto updates: ${autoUpdate ? 'enabled' : 'disabled'}`,
    `- CLI command: ${serverInfo.command}`,
    `- Workspace: ${serverInfo.workspaceCwd || 'none'}`,
    '',
    '## Runtime',
    `- VS Code: ${vscode.version}`,
    `- Node: ${process.version}`,
    `- Platform: ${process.platform} ${process.arch}`,
    '',
  ].join('\n');
}

function readPackageJson(context: vscode.ExtensionContext): ExtensionPackageJson {
  const pkg = (context as { extension?: { packageJSON?: unknown } }).extension?.packageJSON;
  return pkg && typeof pkg === 'object' ? (pkg as ExtensionPackageJson) : {};
}

function readDependencyVersion(pkg: ExtensionPackageJson, name: string) {
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object') return 'unknown';

  const value = (pkg.dependencies as Record<string, unknown>)[name];
  if (typeof value !== 'string') return 'unknown';

  const normalized = value.match(/\d+(?:\.\d+)+/)?.[0];
  if (!normalized || normalized === value) return value;
  return `${normalized} (declared ${value})`;
}

function formatServerStatus(serverInfo: OpenCodeServerInfo) {
  const status = serverInfo.status;
  switch (status.state) {
    case 'running':
      return status.eventStream ? `running, event stream ${status.eventStream}` : 'running';
    case 'error':
      return `error: ${status.message}`;
    default:
      return status.state;
  }
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
