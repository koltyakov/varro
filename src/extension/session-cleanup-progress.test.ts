/* oxlint-disable anti-slop/no-module-mocking -- Capture persistent phase logs while exercising real deadlines and cancellation signals. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionCleanupProgress } from './session-cleanup-progress';
import type * as vscode from 'vscode';

const logs = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock('./logger', () => ({ logger: logs }));
const monitors: SessionCleanupProgress[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.dispose();
  vi.useRealTimers();
});

function fixture() {
  const report = vi.fn();
  const listeners = new Set<() => void>();
  let cancelled = false;
  const token: vscode.CancellationToken = {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested: (listener) => {
      const cancel = () => listener(undefined);
      listeners.add(cancel);
      return {
        dispose: () => {
          listeners.delete(cancel);
        },
      };
    },
  };
  const monitor = new SessionCleanupProgress({ report }, token, 297);
  monitors.push(monitor);
  return {
    monitor,
    report,
    cancel: () => {
      cancelled = true;
      for (const listener of listeners) listener();
    },
  };
}

describe('cleanup progress and read deadlines', () => {
  it('reports immediately and keeps low-level checks out of the notification during a wait', async () => {
    const f = fixture();
    expect(f.report).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '1/3 Sessions: 0/297 checked · 0 deleted · 0s',
      })
    );
    f.monitor.setPhase('Checking shells 2/4 for ses_oldest', 'Waiting for server');
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.report.mock.calls.at(-1)?.[0].message).toContain(
      '1/3 Sessions: 0/297 checked · 0 deleted · Waiting for server · 5s'
    );
    expect(f.report.mock.calls.at(-1)?.[0].message).not.toContain('ses_oldest');
    expect(logs.info).toHaveBeenCalledWith(
      'Still working: Checking shells 2/4 for ses_oldest (5s).'
    );
  });

  it('coalesces rapid internal operations into one readable update per second', async () => {
    const f = fixture();
    for (let index = 0; index < 1000; index++)
      f.monitor.setPhase(`Checking child sessions for ses_${index}`);
    f.monitor.checked = 26;
    f.monitor.deleted = 25;
    expect(f.report).toHaveBeenCalledOnce();
    expect(logs.info).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.report).toHaveBeenCalledTimes(2);
    expect(f.report.mock.calls.at(-1)?.[0].message).toBe(
      '1/3 Sessions: 26/297 checked · 25 deleted · 1s'
    );
    expect(logs.info).toHaveBeenCalledOnce();
  });

  it('keeps reference scans and file removal as separate stages with meaningful units', async () => {
    const f = fixture();
    f.monitor.checked = 297;
    f.monitor.deleted = 296;
    f.monitor.startReferenceCheck(2210);
    f.monitor.referenceProgress(
      'Checked artifact references in 1,750,623 rows; 876 names unresolved',
      1_750_623
    );
    await vi.advanceTimersByTimeAsync(97_000);
    expect(f.report.mock.calls.at(-1)?.[0].message).toBe(
      '2/3 Checking shared files · 1,750,623 records scanned · 1m 37s'
    );
    expect(f.report.mock.calls.at(-1)?.[0].message).not.toContain('unresolved');
    f.monitor.startFileCleanup();
    f.monitor.recovered = 824;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.report.mock.calls.at(-1)?.[0].message).toBe(
      '3/3 Cleaning unused files · 824/2,210 sessions · 1m 38s'
    );
  });

  it('logs periodic summaries, kept-session reasons, and one clear ending without JSON dumps', async () => {
    const f = fixture();
    f.monitor.keep('ses_kept', 'tree has queued inputs');
    f.monitor.checked = 297;
    f.monitor.deleted = 296;
    for (let index = 0; index < 100; index++) f.monitor.setPhase(`Fast operation ${index}`);
    await vi.advanceTimersByTimeAsync(20_000);
    f.monitor.finish('complete');
    expect(logs.info).toHaveBeenCalledWith('Kept ses_kept: tree has queued inputs.');
    expect(logs.info).toHaveBeenCalledWith(
      'Cleanup complete in 20s. Sessions: 297/297 checked, 296 deleted, 1 kept.'
    );
    expect(logs.info.mock.calls.length).toBeLessThan(10);
    expect(logs.info.mock.calls.every((call) => call.length === 1)).toBe(true);
    const reports = f.report.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.report).toHaveBeenCalledTimes(reports);
  });

  it('bounds a read that ignores its AbortSignal and ignores a late result', async () => {
    const f = fixture();
    let release = (_value: string) => {};
    const request = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          release = resolve;
        })
    );
    const operation = f.monitor.read('Checking metadata for oldest', request);
    const rejected = expect(operation).rejects.toThrow(
      'timed out after 30 seconds: Checking metadata for oldest'
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(request.mock.calls[0]?.[0].aborted).toBe(true);
    release('late');
    await vi.advanceTimersByTimeAsync(0);
  });

  it('cancels an in-flight validation read without waiting for transport admission', async () => {
    const f = fixture();
    const operation = f.monitor.read(
      'Checking active sessions',
      () => new Promise<never>(() => {})
    );
    const rejected = expect(operation).rejects.toThrow();
    f.cancel();
    await rejected;
    expect(f.monitor.signal.aborted).toBe(true);
  });

  it('does not interrupt confirmation of an already-dispatched deletion when Cancel is clicked', async () => {
    const f = fixture();
    f.monitor.deleting = true;
    let release = (_value: boolean) => {};
    const request = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        })
    );
    const operation = f.monitor.read('Confirming deletion of oldest', request);
    await vi.advanceTimersByTimeAsync(0);
    f.cancel();
    expect(request.mock.calls[0]?.[0].aborted).toBe(false);
    expect(f.report.mock.calls.at(-1)?.[0].message).toContain(
      'Finishing current deletion before stopping'
    );
    release(true);
    await expect(operation).resolves.toBe(true);
  });
});
