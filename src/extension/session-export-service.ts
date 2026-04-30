import { spawn } from 'child_process';
import { mkdtemp, open, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import * as vscode from 'vscode';
import type { OpenCodeServer } from './server';
import { assertValidJson, normalizeCliOutput } from './sidebar-provider-utils';
import { resolveServerLaunch } from './util/server-launch';
import { buildServerEnv } from './util/server-path';

export class SessionExportService {
  constructor(
    private readonly server: Pick<OpenCodeServer, 'getWorkspaceCwd' | 'resolveCommand'>,
    private readonly exportTimeoutMs: number
  ) {}

  async exportSession(sessionId: string) {
    try {
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
      let proc: ReturnType<typeof spawn> | null = null;
      const timeout = setTimeout(() => {
        if (proc && proc.exitCode === null && proc.signalCode === null) {
          proc.kill('SIGTERM');
        }
        finish(new Error('OpenCode CLI export timed out'));
      }, this.exportTimeoutMs);

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
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

      try {
        const command = this.server.resolveCommand();
        const launch = resolveServerLaunch(command, args);
        proc = spawn(launch.command, launch.args, {
          stdio: ['ignore', fileHandle.fd, 'pipe'],
          cwd: this.server.getWorkspaceCwd(),
          env: buildServerEnv(),
          windowsHide: true,
          ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });

        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        proc.once('error', (err) => finish(err));
        proc.once('close', (code, signal) => {
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
