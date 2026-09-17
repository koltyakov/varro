/* oxlint-disable anti-slop/no-module-mocking -- Model VS Code task completion without launching an actual CLI update. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  end: vi.fn<(listener: (event: vscode.TaskEndEvent) => void) => vscode.Disposable>(),
  execute: vi.fn(),
  dispose: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('vscode', () => ({
  Task: class {
    presentationOptions = {};
    constructor(
      readonly definition: vscode.TaskDefinition,
      readonly scope: vscode.TaskScope,
      readonly name: string,
      readonly source: string,
      readonly execution: vscode.ShellExecution
    ) {}
  },
  ShellExecution: class {
    constructor(
      readonly commandLine: string,
      readonly options: vscode.ShellExecutionOptions
    ) {}
  },
  TaskScope: { Workspace: 2 },
  TaskRevealKind: { Always: 1 },
  TaskPanelKind: { New: 2 },
  tasks: { onDidEndTask: mocks.end, executeTask: mocks.execute },
}));
vi.mock('../logger', () => ({ logger: { warn: mocks.warn } }));

import { runWindowsCliUpdate } from './windows-cli-update';

describe('Windows CLI update tasks', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.end.mockReturnValue({ dispose: mocks.dispose });
    mocks.execute.mockResolvedValue(undefined);
  });

  it('finishes only the matching task without waiting for the terminal to close', async () => {
    const finish = vi.fn();
    await runWindowsCliUpdate(
      "& 'C:\\Program Files\\OpenCode\\opencode2.exe' upgrade 2.0.7",
      'OpenCode Upgrade',
      'C:\\repo',
      finish
    );
    const task: vscode.Task = mocks.execute.mock.calls[0]![0];
    const listener = mocks.end.mock.calls[0]![0];
    expect(task.execution).toMatchObject({
      commandLine: "& 'C:\\Program Files\\OpenCode\\opencode2.exe' upgrade 2.0.7",
      options: {
        cwd: 'C:\\repo',
        executable: 'powershell.exe',
        shellArgs: ['-NoProfile', '-Command'],
      },
    });
    listener({
      execution: { task: { ...task, definition: { type: 'other' } }, terminate: vi.fn() },
    });
    await Promise.resolve();
    expect(finish).not.toHaveBeenCalled();
    listener({ execution: { task, terminate: vi.fn() } });
    await Promise.resolve();
    expect(finish).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('cleans up the completion listener if VS Code cannot start the task', async () => {
    const finish = vi.fn();
    mocks.execute.mockRejectedValue(new Error('Task launch failed'));
    await expect(
      runWindowsCliUpdate('opencode2 upgrade', 'Update', undefined, finish)
    ).rejects.toThrow('Task launch failed');
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(finish).not.toHaveBeenCalled();
  });
});
