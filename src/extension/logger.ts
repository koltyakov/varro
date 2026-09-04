/* oxlint-disable anti-slop/no-unknown-parameters -- Logging intentionally accepts arbitrary diagnostic values and serializes them defensively. */
import * as vscode from 'vscode';

const channel = vscode.window.createOutputChannel('Varro');

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, currentValue) => {
      if (currentValue instanceof Error) {
        const serialized: SerializedError = {
          name: currentValue.name,
          message: currentValue.message,
        };
        if (currentValue.stack) serialized.stack = currentValue.stack;
        return serialized;
      }
      return currentValue;
    });
  } catch {
    return String(value);
  }
}

function formatLogLine(level: string, msg: string, args: unknown[]) {
  const suffix = args.length ? ` ${safeStringify(args)}` : '';
  return `${new Date().toISOString()} [${level}] ${msg}${suffix}`;
}

export const logger = {
  info(msg: string, ...args: unknown[]) {
    channel.appendLine(formatLogLine('INFO', msg, args));
  },
  warn(msg: string, ...args: unknown[]) {
    channel.appendLine(formatLogLine('WARN', msg, args));
  },
  error(msg: string, ...args: unknown[]) {
    channel.appendLine(formatLogLine('ERROR', msg, args));
  },
  show() {
    channel.show(false);
  },
  dispose() {
    channel.dispose();
  },
};
