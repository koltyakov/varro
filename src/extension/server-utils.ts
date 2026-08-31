/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- These helpers validate JavaScript and network boundary values. */
import type { ChildProcess } from 'child_process';
import type { ServerStatus } from '../shared/protocol';

export { asRecord } from '../shared/type-utils';

export function isPortInUseMessage(text: string): boolean {
  return /\bEADDRINUSE\b|address already in use|port .* (already )?in use|only one usage of each socket address/i.test(
    text
  );
}

export function normalizeRunningStatus(next: ServerStatus, previous: ServerStatus): ServerStatus {
  if (next.state !== 'running') return next;
  if (next.eventStream) return next;
  if (previous.state !== 'running') return { ...next, eventStream: 'degraded' };
  return { ...next, eventStream: previous.eventStream || 'degraded' };
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
  return AbortSignal.any(signals);
}

export function extractVersion(value: string): string | null {
  const match = value
    .trim()
    .match(
      /\d+(?:\.\d+)+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/
    );
  return match ? match[0] : null;
}

function compareNumericIdentifiers(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, '');
  const normalizedRight = right.replace(/^0+(?=\d)/, '');
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  }
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

export function compareVersions(left: string, right: string): number {
  const leftBuildIndex = left.indexOf('+');
  const rightBuildIndex = right.indexOf('+');
  const leftWithoutBuild = leftBuildIndex === -1 ? left : left.slice(0, leftBuildIndex);
  const rightWithoutBuild = rightBuildIndex === -1 ? right : right.slice(0, rightBuildIndex);
  const leftPrereleaseIndex = leftWithoutBuild.indexOf('-');
  const rightPrereleaseIndex = rightWithoutBuild.indexOf('-');
  const leftRelease =
    leftPrereleaseIndex === -1 ? leftWithoutBuild : leftWithoutBuild.slice(0, leftPrereleaseIndex);
  const rightRelease =
    rightPrereleaseIndex === -1
      ? rightWithoutBuild
      : rightWithoutBuild.slice(0, rightPrereleaseIndex);
  const leftPrerelease =
    leftPrereleaseIndex === -1 ? undefined : leftWithoutBuild.slice(leftPrereleaseIndex + 1);
  const rightPrerelease =
    rightPrereleaseIndex === -1 ? undefined : rightWithoutBuild.slice(rightPrereleaseIndex + 1);
  const leftParts = leftRelease.split('.');
  const rightParts = rightRelease.split('.');
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = compareNumericIdentifiers(leftParts[index] ?? '0', rightParts[index] ?? '0');
    if (difference !== 0) {
      return difference;
    }
  }

  if (leftPrerelease === undefined || rightPrerelease === undefined) {
    if (leftPrerelease === rightPrerelease) return 0;
    return leftPrerelease === undefined ? 1 : -1;
  }

  const leftIdentifiers = leftPrerelease.split('.');
  const rightIdentifiers = rightPrerelease.split('.');
  const prereleaseLength = Math.max(leftIdentifiers.length, rightIdentifiers.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftIdentifier = leftIdentifiers[index];
    const rightIdentifier = rightIdentifiers[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) continue;

    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifiers(leftIdentifier, rightIdentifier);
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }

  return 0;
}

export function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
