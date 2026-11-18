import { createEffect, createSignal } from 'solid-js';
import type { SessionStatus } from '../types';

const BACKGROUND_PENDING_DELAY_MS = 60_000;

/** Presentation only: background waits remain busy until the server resumes or finishes them. */
export function createPendingBackgroundSessionIds(
  getStatuses: () => Record<string, SessionStatus | undefined>
) {
  const [pendingIds, setPendingIds] = createSignal<ReadonlySet<string>>(new Set());
  const observedStarts = new Map<string, number>();
  const [revision, setRevision] = createSignal(0);

  createEffect(
    () => {
      revision();
      return Object.entries(getStatuses()).flatMap(([id, status]) =>
        status?.type === 'busy' && status.background
          ? [{ id, startedAt: status.backgroundStartedAt }]
          : []
      );
    },
    (statuses) => {
      const cleanups: Array<() => void> = [];

      const now = Date.now();
      const waitingIds = new Set<string>();
      const nextPendingIds = new Set<string>();
      let nextDeadline = Infinity;
      for (const { id, startedAt: backgroundStartedAt } of statuses) {
        waitingIds.add(id);
        const startedAt = backgroundStartedAt ?? observedStarts.get(id) ?? now;
        observedStarts.set(id, startedAt);
        const deadline = startedAt + BACKGROUND_PENDING_DELAY_MS;
        if (deadline <= now) nextPendingIds.add(id);
        else nextDeadline = Math.min(nextDeadline, deadline);
      }
      for (const id of observedStarts.keys()) {
        if (!waitingIds.has(id)) observedStarts.delete(id);
      }
      setPendingIds((previous) =>
        previous.size === nextPendingIds.size && [...previous].every((id) => nextPendingIds.has(id))
          ? previous
          : nextPendingIds
      );
      if (nextDeadline !== Infinity) {
        const timer = setTimeout(() => setRevision((value) => value + 1), nextDeadline - now);
        cleanups.push(() => clearTimeout(timer));
      }

      return () => {
        for (const cleanup of cleanups.toReversed()) cleanup();
      };
    }
  );

  return pendingIds;
}
