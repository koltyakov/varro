import * as vscode from 'vscode';

const channel = vscode.window.createOutputChannel('OpenCode');

export const logger = {
  info(msg: string, ...args: unknown[]) {
    channel.appendLine(`[INFO] ${msg} ${args.length ? JSON.stringify(args) : ''}`);
  },
  warn(msg: string, ...args: unknown[]) {
    channel.appendLine(`[WARN] ${msg} ${args.length ? JSON.stringify(args) : ''}`);
  },
  error(msg: string, ...args: unknown[]) {
    channel.appendLine(`[ERROR] ${msg} ${args.length ? JSON.stringify(args) : ''}`);
  },
  show() {
    channel.show();
  },
};
