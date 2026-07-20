import type { ChildProcess } from 'child_process';
import type { ServerStatus } from '../shared/protocol';

export function isPortInUseMessage(text: string): boolean {
  return /\bEADDRINUSE\b|address already in use|port .* (already )?in use|only one usage of each socket address/i.test(
    text
  );
}

export function normalizeRunningStatus(next: ServerStatus, previous: ServerStatus): ServerStatus {
  if (next.state !== 'running') return next;
  if (next.eventStream) return next;
  if (previous.state !== 'running') return { ...next, eventStream: 'healthy' };
  return { ...next, eventStream: previous.eventStream || 'healthy' };
}

const SSE_CHUNK_BOUNDARY_RE = /\r\n\r\n|\n\n|\r\r|\r\n\n|\n\r\n/g;

export function findSseChunkBoundary(
  buffer: string,
  fromIndex: number
): { index: number; length: number } | null {
  SSE_CHUNK_BOUNDARY_RE.lastIndex = fromIndex;
  const match = SSE_CHUNK_BOUNDARY_RE.exec(buffer);
  if (!match) return null;
  return { index: match.index, length: match[0].length };
}

export function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      proc.off('exit', handleExit);
      resolve(result);
    };

    const handleExit = () => finish(true);
    proc.once('exit', handleExit);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

export function anySignal(...signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(signals);
  }
  const controller = new AbortController();
  const onAbort = (event: Event) => {
    controller.abort((event.target as AbortSignal | null)?.reason);
    for (const signal of signals) {
      signal.removeEventListener('abort', onAbort);
    }
  };

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return controller.signal;
}

export function extractVersion(value: string): string | null {
  const match = value.trim().match(/\d+(?:\.\d+)+/);
  return match ? match[0] : null;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
