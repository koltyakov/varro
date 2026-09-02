/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- Persisted session metadata is validated before it enters manager state. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Persisted arrays are element-validated before restoration. */
import type { ServerEvent } from '../shared/protocol';

export const PERMISSION_JUDGE_SESSION_TITLE_PREFIX = 'Varro permission judge: ';
export const PERMISSION_JUDGE_SESSION_METADATA = { varroInternal: 'permission-judge' } as const;
export const COMMIT_MESSAGE_SESSION_TITLE_PREFIX = 'Varro commit message: ';
export const COMMIT_MESSAGE_SESSION_METADATA = { varroInternal: 'commit-message' } as const;

// Cover queued helper events without retaining IDs forever when deletion events are missed.
const DELETION_TOMBSTONE_TTL_MS = 30_000;
const DELETION_TOMBSTONE_LIMIT = 256;
const INTERNAL_SESSION_STALE_AFTER_MS = 2 * 60_000;

type SessionSnapshot = {
  id: string;
  title?: unknown;
  metadata?: unknown;
  permission?: unknown;
  time?: unknown;
};

function hasInternalHelperRules(session: SessionSnapshot) {
  const permission = session.permission;
  if (!Array.isArray(permission) || permission.length < 2) return false;
  const rules = permission.map((rule) =>
    rule && typeof rule === 'object' ? (rule as Record<string, unknown>) : null
  );
  const structuredOutput = rules.at(-1);
  if (
    structuredOutput?.permission !== 'StructuredOutput' ||
    structuredOutput.pattern !== '*' ||
    structuredOutput.action !== 'allow'
  ) {
    return false;
  }
  const deniedRules = rules.slice(0, -1);
  return (
    deniedRules.some((rule) => rule?.permission === '*') &&
    deniedRules.every(
      (rule) =>
        typeof rule?.permission === 'string' && rule.pattern === '*' && rule.action === 'deny'
    )
  );
}

function isInternalHelperSession(session: SessionSnapshot) {
  const metadata =
    session.metadata && typeof session.metadata === 'object'
      ? (session.metadata as Record<string, unknown>)
      : null;
  const title = typeof session.title === 'string' ? session.title : null;
  const hasHelperRules = hasInternalHelperRules(session);
  const commitMessageSequence = title?.startsWith(COMMIT_MESSAGE_SESSION_TITLE_PREFIX)
    ? title.slice(COMMIT_MESSAGE_SESSION_TITLE_PREFIX.length)
    : null;
  return (
    metadata?.varroInternal === PERMISSION_JUDGE_SESSION_METADATA.varroInternal ||
    metadata?.varroInternal === COMMIT_MESSAGE_SESSION_METADATA.varroInternal ||
    (title?.startsWith(PERMISSION_JUDGE_SESSION_TITLE_PREFIX) === true && hasHelperRules) ||
    (commitMessageSequence !== null &&
      /^[1-9]\d*$/.test(commitMessageSequence) &&
      (session.permission === undefined || hasHelperRules))
  );
}

export class HiddenSessionManager {
  private readonly hiddenIds = new Set<string>();
  private readonly confirmedHiddenIds = new Set<string>();
  private readonly pendingTitles = new Set<string>();
  private readonly provisionalIdsByTitle = new Map<string, Set<string>>();
  private readonly deletionTombstones = new Map<string, ReturnType<typeof setTimeout>>();

  registerPendingTitle(title: string) {
    if (title) this.pendingTitles.add(title);
  }

  forgetPendingTitle(title: string) {
    this.pendingTitles.delete(title);
    const provisionalIds = this.provisionalIdsByTitle.get(title);
    this.provisionalIdsByTitle.delete(title);
    for (const sessionID of provisionalIds ?? []) {
      const stillProvisional = [...this.provisionalIdsByTitle.values()].some((ids) =>
        ids.has(sessionID)
      );
      if (!stillProvisional) this.hiddenIds.delete(sessionID);
    }
  }

  hide(sessionID: string | null | undefined) {
    if (!sessionID) return;
    for (const [title, ids] of this.provisionalIdsByTitle) {
      ids.delete(sessionID);
      if (ids.size === 0) this.provisionalIdsByTitle.delete(title);
    }
    this.confirmedHiddenIds.add(sessionID);
    this.hiddenIds.add(sessionID);
  }

  unhide(sessionID: string | null | undefined) {
    if (!sessionID) return;
    this.hiddenIds.delete(sessionID);
    this.confirmedHiddenIds.delete(sessionID);
    for (const [title, ids] of this.provisionalIdsByTitle) {
      ids.delete(sessionID);
      if (ids.size === 0) this.provisionalIdsByTitle.delete(title);
    }
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
      this.confirmedHiddenIds.delete(sessionID);
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
    const staleInternalSessionIds: string[] = [];
    for (const session of sessions) {
      const hasPendingTitle =
        typeof session.title === 'string' && this.pendingTitles.has(session.title);
      const isInternalHelper = isInternalHelperSession(session);
      if (!isInternalHelper && !hasPendingTitle) continue;
      if (isInternalHelper) this.hide(session.id);
      else if (typeof session.title === 'string') this.hideProvisionally(session.title, session.id);
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
        !hasPendingTitle &&
        updatedAt !== null &&
        now - updatedAt >= INTERNAL_SESSION_STALE_AFTER_MS
      ) {
        staleInternalSessionIds.push(session.id);
      }
    }
    return staleInternalSessionIds;
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
    if (!id) {
      return;
    }
    const isInternalHelper = isInternalHelperSession({
      id,
      title,
      metadata: info?.metadata,
      permission: info?.permission,
    });
    if (isInternalHelper) this.hide(id);
    else if (title && this.pendingTitles.has(title)) this.hideProvisionally(title, id);
  }

  filterVisibleSessions<T extends SessionSnapshot>(sessions: T[]) {
    return sessions.filter((session) => {
      if (isInternalHelperSession(session)) this.hide(session.id);
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

  private hideProvisionally(title: string, sessionID: string) {
    if (this.confirmedHiddenIds.has(sessionID)) return;
    this.hiddenIds.add(sessionID);
    const ids = this.provisionalIdsByTitle.get(title) ?? new Set<string>();
    ids.add(sessionID);
    this.provisionalIdsByTitle.set(title, ids);
  }
}
