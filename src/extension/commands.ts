/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Command handlers decode VS Code extension API values before use. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Assertions bind VS Code command contexts to contracts checked by each handler. */
import * as vscode from 'vscode';
import { getSelectionRangesFromEditorContext } from '../shared/context-files';
import { describeInstallMethod, getUpgradeCommand } from '../shared/opencode-install';
import { readMaximumTestedOpenCodeVersion } from './extension-manifest';
import type { SidebarProvider } from './sidebar-provider';
import type { ContextProvider } from './context-provider';
import { RestartBlockedError, type OpenCodeServer, type OpenCodeServerInfo } from './server';
import { getOpenCodeConfigDirectory } from './open-code-process';
import { getRelativePath } from './util/path';
import { errorHub } from './error-hub';
import { logger } from './logger';
import { compareVersions, extractVersion } from './server-utils';

type ExtensionPackageJson = {
  name?: unknown;
  displayName?: unknown;
  version?: unknown;
};

async function setShowInlineFileChanges(enabled: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration('varro');
  const inspected = config.inspect<boolean>('chat.showInlineFileChanges');
  const target =
    inspected?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await config.update('chat.showInlineFileChanges', enabled, target);
}

export function registerCommands(
  context: vscode.ExtensionContext,
  sidebar: SidebarProvider,
  contextProvider: ContextProvider,
  server: OpenCodeServer,
  revealSidebar: () => PromiseLike<unknown>
) {
  context.subscriptions.push(
    vscode.commands.registerCommand('varro.chat.focus', async () => {
      try {
        await revealSidebar();
        sidebar.requestInputFocus();
      } catch (err) {
        logger.error(`varro.chat.focus: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand('varro.chat.statusBarClick', async () => {
      try {
        const action = sidebar.getStatusBarClickAction();
        await revealSidebar();
        if (action === 'attention') {
          sidebar.openAttentionSessions();
          return;
        }
        if (action === 'completed') {
          sidebar.openCompletedSessions();
          return;
        }
        sidebar.requestInputFocus();
      } catch (err) {
        logger.error(
          `varro.chat.statusBarClick: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('varro.chat.newSession', async () => {
      sidebar.postCommand('new-session');
      await revealSidebar();
    }),

    vscode.commands.registerCommand('varro.chat.newEditor', async () => {
      await sidebar.openNewEditor();
    }),

    vscode.commands.registerCommand('varro.chat.newTerminalEditor', () => {
      sidebar.openNewTerminalEditor();
    }),

    vscode.commands.registerCommand('varro.chat.searchSessions', async () => {
      try {
        await revealSidebar();
        sidebar.searchSessions();
      } catch (err) {
        logger.error(
          `varro.chat.searchSessions: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('varro.chat.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'Varro');
    }),

    vscode.commands.registerCommand('varro.chat.showInlineFileChanges', async () => {
      await setShowInlineFileChanges(true);
    }),

    vscode.commands.registerCommand('varro.chat.hideInlineFileChanges', async () => {
      await setShowInlineFileChanges(false);
    }),

    vscode.commands.registerCommand('varro.chat.openStats', async () => {
      await sidebar.generateUsageReport();
    }),

    vscode.commands.registerCommand('varro.chat.abort', async () => {
      sidebar.postCommand('abort');
      await revealSidebar();
    }),

    vscode.commands.registerCommand('varro.chat.previousSession', async () => {
      sidebar.switchSession('previous');
      await revealSidebar();
    }),

    vscode.commands.registerCommand('varro.chat.nextSession', async () => {
      sidebar.switchSession('next');
      await revealSidebar();
    }),

    vscode.commands.registerCommand('varro.about', async () => {
      try {
        const serverInfo = await server.readServerInfo();
        const uri = await sidebar.openMarkdownDocument(
          renderAboutMarkdown(context, serverInfo),
          'Varro About',
          false
        );
        if (!uri) throw new Error('Could not open the generated about report.');
        await vscode.commands.executeCommand('markdown.showPreview', uri);
      } catch (err) {
        const message = `Failed to open Varro about: ${err instanceof Error ? err.message : String(err)}`;
        logger.error(message);
        vscode.window.showErrorMessage(message);
      }
    }),

    vscode.commands.registerCommand('varro.openGitHub', async () => {
      await vscode.env.openExternal(vscode.Uri.parse('https://github.com/koltyakov/varro'));
    }),

    vscode.commands.registerCommand('varro.showOutput', () => {
      logger.show();
    }),

    vscode.commands.registerCommand('varro.openSourceControl', async () => {
      await vscode.commands.executeCommand('workbench.view.scm');
    }),

    vscode.commands.registerCommand(
      'varro.generateCommitMessage',
      async (sourceControl?: vscode.SourceControl) => {
        await sidebar.generateCommitMessage(sourceControl);
      }
    ),

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
        await revealSidebar();
        sidebar.postCommand('new-session', { prefill: '/init' });
        sidebar.requestInputFocus();
      } catch (err) {
        showAgentsFileError('project', err);
      }
    }),

    vscode.commands.registerCommand(
      'varro.server.restart',
      async (options?: { force?: boolean }) => {
        try {
          const url = await server.restart({ force: options?.force === true });
          sidebar.post({ type: 'providers/refresh' });
          logger.info(`OpenCode server restarted at ${url}`);
        } catch (err) {
          if (err instanceof RestartBlockedError) {
            await revealSidebar();
            sidebar.post({ type: 'server/restart-blocked', payload: err.blockers });
            return;
          }
          const message = `Failed to restart server: ${err instanceof Error ? err.message : String(err)}`;
          if (server.status.state !== 'error') {
            errorHub.report({ code: 'server-start', message });
          } else {
            logger.error(message);
          }
        }
      }
    ),

    vscode.commands.registerCommand('varro.chat.addTerminalSelectionToContext', async () => {
      try {
        const ok = await captureTerminalSelectionForContext(sidebar, contextProvider);
        if (!ok) {
          return;
        }
        await revealSidebar();
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
        await revealSidebar();
      } catch (err) {
        logger.error(
          `varro.chat.addSelectionToContext: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    ...registerSelectionPromptCommands(sidebar, revealSidebar),

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
            await revealSidebar();
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

const SELECTION_PROMPT_COMMANDS = [
  {
    id: 'varro.chat.explainSelection',
    prompt:
      'Explain the selected code clearly, including its purpose, control flow, important assumptions, and any non-obvious behavior.',
  },
  {
    id: 'varro.chat.reviewSelection',
    prompt:
      'Review the selected code for correctness, regressions, security, maintainability, and missing tests. Lead with concrete findings ordered by severity.',
  },
  {
    id: 'varro.chat.improveSelection',
    prompt:
      'Improve the selected code. Preserve its intended behavior unless a change is needed to fix a concrete problem, and verify the result.',
  },
] as const;

function registerSelectionPromptCommands(
  sidebar: SidebarProvider,
  revealSidebar: () => PromiseLike<unknown>
) {
  return SELECTION_PROMPT_COMMANDS.map(({ id, prompt }) =>
    vscode.commands.registerCommand(id, async () => {
      try {
        const selectionTarget = await getEditorSelectionTarget();
        if (!selectionTarget) {
          vscode.window.showWarningMessage('Varro: Select text in a saved workspace file first.');
          return;
        }

        await revealSidebar();
        sidebar.postCommand('new-session', { prefill: prompt });
        sidebar.postDroppedFiles([selectionTarget]);
        sidebar.requestInputFocus();
      } catch (err) {
        logger.error(`${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
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
  const maximumTestedVersion = readMaximumTestedOpenCodeVersion();
  const autoUpdate = vscode.workspace
    .getConfiguration('varro')
    .get<boolean>('server.autoUpdate', true);
  const cliVersion = serverInfo.cliVersionError
    ? `error: ${serverInfo.cliVersionError}`
    : serverInfo.cliVersion || 'not found';
  const activeAgents = serverInfo.activeAgentError
    ? `error: ${serverInfo.activeAgentError}`
    : String(serverInfo.activeAgentCount ?? 'unknown');
  const installedVersion = serverInfo.cliVersion ? extractVersion(serverInfo.cliVersion) : null;
  const updateAvailable =
    installedVersion !== null && compareVersions(installedVersion, maximumTestedVersion) < 0;
  const updateCommand = updateAvailable
    ? getUpgradeCommand(serverInfo.installMethod, process.platform)
    : null;
  const updateNoticeLines = !updateAvailable
    ? []
    : updateCommand
      ? [
          '',
          `**OpenCode ${maximumTestedVersion} is available.**`,
          '',
          'Run this command to install the update:',
          '',
          `\`\`\`${process.platform === 'win32' ? 'powershell' : 'sh'}`,
          updateCommand,
          '```',
        ]
      : [
          '',
          `**OpenCode ${maximumTestedVersion} is available.**`,
          '',
          `Reinstall OpenCode using ${describeInstallMethod(serverInfo.installMethod)}.`,
        ];
  const ownership =
    serverInfo.ownership === 'other-host' ||
    serverInfo.ownership === 'current-host' ||
    serverInfo.managedProcess
      ? 'managed by Varro'
      : 'unmanaged';
  const serverStatus =
    serverInfo.status.state === 'running'
      ? `running, event stream ${serverInfo.status.eventStream || 'unknown'}`
      : serverInfo.status.state === 'error'
        ? `error: ${serverInfo.status.message}`
        : serverInfo.status.state;
  return [
    `# ${name}`,
    '',
    '## Varro',
    `- **Version:** ${markdownCode(version)}`,
    '- [GitHub repository](https://github.com/koltyakov/varro)',
    '- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=koltyakov.varro)',
    '- [Open VSX Registry](https://open-vsx.org/extension/koltyakov/varro)',
    '',
    '## OpenCode',
    '- **CLI:**',
    `  - **Version:** ${markdownCode(cliVersion)}`,
    `  - **Install method:** ${describeInstallMethod(serverInfo.installMethod)}`,
    `  - **Binary:** ${markdownCode(serverInfo.resolvedCommand || 'not resolved')}`,
    '- **Server:**',
    `  - **Version:** ${markdownCode(serverInfo.health.version || 'unknown')}`,
    `  - **URL:** [${serverInfo.url}](${serverInfo.url})`,
    `  - **Ownership:** ${ownership}`,
    `  - **Status:** ${markdownCode(serverStatus)}`,
    `  - **Health:** ${serverInfo.health.healthy ? 'healthy' : 'unhealthy'}`,
    `  - **Active agents:** ${markdownCode(activeAgents)}`,
    `- **Auto updates:** ${autoUpdate ? 'enabled' : 'disabled'}`,
    ...updateNoticeLines,
    '',
    '## Runtime',
    `- **VS Code:** ${markdownCode(vscode.version)}`,
    `- **Node:** ${markdownCode(process.version)}`,
    `- **Platform:** ${markdownCode(`${process.platform} ${process.arch}`)}`,
    '',
  ].join('\n');
}

function markdownCode(value: string | number) {
  const text = String(value).replace(/[\r\n]+/g, ' ');
  const longestRun = Math.max(0, ...(text.match(/`+/g)?.map((run) => run.length) ?? []));
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}${text}${fence}`;
}

function readPackageJson(context: vscode.ExtensionContext): ExtensionPackageJson {
  const pkg = (context as { extension?: { packageJSON?: unknown } }).extension?.packageJSON;
  return pkg && typeof pkg === 'object' ? (pkg as ExtensionPackageJson) : {};
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
  let result: Awaited<ReturnType<ContextProvider['captureTerminalSelection']>>;
  try {
    result = await contextProvider.captureTerminalSelection();
  } catch (err) {
    sidebar.postTerminalSelection(null);
    throw err;
  }

  if (!result.ok) {
    sidebar.postTerminalSelection(null);
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
