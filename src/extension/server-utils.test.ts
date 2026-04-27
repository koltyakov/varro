import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  anySignal,
  asRecord,
  compareVersions,
  extractVersion,
  findSseChunkBoundary,
  getString,
  isPortInUseMessage,
  normalizeRunningStatus,
  waitForProcessExit,
} from './server-utils';

type MutableTestProcess = ChildProcess & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

describe('server utils', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('detects port-in-use errors and normalizes running status', () => {
    expect(isPortInUseMessage('listen EADDRINUSE: address already in use')).toBe(true);
    expect(isPortInUseMessage('different error')).toBe(false);

    expect(
      normalizeRunningStatus(
        { state: 'running', url: 'http://127.0.0.1:4096' },
        { state: 'stopped' }
      )
    ).toEqual({
      state: 'running',
      url: 'http://127.0.0.1:4096',
      eventStream: 'healthy',
    });

    expect(
      normalizeRunningStatus(
        { state: 'running', url: 'http://127.0.0.1:4096' },
        { state: 'running', url: 'http://127.0.0.1:4096', eventStream: 'degraded' }
      )
    ).toEqual({
      state: 'running',
      url: 'http://127.0.0.1:4096',
      eventStream: 'degraded',
    });
  });

  it('finds SSE chunk boundaries and compares versions', () => {
    expect(findSseChunkBoundary('data: one\n\ndata: two', 0)).toEqual({ index: 9, length: 2 });
    expect(findSseChunkBoundary('data: one\r\n\r\n', 0)).toEqual({ index: 9, length: 4 });
    expect(findSseChunkBoundary('data: one', 0)).toBeNull();

    expect(extractVersion('opencode 1.2.3')).toBe('1.2.3');
    expect(extractVersion('missing')).toBeNull();
    expect(compareVersions('1.2.3', '1.2.2')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '1.2')).toBe(0);
    expect(compareVersions('1.2.0', '1.3.0')).toBeLessThan(0);
  });

  it('coerces records and strings', () => {
    expect(asRecord({ ok: true })).toEqual({ ok: true });
    expect(asRecord(null)).toBeNull();
    expect(getString('value')).toBe('value');
    expect(getString(1)).toBeUndefined();
  });

  it('waits for process exit or timeout and merges abort signals', async () => {
    vi.useFakeTimers();

    const proc = new EventEmitter() as MutableTestProcess;
    proc.exitCode = null;
    proc.signalCode = null;
    const exitPromise = waitForProcessExit(proc, 1000);
    proc.emit('exit', 0, null);
    await expect(exitPromise).resolves.toBe(true);

    const pendingProc = new EventEmitter() as MutableTestProcess;
    pendingProc.exitCode = null;
    pendingProc.signalCode = null;
    const timeoutPromise = waitForProcessExit(pendingProc, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(timeoutPromise).resolves.toBe(false);

    const first = new AbortController();
    const second = new AbortController();
    const combined = anySignal(first.signal, second.signal);
    second.abort(new Error('stop'));
    expect(combined.aborted).toBe(true);
  });
});
