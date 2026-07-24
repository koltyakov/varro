import { spawn, type ChildProcess } from 'child_process';
import { mkdtemp, open, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import * as vscode from 'vscode';
import { isSameWorkspacePath, normalizeWorkspaceIdentity } from '../shared/workspace-path';
import type { OpenCodeServer } from './server';
import { assertValidJson, normalizeCliOutput } from './sidebar-provider-utils';
import { resolveServerLaunch } from './util/server-launch';
import { buildServerEnv } from './util/server-path';

const EXPORT_TERMINATION_GRACE_MS = 1_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 500;

export class SessionExportService {
  constructor(
    private readonly server: Pick<OpenCodeServer, 'getWorkspaceCwd' | 'request' | 'resolveCommand'>,
    private readonly exportTimeoutMs: number
  ) {}

  async exportSession(sessionId: string) {
    try {
      await this.assertSessionInCurrentWorkspace(sessionId);
      const content = await this.readExportContentFromTempFile(sessionId);
      assertValidJson(content, 'OpenCode export');
      const document = await vscode.workspace.openTextDocument({
        language: 'json',
        content,
      });
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await vscode.window.showErrorMessage(`Failed to export session: ${message}`);
      throw err;
    }
  }

  private async assertSessionInCurrentWorkspace(sessionId: string): Promise<void> {
    const workspacePath = this.server.getWorkspaceCwd();
    if (!normalizeWorkspaceIdentity(workspacePath)) return;
    const sessions = await this.server.request('GET', '/session');
    const session = Array.isArray(sessions)
      ? sessions.map(asRecord).find((item) => item?.id === sessionId)
      : undefined;
    if (!isSameWorkspacePath(getString(session?.directory), workspacePath)) {
      throw new Error('Session does not belong to the current workspace');
    }
  }

  private async readExportContentFromTempFile(sessionId: string): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), 'varro-opencode-export-'));
    const tempFile = join(tempDir, 'session-export.json');

    try {
      await this.runCliCommandToFile(['export', sessionId], tempFile);
      return normalizeCliOutput(await readFile(tempFile, 'utf-8'));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async runCliCommandToFile(args: string[], outputPath: string): Promise<void> {
    const fileHandle = await open(outputPath, 'w');

    return new Promise((resolveOutput, reject) => {
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let hardTerminationStarted = false;
      let proc: ReturnType<typeof spawn> | null = null;
      let escalationTimeout: ReturnType<typeof setTimeout> | null = null;
      let forceSettleTimeout: ReturnType<typeof setTimeout> | null = null;
      const timeoutError = new Error('OpenCode CLI export timed out');
      const timeout = setTimeout(() => {
        timedOut = true;
        if (!proc) {
          finish(timeoutError);
          return;
        }
        void terminateProcessTree(proc, false);
        escalationTimeout = setTimeout(() => {
          escalationTimeout = null;
          if (!proc || settled) return;
          hardTerminationStarted = true;
          void terminateProcessTree(proc, true);
          forceSettleTimeout = setTimeout(() => {
            forceSettleTimeout = null;
            finish(timeoutError);
          }, EXPORT_TERMINATION_GRACE_MS);
        }, EXPORT_TERMINATION_GRACE_MS);
      }, this.exportTimeoutMs);

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (escalationTimeout) {
          clearTimeout(escalationTimeout);
          escalationTimeout = null;
        }
        if (forceSettleTimeout) {
          clearTimeout(forceSettleTimeout);
          forceSettleTimeout = null;
        }
        void fileHandle
          .close()
          .catch(() => undefined)
          .finally(() => {
            if (error) {
              reject(error);
              return;
            }
            resolveOutput();
          });
      };

      const settleTimedOutProcess = () => {
        if (settled || !proc || hardTerminationStarted) return;
        hardTerminationStarted = true;
        if (escalationTimeout) {
          clearTimeout(escalationTimeout);
          escalationTimeout = null;
        }
        void terminateProcessTree(proc, true);
        forceSettleTimeout ??= setTimeout(() => {
          forceSettleTimeout = null;
          finish(timeoutError);
        }, WINDOWS_TASKKILL_TIMEOUT_MS);
      };

      try {
        const command = this.server.resolveCommand();
        const launch = resolveServerLaunch(command, args);
        proc = spawn(launch.command, launch.args, {
          stdio: ['ignore', fileHandle.fd, 'pipe'],
          cwd: this.server.getWorkspaceCwd(),
          env: buildServerEnv(),
          windowsHide: true,
          ...(process.platform === 'win32' ? {} : { detached: true }),
          ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });

        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        proc.once('error', (err) => {
          if (timedOut) settleTimedOutProcess();
          else finish(err);
        });
        proc.once('close', (code, signal) => {
          if (timedOut) {
            settleTimedOutProcess();
            return;
          }
          if (code === 0) {
            finish();
            return;
          }
          finish(
            new Error(
              stderr.trim() ||
                `OpenCode CLI command failed${signal ? ` (${signal})` : code !== null ? ` (code ${code})` : ''}`
            )
          );
        });
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function terminateProcessTree(proc: ChildProcess, force: boolean): Promise<void> {
  const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
  if (process.platform !== 'win32') {
    if (proc.pid) {
      try {
        process.kill(-proc.pid, signal);
        return;
      } catch {}
    }
    try {
      proc.kill(signal);
    } catch {}
    return;
  }

  if (!proc.pid) {
    try {
      proc.kill(signal);
    } catch {}
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      try {
        proc.kill(signal);
      } catch {}
      finish();
    }, WINDOWS_TASKKILL_TIMEOUT_MS);
    try {
      const killer = spawn(
        'taskkill.exe',
        ['/pid', String(proc.pid), '/T', ...(force ? ['/F'] : [])],
        { stdio: 'ignore', windowsHide: true }
      );
      killer.once('error', finish);
      killer.once('close', finish);
    } catch {
      try {
        proc.kill(signal);
      } catch {}
      finish();
    }
  });
}
