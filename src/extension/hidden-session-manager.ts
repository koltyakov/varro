import type { ServerEvent } from '../shared/protocol';

export const PERMISSION_JUDGE_SESSION_TITLE_PREFIX = 'Varro permission judge: ';
export const PERMISSION_JUDGE_SESSION_METADATA = { varroInternal: 'permission-judge' } as const;

// Cover queued helper events without retaining IDs forever when deletion events are missed.
const DELETION_TOMBSTONE_TTL_MS = 30_000;
const DELETION_TOMBSTONE_LIMIT = 256;
const PERMISSION_JUDGE_STALE_AFTER_MS = 2 * 60_000;

type SessionSnapshot = {
  id: string;
  title?: unknown;
  metadata?: unknown;
  time?: unknown;
};

function isPermissionJudgeSession(session: SessionSnapshot) {
  const metadata =
    session.metadata && typeof session.metadata === 'object'
      ? (session.metadata as Record<string, unknown>)
      : null;
  return (
    metadata?.varroInternal === PERMISSION_JUDGE_SESSION_METADATA.varroInternal ||
    (typeof session.title === 'string' &&
      session.title.startsWith(PERMISSION_JUDGE_SESSION_TITLE_PREFIX))
  );
}

export class HiddenSessionManager {
  private readonly hiddenIds = new Set<string>();
  private readonly pendingTitles = new Set<string>();
  private readonly deletionTombstones = new Map<string, ReturnType<typeof setTimeout>>();

  registerPendingTitle(title: string) {
    if (title) this.pendingTitles.add(title);
  }

  forgetPendingTitle(title: string) {
    this.pendingTitles.delete(title);
  }

  hide(sessionID: string | null | undefined) {
    if (sessionID) this.hiddenIds.add(sessionID);
  }

  unhide(sessionID: string | null | undefined) {
    if (!sessionID) return;
    this.hiddenIds.delete(sessionID);
    this.clearDeletionTombstone(sessionID);
  }

  retainUntilDeleted(sessionID: string | null | undefined) {
    if (!sessionID || !this.hiddenIds.has(sessionID)) return;
    this.clearDeletionTombstone(sessionID);
    while (this.deletionTombstones.size >= DELETION_TOMBSTONE_LIMIT) {
      const oldest = this.deletionTombstones.keys().next().value;
      if (!oldest) break;
      this.unhide(oldest);
    }

    const timeout = setTimeout(() => {
      if (this.deletionTombstones.get(sessionID) !== timeout) return;
      this.deletionTombstones.delete(sessionID);
      this.hiddenIds.delete(sessionID);
    }, DELETION_TOMBSTONE_TTL_MS);
    this.deletionTombstones.set(sessionID, timeout);
  }

  isHidden(sessionID: string | null | undefined) {
    return !!sessionID && this.hiddenIds.has(sessionID);
  }

  hiddenSessionIds() {
    return new Set(this.hiddenIds);
  }

  observeSessionList(sessions: SessionSnapshot[], now = Date.now()) {
    const stalePermissionJudgeIds: string[] = [];
    for (const session of sessions) {
      if (!isPermissionJudgeSession(session)) continue;
      this.hide(session.id);
      const time =
        session.time && typeof session.time === 'object'
          ? (session.time as Record<string, unknown>)
          : null;
      const updatedAt =
        typeof time?.updated === 'number'
          ? time.updated
          : typeof time?.created === 'number'
            ? time.created
            : null;
      if (
        (typeof session.title !== 'string' || !this.pendingTitles.has(session.title)) &&
        updatedAt !== null &&
        now - updatedAt >= PERMISSION_JUDGE_STALE_AFTER_MS
      ) {
        stalePermissionJudgeIds.push(session.id);
      }
    }
    return stalePermissionJudgeIds;
  }

  observeEvent(event: ServerEvent) {
    if (event.type === 'session.deleted') {
      const id = event.properties?.info?.id || event.properties?.sessionID;
      this.unhide(id);
      return;
    }
    if (event.type !== 'session.created' && event.type !== 'session.updated') return;
    const info = event.properties?.info;
    const id = typeof info?.id === 'string' ? info.id : event.properties?.sessionID;
    const title = typeof info?.title === 'string' ? info.title : null;
    if (
      !id ||
      (!isPermissionJudgeSession({ id, title, metadata: info?.metadata }) &&
        (!title || !this.pendingTitles.has(title)))
    ) {
      return;
    }
    this.hide(id);
  }

  filterVisibleSessions<T extends SessionSnapshot>(sessions: T[]) {
    return sessions.filter((session) => {
      if (isPermissionJudgeSession(session)) this.hide(session.id);
      return !this.isHidden(session.id);
    });
  }

  filterVisibleSessionStatuses<T>(statuses: Record<string, T>) {
    return Object.fromEntries(
      Object.entries(statuses).filter(([sessionID]) => !this.isHidden(sessionID))
    ) as Record<string, T>;
  }

  filterVisibleSessionRequests<T extends { sessionID: string }>(items: T[]) {
    return items.filter((item) => !this.isHidden(item.sessionID));
  }

  private clearDeletionTombstone(sessionID: string) {
    const timeout = this.deletionTombstones.get(sessionID);
    if (timeout !== undefined) clearTimeout(timeout);
    this.deletionTombstones.delete(sessionID);
  }
}
