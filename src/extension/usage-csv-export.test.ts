/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Mock VS Code and worker replies; file-destination safety uses real isolated files. */
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerOptions } from 'node:worker_threads';
import { UsageReportService } from './usage-report-service';

type CsvCancellationState = { cancelled: boolean; handler: (() => void) | undefined };
const cancellation = vi.hoisted((): CsvCancellationState => ({
  cancelled: false,
  handler: undefined,
}));

const ui = vi.hoisted(() => ({
  save: vi.fn<() => Promise<{ scheme: string; fsPath: string } | undefined>>(async () => undefined),
  write: vi.fn(async (_uri: unknown, _bytes: Uint8Array) => undefined),
  info: vi.fn(),
  error: vi.fn(),
  report: vi.fn(),
  progressOptions: vi.fn(),
  disposeCancellation: vi.fn(),
}));
type CsvWorkerState = {
  reply: { csv: string | null; rowCount: number } | { error: string } | null;
  tasks: WorkerOptions[];
  cancelOnStart: boolean;
  terminate: () => Promise<number>;
};
const workerState = vi.hoisted((): CsvWorkerState => ({
  reply: { csv: '\uFEFFheader\r\nrow\r\n', rowCount: 1 },
  tasks: [],
  cancelOnStart: false,
  terminate: vi.fn(async () => 0),
}));
vi.mock('node:worker_threads', () => ({
  Worker: class {
    private readonly listeners = new Map<string, (value: unknown) => void>();
    constructor(_source: string, options: WorkerOptions) {
      workerState.tasks.push(options);
      queueMicrotask(() => {
        if (workerState.cancelOnStart) {
          cancellation.cancelled = true;
          cancellation.handler?.();
        }
        this.listeners.get('message')?.(workerState.reply);
      });
    }
    on(event: string, listener: (value: unknown) => void) {
      this.listeners.set(event, listener);
      return this;
    }
    once(event: string, listener: (value: unknown) => void) {
      this.listeners.set(event, listener);
      return this;
    }
    async terminate() {
      return workerState.terminate();
    }
  },
}));
vi.mock('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
  workspace: { fs: { writeFile: ui.write } },
  window: {
    showSaveDialog: ui.save,
    showInformationMessage: ui.info,
    showErrorMessage: ui.error,
    withProgress: async (
      options: unknown,
      task: (
        progress: { report: typeof ui.report },
        token: {
          isCancellationRequested: boolean;
          onCancellationRequested: (listener: () => void) => { dispose: () => void };
        }
      ) => Promise<unknown>
    ) => {
      ui.progressOptions(options);
      return task(
        { report: ui.report },
        {
          get isCancellationRequested() {
            return cancellation.cancelled;
          },
          onCancellationRequested: (listener) => {
            cancellation.handler = listener;
            return {
              dispose: () => {
                cancellation.handler = undefined;
                ui.disposeCancellation();
              },
            };
          },
        }
      );
    },
  },
}));

let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
  workerState.tasks = [];
  workerState.cancelOnStart = false;
  cancellation.cancelled = false;
  cancellation.handler = undefined;
  workerState.reply = { csv: '\uFEFFheader\r\nrow\r\n', rowCount: 1 };
  const parent = resolve('artifacts/ai-test-data');
  await mkdir(parent, { recursive: true });
  root = await mkdtemp(join(parent, 'usage-csv-ui-'));
  vi.stubEnv('OPENCODE_DB', join(root, 'opencode.db'));
  vi.stubEnv('VARRO_TEST_STATE_ROOT', join(root, 'state'));
  ui.save.mockResolvedValue({ scheme: 'file', fsPath: join(root, 'usage.csv') });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function fixture() {
  const request = vi.fn();
  const start = vi.fn();
  const server = { request, isAttachOnly: false };
  return { service: new UsageReportService(server, start), request, start, server };
}

