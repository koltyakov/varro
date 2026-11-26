import { createStore } from 'solid-js';
import { parseSessionGoal } from '../../../shared/session-goal';
import type { SessionGoal } from '../../../shared/session-goal';
import { client, serverEvents } from '../client';

export type SessionGoalStatus = SessionGoal['status'];

/** Goal reads are cheap storage lookups, but a long list should not flood the host bridge. */
const MAX_CONCURRENT_READS = 4;

/**
 * Goal status of listed sessions. OpenCode has no goal list API, so rows read
 * their own goal once when they become visible, and `session.goal.updated`
 * keeps every known session current afterwards.
 */
const [statuses, setStatuses] = createStore<Record<string, SessionGoalStatus>>({});
const requested = new Map<string, string | undefined>();
const eventVersions = new Map<string, number>();
let queue: string[] = [];
let inFlight = 0;
let generation = 0;
let unsubscribe: (() => void) | null = null;

function apply(sessionId: string, goal: SessionGoal | null) {
  setStatuses((draft) => {
    if (goal) draft[sessionId] = goal.status;
    else delete draft[sessionId];
  });
}

function subscribe() {
  if (unsubscribe) return;
  const offGoal = serverEvents.on('session.goal.updated', (event) => {
    const properties = event.properties;
    const sessionId = properties?.sessionID;
    if (!properties || !sessionId) return;
    const goal = parseSessionGoal(properties.goal);
    if (properties.goal !== null && !goal) return;
    eventVersions.set(sessionId, (eventVersions.get(sessionId) ?? 0) + 1);
    apply(sessionId, goal);
  });
  // Events missed while disconnected are only recoverable by reading again.
  const offConnected = serverEvents.on('server.connected', () => {
    generation += 1;
    queue = [...requested.keys()];
    pump();
  });
  unsubscribe = () => {
    offGoal();
    offConnected();
  };
}

function pump() {
  while (inFlight < MAX_CONCURRENT_READS && queue.length > 0) {
    const sessionId = queue.shift()!;
    if (!requested.has(sessionId)) continue;
    const directory = requested.get(sessionId);
    const readGeneration = generation;
    const version = eventVersions.get(sessionId) ?? 0;
    inFlight += 1;
    client.session
      .goal(sessionId, { directory })
      .then(
        (goal) => {
          // A goal event delivered during the read is newer than the read's snapshot.
          if (readGeneration !== generation) return;
          if ((eventVersions.get(sessionId) ?? 0) !== version) return;
          apply(sessionId, goal);
        },
        () => {
          // Locations without the goal plugin have no goal RPC; show no goal.
        }
      )
      .finally(() => {
        inFlight -= 1;
        pump();
      });
  }
}

export const sessionGoalStore = {
  status(sessionId: string): SessionGoalStatus | undefined {
    return statuses[sessionId];
  },

  /** Reads a session's goal once; later changes arrive through server events. */
  request(sessionId: string, directory: string | undefined) {
    subscribe();
    if (requested.has(sessionId)) return;
    requested.set(sessionId, directory);
    queue.push(sessionId);
    pump();
  },
};

export function resetSessionGoalStoreForTests() {
  unsubscribe?.();
  unsubscribe = null;
  requested.clear();
  eventVersions.clear();
  queue = [];
  inFlight = 0;
  generation += 1;
  setStatuses((draft) => {
    for (const key of Object.keys(draft)) delete draft[key];
  });
}
