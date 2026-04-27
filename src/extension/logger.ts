import * as vscode from 'vscode';

const channel = vscode.window.createOutputChannel('Varro');

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, currentValue) => {
      if (currentValue instanceof Error) {
        return {
          name: currentValue.name,
          message: currentValue.message,
          ...(currentValue.stack ? { stack: currentValue.stack } : {}),
        };
      }
      return currentValue;
    });
  } catch {
    return String(value);
  }
}

function formatLogLine(level: string, msg: string, args: unknown[]) {
  const suffix = args.length ? ` ${safeStringify(args)}` : '';
  return `[${level}] ${msg}${suffix}`;
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
    channel.show();
  },
  dispose() {
    channel.dispose();
  },
};
