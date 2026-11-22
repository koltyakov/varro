import { createSignal, untrack, type Accessor, type Setter } from 'solid-js';
import type {
  SessionFollowupUsage,
  SessionFollowupUsageInterval,
  SessionUsageTotals,
} from '../../shared/protocol';
import { client, serverEvents } from './client';
import { isString } from './runtime-values';

export type FollowupUsageEntry = {
  status: 'loading' | 'ready' | 'error';
  /** Child revision of the latest request. */
  revision: string;
  /** Last successful summary, kept while a newer revision loads. */
  data: SessionFollowupUsage | null;
  /** Prompts already looked up at this revision, so a missing prompt cannot loop requests. */
  checked: ReadonlySet<string>;
};

export type FollowupUsageView =
  | { kind: 'loading' }
  | { kind: 'pending' }
  | { kind: 'unavailable'; reason: string }
  | {
      kind: 'interval';
      interval: SessionFollowupUsageInterval;
      /** At least one step recorded usage; otherwise the counters are unknown, not zero. */
      recorded: boolean;
      shared: boolean;
      partial: boolean;
      running: boolean;
      reasons: string[];
    };

const FOLLOWUP_USAGE_CONCURRENCY = 4;
const FOLLOWUP_USAGE_CACHE_LIMIT = 64;
const FOLLOWUP_USAGE_EVENT_LIMIT = 256;
// Deliveries and settled model records can change intervals without changing session totals.
const FOLLOWUP_USAGE_EVENTS = [
  'session.next.prompted',
  'session.next.step.ended',
  'session.next.step.failed',
] as const;
// A revert replaces history, so even a closed interval from an earlier read may no longer exist.
const FOLLOWUP_USAGE_REVERT_EVENTS = [
  'session.next.revert.staged',
  'session.next.revert.cleared',
  'session.next.revert.committed',
] as const;

type Request = {
  key: string;
  sessionID: string;
  directory?: string;
  revision: string;
  promptID: string;
};

// Module-scoped so every card for the same child shares one bounded request and result.
const [cache, setCache] = createSignal<Record<string, FollowupUsageEntry | undefined>>({});
const [connection, setConnection] = createSignal(0);
const subscribers = new Map<string, number>();
// In-flight reads by key; aborting one frees its slot for mounted children.
const active = new Map<string, AbortController>();
const wanted = new Map<string, Request>();
const queue: string[] = [];
// One signal per child, so an event refreshes only that child's cards.
const childEvents = new Map<string, [Accessor<number>, Setter<number>]>();
const childSubscribers = new Map<string, number>();
// Child session of each cached or requested key, for per-child invalidation.
const keySessions = new Map<string, string>();
let generation = 0;
let stopEvents: Array<() => void> | undefined;

/** Advances the shared revision after a reconnect, even when child totals look unchanged. */
function invalidate() {
  // A reconnect may have missed a revert, so no earlier read can be trusted.
  discard(() => true);
  setConnection((value) => value + 1);
}

/** Drops retained results and in-flight reads, so cards load fresh history instead of old values. */
function discard(matches: (key: string) => boolean) {
  // Every cached or active key was requested first, so this covers entries not yet flushed.
  const keys = [...new Set([...keySessions.keys(), ...active.keys()])].filter(matches);
  if (!keys.length) return;
  for (const key of keys) {
    const controller = active.get(key);
    if (!controller) continue;
    // Removing the active controller also makes a late settlement of this read a no-op.
    active.delete(key);
    controller.abort();
  }
  setCache((current) => {
    const next = { ...current };
    for (const key of keys) delete next[key];
    return next;
  });
  for (const key of keys) if (!subscribers.has(key) && !wanted.has(key)) keySessions.delete(key);
  pump();
}

function childSignal(sessionID: string) {
  let signal = childEvents.get(sessionID);
  if (signal) return signal;
  signal = createSignal(0);
  childEvents.set(sessionID, signal);
  // Bound retained signals by dropping children no mounted card watches.
  for (const candidate of childEvents.keys()) {
    if (childEvents.size <= FOLLOWUP_USAGE_EVENT_LIMIT) break;
    if (candidate !== sessionID && !childSubscribers.has(candidate)) childEvents.delete(candidate);
  }
  return signal;
}

/** Advances when the child receives a delivery or settles a model record. */
function eventRevision(sessionID: string) {
  return childSignal(sessionID)[0]();
}

