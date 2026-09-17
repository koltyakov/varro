import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { logger } from '../logger';

// Task completion works even when terminal shell integration is disabled. Keep
// the output visible without requiring the user to close the terminal to reconnect.
export async function runWindowsCliUpdate(
  command: string,
  title: string,
  cwd: string | undefined,
  onFinish: () => void | Promise<void>
): Promise<void> {
  const id = randomUUID();
  const task = new vscode.Task(
    { type: 'varro-opencode-update', id },
    vscode.TaskScope.Workspace,
    title,
    'Varro',
    new vscode.ShellExecution(command, {
      cwd,
      executable: 'powershell.exe',
      shellArgs: ['-NoProfile', '-Command'],
    }),
    []
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    focus: true,
    panel: vscode.TaskPanelKind.New,
    showReuseMessage: false,
  };
  const completion = vscode.tasks.onDidEndTask((event) => {
    if (event.execution.task.definition.id !== id) return;
    completion.dispose();
    void Promise.resolve()
      .then(onFinish)
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejections can contain any value; narrow before logging.
      .catch((err: unknown) => {
        logger.warn(
          `Failed to finish Windows OpenCode CLI update: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  });
  try {
    await vscode.tasks.executeTask(task);
  } catch (err) {
    completion.dispose();
    throw err;
  }
}
