import type { ServerEvent } from '../shared/protocol';

// Cover queued helper events without retaining IDs forever when deletion events are missed.
const DELETION_TOMBSTONE_TTL_MS = 30_000;
const DELETION_TOMBSTONE_LIMIT = 256;

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
    if (!id || !title || !this.pendingTitles.has(title)) return;
    this.hide(id);
  }

  filterVisibleSessions<T extends { id: string }>(sessions: T[]) {
    return sessions.filter((session) => !this.isHidden(session.id));
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
