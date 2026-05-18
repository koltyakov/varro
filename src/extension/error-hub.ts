import * as vscode from 'vscode';
import { logger } from './logger';

export type ErrorAction = {
  title: string;
  run: () => void | Promise<void>;
};

export type ErrorCode = 'server-start' | 'server-cli-missing' | 'server-runtime' | 'generic';

export type ReportedError = {
  code: ErrorCode;
  message: string;
  severity?: 'error' | 'warning' | 'info';
  actions?: ErrorAction[];
};

/**
 * Centralizes user-facing error reporting for the extension host.
 *
 * Why: before this existed, errors were split across ad-hoc
 * `showErrorMessage` calls, silent catches, and log statements; the same
 * underlying failure could pop multiple toasts or be silently dropped.
 */
export class ErrorHub {
  private readonly recentKeys = new Map<string, number>();
  private static readonly DEDUPE_WINDOW_MS = 5_000;

  private pruneRecentKeys(now: number): void {
    const expiry = now - ErrorHub.DEDUPE_WINDOW_MS * 2;
    for (const [key, timestamp] of this.recentKeys) {
      if (timestamp < expiry) this.recentKeys.delete(key);
    }
  }

  report(error: ReportedError): void {
    const message = error.message.trim();
    if (!message) return;
    const key = `${error.code}:${message}`;
    const now = Date.now();
    this.pruneRecentKeys(now);
    const last = this.recentKeys.get(key);
    if (last && now - last < ErrorHub.DEDUPE_WINDOW_MS) return;
    this.recentKeys.set(key, now);

    const severity = error.severity ?? 'error';
    const logLine = `[${error.code}] ${message}`;
    if (severity === 'error') logger.error(logLine);
    else if (severity === 'warning') logger.warn(logLine);
    else logger.info(logLine);

    const show =
      severity === 'warning'
        ? vscode.window.showWarningMessage.bind(vscode.window)
        : severity === 'info'
          ? vscode.window.showInformationMessage.bind(vscode.window)
          : vscode.window.showErrorMessage.bind(vscode.window);

    const actions = error.actions ?? [];
    if (actions.length === 0) {
      void show(message);
      return;
    }

    void show(message, ...actions.map((a) => a.title)).then((picked) => {
      if (!picked) return;
      const action = actions.find((a) => a.title === picked);
      if (!action) return;
      try {
        const result = action.run();
        if (result && typeof (result as Promise<void>).then === 'function') {
          void (result as Promise<void>).catch((err) => {
            logger.error(
              `ErrorHub action "${picked}" failed: ${err instanceof Error ? err.message : String(err)}`
            );
          });
        }
      } catch (err) {
        logger.error(
          `ErrorHub action "${picked}" threw: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });
  }

  /**
   * Pre-built report for the common "CLI missing" case, with an action
   * that opens the OpenCode site.
   */
  reportCliMissing(message: string): void {
    this.report({
      code: 'server-cli-missing',
      message,
      actions: [
        {
          title: 'Install instructions',
          run: () => vscode.env.openExternal(vscode.Uri.parse('https://opencode.ai/')),
        },
        {
          title: 'Show logs',
          run: () => logger.show(),
        },
      ],
    });
  }

  clear(): void {
    this.recentKeys.clear();
  }
}

export const errorHub = new ErrorHub();
