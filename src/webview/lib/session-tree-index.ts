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
  // A pre-order walk lays every subtree out contiguously, so each session only
  // needs a slice of its root's traversal rather than its own id list. Storing
  // a list per session costs O(n^2) on a deep chain.
  let sessionTreeSpanById: Map<string, { order: string[]; start: number; end: number }> = new Map();
  let nearestPrimarySessionById: Map<string, string> = new Map();
  let activeUsageLimitByRoot: Map<string, UsageLimitNotice | null> = new Map();
  let indexedSessionsRef: Session[] | null = null;
  let indexedUsageLimitsRef: SessionUsageLimitMap | null = null;

  function readTreeIds(sessionId: string) {
    const span = sessionTreeSpanById.get(sessionId);
    return span ? span.order.slice(span.start, span.end) : [sessionId];
  }

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
    sessionTreeSpanById = new Map();

    const sessionIds = new Set(sessions.map((session) => session.id));
    const parentById = new Map<string, string>();
    for (const session of sessions) {
      if (!session.parentID) continue;
      parentById.set(session.id, session.parentID);
      const children = childrenByParent.get(session.parentID);
      if (children) children.push(session.id);
      else childrenByParent.set(session.parentID, [session.id]);
    }

    // A session whose parent is missing from the list (hidden, trashed, scoped
    // to another workspace, or not synced yet) roots its own tree. Without this
    // it — and every descendant under it — would never be indexed at all, and
    // `getTreeIds` would silently fall back to a single-session tree.
    const rootIds = sessions
      .filter((session) => !session.parentID || !sessionIds.has(session.parentID))
      .map((session) => session.id);

    const collectIndexedTreeIds = (rootId: string) => {
      const visited = new Set<string>([rootId]);
      const ownedChildren = new Map<string, string[]>();
      const preOrder: string[] = [];
      const stack: string[] = [rootId];

      // Iterative descent: session trees are arbitrarily deep, so recursion
      // here would bound the tree depth by the JS stack.
      while (stack.length > 0) {
        const sessionId = stack.pop()!;
        preOrder.push(sessionId);
        nearestPrimarySessionById.set(sessionId, rootId);

        const owned: string[] = [];
        for (const childId of childrenByParent.get(sessionId) || []) {
          // A cycle back to an already-visited node must not re-enter it.
          if (visited.has(childId)) continue;
          visited.add(childId);
          owned.push(childId);
        }
        ownedChildren.set(sessionId, owned);
        for (let index = owned.length - 1; index >= 0; index -= 1) stack.push(owned[index]!);
      }

      // Pre-order places every node immediately before its own descendants, so
      // a subtree is exactly `[index, index + size)` of the traversal. Walking
      // in reverse resolves each node's size after its children.
      const sizeById = new Map<string, number>();
      for (let index = preOrder.length - 1; index >= 0; index -= 1) {
        const sessionId = preOrder[index]!;
        let size = 1;
        for (const childId of ownedChildren.get(sessionId) || []) {
          size += sizeById.get(childId) ?? 1;
        }
        sizeById.set(sessionId, size);
        sessionTreeSpanById.set(sessionId, { order: preOrder, start: index, end: index + size });
      }
    };

    // Sessions in a parent cycle have no root to descend from. Anchoring at the
    // top of the unindexed component (rather than wherever the list happens to
    // start) means one traversal covers it; starting mid-chain would re-walk the
    // suffix once per session and cost O(n^2) on a leaf-first ordering.
    const findFallbackAnchor = (startId: string) => {
      const seen = new Set<string>([startId]);
      let currentId = startId;
      while (true) {
        const parentId = parentById.get(currentId);
        if (!parentId || !sessionIds.has(parentId)) return currentId;
        if (nearestPrimarySessionById.has(parentId)) return currentId;
        // The start is itself on the cycle, so it is already the highest node.
        if (parentId === startId) return startId;
        if (seen.has(parentId)) return parentId;
        seen.add(parentId);
        currentId = parentId;
      }
    };

    for (const rootId of rootIds) collectIndexedTreeIds(rootId);
    for (const session of sessions) {
      if (nearestPrimarySessionById.has(session.id)) continue;
      collectIndexedTreeIds(findFallbackAnchor(session.id));
    }

    activeUsageLimitByRoot = new Map();
    for (const rootId of new Set(nearestPrimarySessionById.values())) {
      const activeNotice = readTreeIds(rootId)
        .map((id) => usageLimits[id] || null)
        .find((notice) => !!notice);
      activeUsageLimitByRoot.set(rootId, activeNotice || null);
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
      return readTreeIds(rootId);
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
