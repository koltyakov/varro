import { createSignal, untrack } from 'solid-js';
import type { SessionDiffSummary } from '../../../shared/protocol';
import type { Session } from '../../types';
import { client } from '../../lib/client';
import { getSessionTreeUpdated } from '../../lib/state';

type SessionDiffSummaryCacheEntry = {
  status: 'loading' | 'ready' | 'error';
  updated: number;
  stats: SessionDiffSummary | null;
};

type SessionDiffSummaryRequest = {
  sessionId: string;
  directory?: string;
  updated: number;
};

const SESSION_DIFF_SUMMARY_CONCURRENCY = 4;
const SESSION_DIFF_SUMMARY_QUEUE_LIMIT = 100;
const SESSION_DIFF_SUMMARY_CACHE_LIMIT = 200;

function getDiffSummaryKey(sessionId: string, updated: number): string {
  return `${sessionId}:${updated}`;
}

// Module-scoped so cached summaries survive list remounts. Keep the last-known
// statistics during refresh to avoid flashing zero counters on every return.
const [cache, setCache] = createSignal<Record<string, SessionDiffSummaryCacheEntry | undefined>>(
  {}
);
let activeDiffSummaryRequests = 0;
const diffSummaryQueue: SessionDiffSummaryRequest[] = [];
const queuedDiffSummaryKeys = new Set<string>();
const activeDiffSummaryKeys = new Set<string>();
const diffSummaryCacheOrder: string[] = [];
const relevantDiffSummarySessionsByOwner = new Map<symbol, Set<string>>();
let relevantDiffSummarySessionIds = new Set<string>();

type SessionSummaryObserverGroup = {
  observer: IntersectionObserver;
  callbacks: Map<Element, () => void>;
};
const sessionSummaryObserverGroups = new Map<Element | null, SessionSummaryObserverGroup>();

function observe(element: Element, callback: () => void): () => void {
  const root = element.closest('.session-list-scroll');
  let group = sessionSummaryObserverGroups.get(root);
  if (!group) {
    const callbacks = new Map<Element, () => void>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const observed = callbacks.get(entry.target);
          if (!observed) continue;
          callbacks.delete(entry.target);
          observer.unobserve(entry.target);
          observed();
        }
        if (callbacks.size === 0) {
          observer.disconnect();
          sessionSummaryObserverGroups.delete(root);
        }
      },
      { root, rootMargin: '300px 0px' }
    );
    group = { observer, callbacks };
    sessionSummaryObserverGroups.set(root, group);
  }
  group.callbacks.set(element, callback);
  group.observer.observe(element);

  return () => {
    const current = sessionSummaryObserverGroups.get(root);
    if (!current || !current.callbacks.delete(element)) return;
    current.observer.unobserve(element);
    if (current.callbacks.size === 0) {
      current.observer.disconnect();
      sessionSummaryObserverGroups.delete(root);
    }
  };
}

function setDiffSummaryCacheEntry(sessionId: string, entry: SessionDiffSummaryCacheEntry) {
  const previousOrderIndex = diffSummaryCacheOrder.indexOf(sessionId);
  if (previousOrderIndex !== -1) diffSummaryCacheOrder.splice(previousOrderIndex, 1);
  diffSummaryCacheOrder.push(sessionId);

  const evictedSessionIds: string[] = [];
  while (diffSummaryCacheOrder.length > SESSION_DIFF_SUMMARY_CACHE_LIMIT) {
    const evicted = diffSummaryCacheOrder.shift();
    if (evicted) evictedSessionIds.push(evicted);
  }

  setCache((current) => {
    const next = { ...current, [sessionId]: entry };
    for (const evictedSessionId of evictedSessionIds) delete next[evictedSessionId];
    return next;
  });
}

