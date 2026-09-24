/* oxlint-disable anti-slop/no-unknown-parameters -- Pause annotations are decoded from persisted session metadata. */
import { asRecord, isNumber, isString } from './type-utils';

export type SessionPauseBoundary = { messageId: string; pausedAt: number };

export function readSessionPauses(metadata: unknown): SessionPauseBoundary[] {
  const entries = asRecord(asRecord(metadata)?.varro)?.pauses;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const record = asRecord(entry);
    return isString(record?.messageId) &&
      isNumber(record.pausedAt) &&
      Number.isFinite(record.pausedAt)
      ? [{ messageId: record.messageId, pausedAt: record.pausedAt }]
      : [];
  });
}

export function pauseCompletedAt(
  created: number,
  completed: number | undefined,
  pausedAt: number
): number {
  return Math.max(created, Math.min(completed ?? pausedAt, pausedAt));
}