describe('usage CSV save workflow', () => {
  it('saves UTF-8 CSV from one all-time worker without starting the server or downloading history', async () => {
    const f = fixture();
    const first = f.service.exportCsv();
    expect(f.service.exportCsv()).toBe(first);
    await first;
    expect(ui.save).toHaveBeenCalledOnce();
    expect(ui.progressOptions).toHaveBeenCalledWith(expect.objectContaining({ cancellable: true }));
    expect(ui.save).toHaveBeenCalledWith(expect.objectContaining({ filters: { CSV: ['csv'] } }));
    expect(workerState.tasks).toHaveLength(1);
    expect(workerState.tasks[0]?.workerData).toMatchObject({
      exportCsv: true,
      start: null,
      windows: [],
    });
    expect(ui.write).toHaveBeenCalledWith(
      { scheme: 'file', fsPath: join(root, 'usage.csv') },
      new TextEncoder().encode('\uFEFFheader\r\nrow\r\n')
    );
    expect(ui.info).toHaveBeenCalledWith(
      expect.stringContaining('Exported 1 daily OpenCode usage rows')
    );
    expect(f.request).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  it('does nothing when the save dialog is cancelled', async () => {
    ui.save.mockResolvedValue(undefined);
    await fixture().service.exportCsv();
    expect(workerState.tasks).toEqual([]);
    expect(ui.write).not.toHaveBeenCalled();
  });

  it('cancels a running CSV worker without saving a late result or displaying an error', async () => {
    workerState.cancelOnStart = true;
    const output = join(root, 'usage.csv');
    await writeFile(output, 'Keep existing content');
    await fixture().service.exportCsv();
    expect(workerState.terminate).toHaveBeenCalledOnce();
    expect(ui.disposeCancellation).toHaveBeenCalledOnce();
    expect(ui.write).not.toHaveBeenCalled();
    expect(ui.error).not.toHaveBeenCalled();
    expect(ui.info).not.toHaveBeenCalled();
    expect(await readFile(output, 'utf8')).toBe('Keep existing content');
  });

  it('does not start a worker when progress is already cancelled', async () => {
    cancellation.cancelled = true;
    await fixture().service.exportCsv();
    expect(workerState.tasks).toEqual([]);
    expect(ui.write).not.toHaveBeenCalled();
    expect(ui.error).not.toHaveBeenCalled();
    expect(ui.disposeCancellation).toHaveBeenCalledOnce();
  });

  it('refuses attach-only connections rather than exporting unrelated local data', async () => {
    const f = fixture();
    f.server.isAttachOnly = true;
    await expect(f.service.exportCsv()).rejects.toThrow('server host');
    expect(ui.save).not.toHaveBeenCalled();
    expect(workerState.tasks).toEqual([]);
    expect(ui.error).toHaveBeenCalledWith(expect.stringContaining('attach-only'));
  });

  it.each([{ error: 'Database query failed' }, null, { rowCount: 1, csv: null }])(
    'never overwrites a file after a failed or malformed query %#',
    async (reply) => {
      workerState.reply = reply;
      const output = join(root, 'usage.csv');
      await writeFile(output, 'Keep existing content');
      await expect(fixture().service.exportCsv()).rejects.toThrow();
      expect(ui.write).not.toHaveBeenCalled();
      expect(await readFile(output, 'utf8')).toBe('Keep existing content');
      expect(ui.error).toHaveBeenCalledOnce();
      expect(ui.info).not.toHaveBeenCalled();
    }
  );

  it('reports a destination write failure without claiming success', async () => {
    ui.write.mockRejectedValueOnce(new Error('Disk full'));
    await expect(fixture().service.exportCsv()).rejects.toThrow('Disk full');
    expect(ui.error).toHaveBeenCalledWith(expect.stringContaining('Disk full'));
    expect(ui.info).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a custom OpenCode database even if its filename ends in .csv', async () => {
    const databasePath = join(root, 'custom.csv');
    vi.stubEnv('OPENCODE_DB', databasePath);
    await writeFile(databasePath, 'Original database');
    ui.save.mockResolvedValue({ scheme: 'file', fsPath: databasePath });
    await expect(fixture().service.exportCsv()).rejects.toThrow('must not overwrite');
    expect(await readFile(databasePath, 'utf8')).toBe('Original database');
    expect(workerState.tasks).toEqual([]);
    expect(ui.write).not.toHaveBeenCalled();
  });

  it('refuses a hard-linked CSV alias of the statistics archive', async () => {
    const archive = join(root, 'opencode-stats.db');
    await writeFile(archive, 'Original usage archive');
    await link(archive, join(root, 'usage.csv'));
    await expect(fixture().service.exportCsv()).rejects.toThrow('refers to an OpenCode database');
    expect(await readFile(archive, 'utf8')).toBe('Original usage archive');
    expect(ui.write).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked CSV destination', async () => {
    const source = join(root, 'opencode.db');
    await writeFile(source, 'Original database');
    await symlink(source, join(root, 'usage.csv'));
    await expect(fixture().service.exportCsv()).rejects.toThrow('not a symlink');
    expect(await readFile(source, 'utf8')).toBe('Original database');
    expect(ui.write).not.toHaveBeenCalled();
  });

  it('requires a .csv destination instead of permitting database filenames', async () => {
    ui.save.mockResolvedValue({ scheme: 'file', fsPath: join(root, 'opencode-transcripts.db') });
    await expect(fixture().service.exportCsv()).rejects.toThrow('local .csv file');
    expect(workerState.tasks).toEqual([]);
    expect(ui.write).not.toHaveBeenCalled();
  });
});
