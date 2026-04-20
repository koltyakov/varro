import * as vscode from 'vscode';

const channel = vscode.window.createOutputChannel('Varro');

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const logger = {
  info(msg: string, ...args: unknown[]) {
    channel.appendLine(`[INFO] ${msg} ${args.length ? safeStringify(args) : ''}`);
  },
  warn(msg: string, ...args: unknown[]) {
    channel.appendLine(`[WARN] ${msg} ${args.length ? safeStringify(args) : ''}`);
  },
  error(msg: string, ...args: unknown[]) {
    channel.appendLine(`[ERROR] ${msg} ${args.length ? safeStringify(args) : ''}`);
  },
  show() {
    channel.show();
  },
  dispose() {
    channel.dispose();
  },
};
