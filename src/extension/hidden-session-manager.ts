import type { ServerEvent } from '../shared/protocol';

export class HiddenSessionManager {
  private readonly hiddenIds = new Set<string>();
  private readonly pendingTitles = new Set<string>();

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
    if (sessionID) this.hiddenIds.delete(sessionID);
  }

  isHidden(sessionID: string | null | undefined) {
    return !!sessionID && this.hiddenIds.has(sessionID);
  }

  hiddenSessionIds() {
    return new Set(this.hiddenIds);
  }

  observeEvent(event: ServerEvent) {
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
}
