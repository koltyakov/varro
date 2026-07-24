import type { Session } from '../types';
import type { UsageLimitNotice } from './usage-limit';

type SessionUsageLimitMap = Record<string, UsageLimitNotice | null>;

export function collectSessionTreeIds(rootId: string | null | undefined, sessions: Session[]) {
  if (!rootId) return [];

  const childrenByParent = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.parentID) continue;
    const children = childrenByParent.get(session.parentID);
    if (children) children.push(session.id);
    else childrenByParent.set(session.parentID, [session.id]);
  }

  const visited = new Set<string>();
  const pending = [rootId];

  while (pending.length > 0) {
    const currentId = pending.pop();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);

    for (const childId of childrenByParent.get(currentId) || []) {
      pending.push(childId);
    }
  }

  return [...visited];
}

export function createSessionTreeIndex() {
  let indexVersion = 0;
  let indexedVersion = -1;
  let sessionTreeIdsBySession: Map<string, string[]> = new Map();
  let nearestPrimarySessionById: Map<string, string> = new Map();
  let activeUsageLimitByRoot: Map<string, UsageLimitNotice | null> = new Map();
  let indexedSessionsRef: Session[] | null = null;
  let indexedUsageLimitsRef: SessionUsageLimitMap | null = null;

  function ensureIndex(sessions: Session[], usageLimits: SessionUsageLimitMap) {
    if (
      indexedVersion === indexVersion &&
      indexedSessionsRef === sessions &&
      indexedUsageLimitsRef === usageLimits
    ) {
      return;
    }

    const childrenByParent = new Map<string, string[]>();
    nearestPrimarySessionById = new Map();

    for (const session of sessions) {
      if (!session.parentID) continue;
      const children = childrenByParent.get(session.parentID);
      if (children) children.push(session.id);
      else childrenByParent.set(session.parentID, [session.id]);
    }

    const primarySessions = sessions.filter((session) => !session.parentID);
    if (primarySessions.length === 0) {
      sessionTreeIdsBySession = new Map();
      activeUsageLimitByRoot = new Map();
      for (const session of sessions) {
        nearestPrimarySessionById.set(session.id, session.id);
        sessionTreeIdsBySession.set(session.id, [session.id]);
        activeUsageLimitByRoot.set(session.id, usageLimits[session.id] || null);
      }
      indexedVersion = indexVersion;
      indexedSessionsRef = sessions;
      indexedUsageLimitsRef = usageLimits;
      return;
    }

    sessionTreeIdsBySession = new Map();

    const collectIndexedTreeIds = (
      sessionId: string,
      rootId: string,
      visited: Set<string>
    ): string[] => {
      if (visited.has(sessionId)) return [];
      visited.add(sessionId);
      nearestPrimarySessionById.set(sessionId, rootId);

      const treeIds = [sessionId];
      const children = childrenByParent.get(sessionId) || [];
      for (const childId of children) {
        treeIds.push(...collectIndexedTreeIds(childId, rootId, visited));
      }

      sessionTreeIdsBySession.set(sessionId, treeIds);
      return treeIds;
    };

    for (const root of primarySessions) {
      collectIndexedTreeIds(root.id, root.id, new Set());
    }

    activeUsageLimitByRoot = new Map();
    for (const root of primarySessions) {
      const treeIds = sessionTreeIdsBySession.get(root.id) || [root.id];
      const activeNotice = treeIds.map((id) => usageLimits[id] || null).find((notice) => !!notice);
      activeUsageLimitByRoot.set(root.id, activeNotice || null);
    }

    indexedVersion = indexVersion;
    indexedSessionsRef = sessions;
    indexedUsageLimitsRef = usageLimits;
  }

  return {
    invalidate() {
      indexVersion++;
    },

    getTreeIds(
      rootId: string | null | undefined,
      sessions: Session[],
      usageLimits: SessionUsageLimitMap
    ) {
      if (!rootId) return [];
      ensureIndex(sessions, usageLimits);
      return [...(sessionTreeIdsBySession.get(rootId) || [rootId])];
    },

    getRootId(
      sessionId: string | null | undefined,
      sessions: Session[],
      usageLimits: SessionUsageLimitMap
    ) {
      if (!sessionId) return null;
      ensureIndex(sessions, usageLimits);
      return nearestPrimarySessionById.get(sessionId) || sessionId;
    },

    getActiveUsageLimitNotice(
      sessionId: string | null | undefined,
      sessions: Session[],
      usageLimits: SessionUsageLimitMap
    ) {
      if (!sessionId) return null;
      ensureIndex(sessions, usageLimits);
      const rootId = nearestPrimarySessionById.get(sessionId) || sessionId;
      return activeUsageLimitByRoot.get(rootId) || null;
    },
  };
}
