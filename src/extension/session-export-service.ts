import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import crossSpawn from 'cross-spawn';
import { mkdtemp, open, readFile, rm, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import * as vscode from 'vscode';
import { normalizeWorkspaceIdentity } from '../shared/workspace-path';
import type { OpenCodeServer } from './server';
import { assertSessionInCurrentWorkspace } from './session-workspace';
import { assertValidJson, normalizeCliOutput } from './sidebar-provider-utils';
import { buildServerEnv } from './util/server-path';

const EXPORT_TERMINATION_GRACE_MS = 1_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 500;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_EXPORT_STDERR_BYTES = 64 * 1024;

export class SessionExportService {
  constructor(
    private readonly server: Pick<OpenCodeServer, 'getWorkspaceCwd' | 'request' | 'resolveCommand'>,
    private readonly exportTimeoutMs: number
  ) {}

  async exportSession(sessionId: string, directory?: string) {
    try {
      const workspacePath = directory ?? this.server.getWorkspaceCwd();
      const workspaceIdentity = normalizeWorkspaceIdentity(workspacePath);
      await (directory
        ? assertSessionInCurrentWorkspace(this.server, sessionId, workspacePath)
        : assertSessionInCurrentWorkspace(this.server, sessionId));
      if (!directory) this.assertWorkspaceUnchanged(workspaceIdentity);
      const content = await this.readExportContentFromTempFile(
        sessionId,
        workspacePath,
        workspaceIdentity,
        !directory
      );
      if (!directory) this.assertWorkspaceUnchanged(workspaceIdentity);
      assertValidJson(content, 'OpenCode export');
      const document = await vscode.workspace.openTextDocument({
        language: 'json',
        content,
      });
      if (!directory) this.assertWorkspaceUnchanged(workspaceIdentity);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await vscode.window.showErrorMessage(`Failed to export session: ${message}`);
      throw err;
    }
  }

  private async readExportContentFromTempFile(
    sessionId: string,
    workspacePath: string | undefined,
    workspaceIdentity: string | null,
    enforceWorkspaceStability: boolean
  ): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), 'varro-opencode-export-'));
    const tempFile = join(tempDir, 'session-export.json');

    try {
      if (enforceWorkspaceStability) this.assertWorkspaceUnchanged(workspaceIdentity);
      await this.runCliCommandToFile(
        ['export', sessionId],
        tempFile,
        workspacePath,
        enforceWorkspaceStability
      );
      const outputInfo = await stat(tempFile);
      if (outputInfo.size > MAX_EXPORT_BYTES) {
        throw new Error(
          `OpenCode export exceeds the ${MAX_EXPORT_BYTES / (1024 * 1024)} MB safety limit`
        );
      }
      return normalizeCliOutput(await readFile(tempFile, 'utf-8'));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async runCliCommandToFile(
    args: string[],
    outputPath: string,
    workspacePath: string | undefined,
    enforceWorkspaceStability: boolean
  ): Promise<void> {
    const fileHandle = await open(outputPath, 'w');

    return new Promise((resolveOutput, reject) => {
      let stderr: Buffer = Buffer.alloc(0);
      let stderrTruncated = false;
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
        if (enforceWorkspaceStability) {
          this.assertWorkspaceUnchanged(normalizeWorkspaceIdentity(workspacePath));
        }
        const command = this.server.resolveCommand();
        const spawnOptions: SpawnOptions = {
          stdio: ['ignore', fileHandle.fd, 'pipe'],
          cwd: workspacePath,
          env: buildServerEnv(),
          windowsHide: true,
        };
        if (process.platform !== 'win32') spawnOptions.detached = true;
        proc = crossSpawn(command, args, spawnOptions);

        proc.stderr?.on('data', (data: Buffer) => {
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (chunk.length >= MAX_EXPORT_STDERR_BYTES) {
            stderr = chunk.subarray(chunk.length - MAX_EXPORT_STDERR_BYTES);
            stderrTruncated = true;
            return;
          }
          const combined = Buffer.concat([stderr, chunk]);
          if (combined.length > MAX_EXPORT_STDERR_BYTES) {
            stderr = combined.subarray(combined.length - MAX_EXPORT_STDERR_BYTES);
            stderrTruncated = true;
          } else {
            stderr = combined;
          }
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
              formatExportStderr(stderr, stderrTruncated) ||
                `OpenCode CLI command failed${signal ? ` (${signal})` : code !== null ? ` (code ${code})` : ''}`
            )
          );
        });
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private assertWorkspaceUnchanged(workspaceIdentity: string | null): void {
    if (
      workspaceIdentity &&
      normalizeWorkspaceIdentity(this.server.getWorkspaceCwd()) !== workspaceIdentity
    ) {
      throw new Error('Workspace changed during session export');
    }
  }
}

function formatExportStderr(stderr: Buffer, truncated: boolean) {
  const message = stderr.toString('utf8').trim();
  if (!message) return '';
  return truncated ? `[Earlier OpenCode CLI output omitted]\n${message}` : message;
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