function updateRelevantSessions(owner: symbol, sessionIds: Set<string> | null) {
  if (sessionIds) relevantDiffSummarySessionsByOwner.set(owner, sessionIds);
  else relevantDiffSummarySessionsByOwner.delete(owner);

  relevantDiffSummarySessionIds = new Set(
    Array.from(relevantDiffSummarySessionsByOwner.values()).flatMap((ids) => Array.from(ids))
  );

  for (let index = diffSummaryQueue.length - 1; index >= 0; index -= 1) {
    const request = diffSummaryQueue[index]!;
    if (relevantDiffSummarySessionIds.has(request.sessionId)) continue;
    diffSummaryQueue.splice(index, 1);
    queuedDiffSummaryKeys.delete(getDiffSummaryKey(request.sessionId, request.updated));
  }
}

function isCurrentDiffSummaryRequest(request: SessionDiffSummaryRequest) {
  return (
    relevantDiffSummarySessionIds.has(request.sessionId) &&
    getSessionTreeUpdated(request.sessionId) === request.updated
  );
}

function enqueue(session: Session, updated = getSessionTreeUpdated(session.id)) {
  const cached = untrack(cache)[session.id];
  // A matching failure is settled for this revision. Retrying from this reactive
  // effect would otherwise form a tight request loop until the server recovers.
  if (cached?.updated === updated && (cached.status === 'ready' || cached.status === 'error')) {
    return;
  }

  const key = getDiffSummaryKey(session.id, updated);
  if (queuedDiffSummaryKeys.has(key) || activeDiffSummaryKeys.has(key)) return;
  if (diffSummaryQueue.length >= SESSION_DIFF_SUMMARY_QUEUE_LIMIT) return;

  queuedDiffSummaryKeys.add(key);
  diffSummaryQueue.push({ sessionId: session.id, directory: session.directory, updated });
  setDiffSummaryCacheEntry(session.id, {
    status: 'loading',
    updated,
    stats: cached?.stats ?? null,
  });
  pumpDiffSummaryQueue();
}

function pumpDiffSummaryQueue() {
  while (
    activeDiffSummaryRequests < SESSION_DIFF_SUMMARY_CONCURRENCY &&
    diffSummaryQueue.length > 0
  ) {
    const request = diffSummaryQueue.shift()!;
    const requestKey = getDiffSummaryKey(request.sessionId, request.updated);
    queuedDiffSummaryKeys.delete(requestKey);

    if (!isCurrentDiffSummaryRequest(request)) continue;

    activeDiffSummaryRequests += 1;
    activeDiffSummaryKeys.add(requestKey);
    void client.varro.session
      .diffSummary(request.sessionId, request.updated, { directory: request.directory })
      .then((summary) => {
        if (!isCurrentDiffSummaryRequest(request)) return;
        setDiffSummaryCacheEntry(request.sessionId, {
          status: 'ready',
          updated: request.updated,
          stats: summary,
        });
      })
      .catch(() => {
        if (!isCurrentDiffSummaryRequest(request)) return;
        setDiffSummaryCacheEntry(request.sessionId, {
          status: 'error',
          updated: request.updated,
          stats: cache()[request.sessionId]?.stats ?? null,
        });
      })
      .finally(() => {
        activeDiffSummaryRequests -= 1;
        activeDiffSummaryKeys.delete(requestKey);
        pumpDiffSummaryQueue();
      });
  }
}

function getStateForTests() {
  return {
    active: activeDiffSummaryRequests,
    queued: diffSummaryQueue.length,
    cached: Object.keys(cache()).length,
    queueLimit: SESSION_DIFF_SUMMARY_QUEUE_LIMIT,
    cacheLimit: SESSION_DIFF_SUMMARY_CACHE_LIMIT,
  };
}

function resetForTests() {
  activeDiffSummaryRequests = 0;
  diffSummaryQueue.length = 0;
  queuedDiffSummaryKeys.clear();
  activeDiffSummaryKeys.clear();
  diffSummaryCacheOrder.length = 0;
  relevantDiffSummarySessionsByOwner.clear();
  relevantDiffSummarySessionIds.clear();
  setCache({});
}

export const sessionDiffSummaries = {
  cache,
  enqueue,
  observe,
  updateRelevantSessions,
  getStateForTests,
  resetForTests,
};
