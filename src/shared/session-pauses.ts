/* oxlint-disable anti-slop/no-unknown-parameters -- Pause annotations are decoded from persisted session metadata. */
import { asRecord, isNumber, isString } from './type-utils';

export type SessionPauseBoundary = { messageId: string; pausedAt: number };

// Persist the action marker with the prompt so it stays hidden after history reloads.
export const SESSION_RESUME_PROMPT =
  '[Varro session resume]\nContinue where you left off. Do not repeat completed work.';

export function isSessionResumeMessage(parts: readonly { type: string; text?: string }[]): boolean {
  return parts.some((part) => part.type === 'text' && part.text === SESSION_RESUME_PROMPT);
}

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
