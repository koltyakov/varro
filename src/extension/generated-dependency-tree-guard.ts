import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { logger } from './logger';

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 256 * 1024;
const SEND_ANYWAY = 'Send Anyway';
const OPEN_SOURCE_CONTROL = 'Open Source Control';

export class GeneratedDependencyTreeGuard {
  private readonly approvedFingerprintByWorkspace = new Map<string, string>();

  async confirmPromptAdmission(workspacePath: string): Promise<boolean> {
    const trees = await findUnignoredNodeModulesTrees(workspacePath);
    if (trees.length === 0) return true;

    const fingerprint = trees.join('\0');
    if (this.approvedFingerprintByWorkspace.get(workspacePath) === fingerprint) return true;

    const preview = trees.slice(0, 3).map((path) => `\`${path}\``).join(', ');
    const remaining = trees.length - 3;
    const choice = await vscode.window.showWarningMessage(
      `Unignored generated dependencies were found: ${preview}${remaining > 0 ? ` and ${remaining} more` : ''}. OpenCode snapshots may scan or attribute these files even when the agent did not create them. Add an appropriate Git ignore rule or remove the tree before continuing. Varro will not modify ignore files automatically.`,
      { modal: true },
      SEND_ANYWAY,
      OPEN_SOURCE_CONTROL
    );
    if (choice === SEND_ANYWAY) {
      this.approvedFingerprintByWorkspace.set(workspacePath, fingerprint);
      return true;
    }
    if (choice === OPEN_SOURCE_CONTROL) {
      await vscode.commands.executeCommand('workbench.view.scm');
    }
    return false;
  }
}

export async function findUnignoredNodeModulesTrees(workspacePath: string): Promise<string[]> {
  try {
    const stdout = await runGit(workspacePath, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
      '--ignored=no',
      '--',
      ':(glob)**/node_modules/**',
    ]);
    const trees = new Set<string>();
    for (const record of stdout.split('\0')) {
      if (!record.startsWith('?? ')) continue;
      const path = record.slice(3).replace(/\\/g, '/').replace(/\/$/, '');
      const match = path.match(/^(.*?(?:^|\/)node_modules)(?:\/|$)/);
      if (match?.[1]) trees.add(match[1]);
    }
    return [...trees].toSorted();
  } catch (err) {
    logger.warn(
      `Could not check generated dependency trees in ${workspacePath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

function runGit(workspacePath: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
  );
  env.GIT_OPTIONAL_LOCKS = '0';
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', workspacePath, '-c', 'core.quotepath=false', ...args],
      {
        encoding: 'utf8',
        env,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}