function listen() {
  stopEvents ??= [
    serverEvents.on('server.connected', invalidate),
    ...FOLLOWUP_USAGE_EVENTS.map((type) =>
      serverEvents.on(type, (event) => {
        const sessionID = event.properties?.sessionID;
        if (!isString(sessionID)) return;
        if (childSubscribers.has(sessionID)) {
          childSignal(sessionID)[1]((value) => value + 1);
          return;
        }
        // No card is watching: drop retained results so a remount reads fresh, without reading now.
        discard((key) => keySessions.get(key) === sessionID);
      })
    ),
    ...FOLLOWUP_USAGE_REVERT_EVENTS.map((type) =>
      serverEvents.on(type, (event) => {
        const sessionID = event.properties?.sessionID;
        if (!isString(sessionID)) return;
        discard((key) => keySessions.get(key) === sessionID);
        if (childSubscribers.has(sessionID)) childSignal(sessionID)[1]((value) => value + 1);
      })
    ),
  ];
}

function subscribe(key: string, sessionID: string): () => void {
  listen();
  subscribers.set(key, (subscribers.get(key) ?? 0) + 1);
  childSubscribers.set(sessionID, (childSubscribers.get(sessionID) ?? 0) + 1);
  // Effects may request before they subscribe; start that waiting read now.
  if (wanted.has(key) && !active.has(key) && !queue.includes(key)) {
    queue.push(key);
    pump();
  }
  return () => {
    const children = (childSubscribers.get(sessionID) ?? 1) - 1;
    if (children > 0) childSubscribers.set(sessionID, children);
    else childSubscribers.delete(sessionID);
    const count = (subscribers.get(key) ?? 1) - 1;
    if (count > 0) {
      subscribers.set(key, count);
      return;
    }
    subscribers.delete(key);
    wanted.delete(key);
    const index = queue.indexOf(key);
    if (index >= 0) queue.splice(index, 1);
    const controller = active.get(key);
    if (!controller) return;
    active.delete(key);
    controller.abort();
    pump();
  };
}

function request(next: Request) {
  keySessions.set(next.key, next.sessionID);
  const entry = untrack(cache)[next.key];
  if (
    entry?.revision === next.revision &&
    entry.status !== 'loading' &&
    (hasPrompt(entry.data, next.promptID) || entry.checked.has(next.promptID))
  ) {
    return;
  }
  wanted.set(next.key, next);
  // Mark retained data stale now, even while waiting for a slot or for an older active read.
  if (entry && (entry.revision !== next.revision || entry.status !== 'loading'))
    setEntry(next.key, {
      status: 'loading',
      revision: next.revision,
      data: entry.data,
      checked: entry.revision === next.revision ? entry.checked : new Set(),
    });
  if (active.has(next.key) || queue.includes(next.key)) return;
  queue.push(next.key);
  pump();
}

function pump() {
  while (active.size < FOLLOWUP_USAGE_CONCURRENCY && queue.length) {
    const key = queue.shift()!;
    const next = wanted.get(key);
    // Unmounted keys keep their latest request until a card subscribes or unsubscribes.
    if (!next || !subscribers.has(key)) continue;
    wanted.delete(key);
    start(next);
  }
}

function start(next: Request) {
  const requestGeneration = generation;
  const previous = untrack(cache)[next.key];
  const checked = new Set(previous?.revision === next.revision ? previous.checked : []);
  checked.add(next.promptID);
  const controller = new AbortController();
  active.set(next.key, controller);
  // Settlement belongs to this read only while it is still the key's active read.
  const current = () => requestGeneration === generation && active.get(next.key) === controller;
  setEntry(next.key, {
    status: 'loading',
    revision: next.revision,
    data: previous?.data ?? null,
    checked,
  });
  // One request per child at a time settles in order, so an older response cannot replace a newer one.
  void client.varro.session
    .followupUsage(next.sessionID, { directory: next.directory, signal: controller.signal })
    .then((data) => {
      if (!current()) return;
      // A newer revision requested meanwhile keeps this result marked stale until its own read.
      const newer = newerRevision(next);
      setEntry(next.key, {
        status: newer ? 'loading' : 'ready',
        revision: newer ?? next.revision,
        data,
        checked: newer ? new Set() : checked,
      });
    })
    .catch(() => {
      if (!current()) return;
      const newer = newerRevision(next);
      setEntry(next.key, {
        status: newer ? 'loading' : 'error',
        revision: newer ?? next.revision,
        data: untrack(cache)[next.key]?.data ?? null,
        checked: newer ? new Set() : checked,
      });
    })
    .finally(() => {
      if (!current()) return;
      active.delete(next.key);
      const pending = wanted.get(next.key);
      wanted.delete(next.key);
      // Requests made during this read run only if its result does not already answer them.
      if (pending && subscribers.has(next.key)) request(pending);
      pump();
    });
}

function newerRevision(settled: Request) {
  const pending = wanted.get(settled.key);
  return pending && pending.revision !== settled.revision ? pending.revision : undefined;
}

function setEntry(key: string, entry: FollowupUsageEntry) {
  setCache((current) => {
    const next = { ...current };
    delete next[key];
    next[key] = entry;
    // Insertion order is recency order; mounted and loading children are never evicted.
    let size = Object.keys(next).length;
    for (const candidate of Object.keys(next)) {
      if (size <= FOLLOWUP_USAGE_CACHE_LIMIT) break;
      if (candidate === key || subscribers.has(candidate) || active.has(candidate)) continue;
      delete next[candidate];
      if (!wanted.has(candidate)) keySessions.delete(candidate);
      size -= 1;
    }
    return next;
  });
}

function hasPrompt(data: SessionFollowupUsage | null, promptID: string) {
  return (
    !!data &&
    (data.pendingPromptIDs.includes(promptID) ||
      data.intervals.some((interval) => interval.promptIDs.includes(promptID)))
  );
}

/**
 * Resolves one prompt's usage interval. Missing usage stays explicit: an undelivered or unread
 * prompt never falls back to session totals.
 */
export function resolveFollowupUsage(
  entry: FollowupUsageEntry | undefined,
  promptID: string
): FollowupUsageView {
  const data = entry?.data;
  if (!data) {
    return !entry || entry.status === 'loading'
      ? { kind: 'loading' }
      : { kind: 'unavailable', reason: 'Child usage could not be loaded.' };
  }
  if (!data.supported)
    return {
      kind: 'unavailable',
      reason: 'This server does not report usage for individual subagent prompts.',
    };
  // Data in a loading or failed entry comes from an earlier read.
  if (entry.status === 'error')
    return {
      kind: 'unavailable',
      reason: 'The latest usage refresh failed, and the earlier read may be out of date.',
    };
  const interval = data.intervals.find((candidate) => candidate.promptIDs.includes(promptID));
  // While refreshing, only a closed interval with no unfinished step keeps its earlier values;
  // reverts and reconnects drop retained reads entirely.
  const stale =
    entry.status === 'loading' && !!interval && !(interval.final && interval.usage.active === 0);
  if (!interval) {
    if (entry.status === 'loading') return { kind: 'loading' };
    if (data.pendingPromptIDs.includes(promptID)) return { kind: 'pending' };
    return {
      kind: 'unavailable',
      reason: data.complete
        ? 'This prompt was not found in the subagent history.'
        : 'This prompt is older than the subagent history that was read.',
    };
  }
  const usage = interval.usage;
  const reasons: string[] = [];
  if (stale) reasons.push('Refreshing usage; these values come from an earlier read.');
  if (interval.boundaryUnknown)
    reasons.push('Earlier prompts outside the history that was read may share this usage.');
  if (usage.missing > 0)
    reasons.push(
      `${usage.missing} model ${usage.missing === 1 ? 'step has' : 'steps have'} no recorded usage.`
    );
  if (interval.final && usage.active > 0)
    reasons.push(
      `${usage.active} model ${usage.active === 1 ? 'step' : 'steps'} never finished recording usage.`
    );
  return {
    kind: 'interval',
    interval,
    recorded: usage.steps > 0,
    shared: interval.promptIDs.length > 1,
    partial: reasons.length > 0,
    running: !interval.final && usage.active > 0,
    reasons,
  };
}

/** Matches the session token cards: input includes cache writes, output includes reasoning. */
export function displayUsageTokens(usage: SessionUsageTotals) {
  return { input: usage.input + usage.cacheWrite, output: usage.output + usage.reasoning };
}

function resetForTests() {
  generation += 1;
  for (const controller of active.values()) controller.abort();
  for (const stop of stopEvents ?? []) stop();
  stopEvents = undefined;
  childEvents.clear();
  childSubscribers.clear();
  keySessions.clear();
  subscribers.clear();
  active.clear();
  wanted.clear();
  queue.length = 0;
  setCache({});
  setConnection(0);
}

export const followupUsage = {
  cache,
  connection,
  eventRevision,
  invalidate,
  subscribe,
  request,
  resetForTests,
};
