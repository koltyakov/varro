import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedMessage } from './app-state-types';

/**
 * Reference-model fuzz for the queued-message operations.
 *
 * The queue is one flat array shared by all sessions, but drag-reorder is
 * scoped to a session: the moved message may only permute the *slots its
 * session already occupies*, while every other session's messages must keep
 * their exact positions. That slot-remapping (`sessionIndex++` in
 * reorderQueuedMessage) is easy to break in ways no single example test
 * notices — e.g. off-by-one only when the sessions interleave a particular
 * way. So: run random op sequences against a trivially-correct reference
 * model and require the real state to match it exactly after every op.
 */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

function randomInt(rng: Rng, minInclusive: number, maxInclusive: number) {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

type Model = QueuedMessage[];

/** Same semantics as reorderQueuedMessage, written the naive obvious way. */
function modelReorder(model: Model, id: string, targetId: string): Model {
  if (id === targetId) return model;
  const message = model.find((item) => item.id === id);
  const target = model.find((item) => item.id === targetId);
  if (!message || !target || message.sessionId !== target.sessionId) return model;

  const sessionSlots: number[] = [];
  const sessionMessages: QueuedMessage[] = [];
  model.forEach((item, index) => {
    if (item.sessionId === message.sessionId) {
      sessionSlots.push(index);
      sessionMessages.push(item);
    }
  });

  const sourceIndex = sessionMessages.findIndex((item) => item.id === id);
  const targetIndex = sessionMessages.findIndex((item) => item.id === targetId);
  sessionMessages.splice(sourceIndex, 1);
  sessionMessages.splice(targetIndex, 0, message);

  const next = [...model];
  sessionSlots.forEach((slot, i) => {
    next[slot] = sessionMessages[i]!;
  });
  return next;
}

async function loadState() {
  return import('./state');
}

beforeEach(() => {
  vi.resetModules();
});

function runScenario(seed: number, stateModule: Awaited<ReturnType<typeof loadState>>) {
  const rng = mulberry32(seed);
  let model: Model = [];
  let nextId = 0;
  const sessionIds = ['session-a', 'session-b', 'session-c'];

  const anyId = () => {
    if (model.length === 0) return 'missing';
    return model[randomInt(rng, 0, model.length - 1)]!.id;
  };

  const verify = (label: string) => {
    expect(
      stateModule.state.queuedMessages.map((item) => item.id),
      `seed ${seed} ${label}: queue diverged from reference model`
    ).toEqual(model.map((item) => item.id));
    // Slot-scoping invariant, checked explicitly so a failure names the
    // broken property instead of just a wrong array.
    for (const sessionId of sessionIds) {
      const positions = stateModule.state.queuedMessages
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.sessionId === sessionId)
        .map(({ index }) => index);
      const modelPositions = model
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.sessionId === sessionId)
        .map(({ index }) => index);
      expect(
        positions,
        `seed ${seed} ${label}: session ${sessionId} does not occupy its original slots`
      ).toEqual(modelPositions);
    }
  };

  for (let step = 0; step < 80; step++) {
    const op = randomInt(rng, 0, 9);

    if (op <= 2) {
      nextId += 1;
      const message: QueuedMessage = {
        id: `q-${seed}-${nextId}`,
        sessionId: sessionIds[randomInt(rng, 0, sessionIds.length - 1)]!,
        text: `text ${nextId}`,
      };
      stateModule.enqueueMessage(message);
      model = [...model, message];
    } else if (op === 3) {
      const id = anyId();
      stateModule.removeQueuedMessage(id);
      model = model.filter((item) => item.id !== id);
    } else if (op === 4) {
      const id = anyId();
      const existing = model.find((item) => item.id === id);
      if (existing) {
        const replacement = { ...existing, text: `edited at ${step}` };
        expect(stateModule.replaceQueuedMessage(id, replacement)).toBe(true);
        model = model.map((item) => (item.id === id ? replacement : item));
      } else {
        expect(stateModule.replaceQueuedMessage(id, existing!)).toBe(false);
      }
    } else if (op === 5) {
      const sessionId = sessionIds[randomInt(rng, 0, sessionIds.length - 1)]!;
      stateModule.clearQueuedMessagesForSession(sessionId);
      model = model.filter((item) => item.sessionId !== sessionId);
    } else {
      // Reorder dominates the op mix: it's the operation this fuzz exists
      // for. Ids are picked without regard to session, so cross-session
      // pairs (which must be no-ops) occur naturally.
      const id = anyId();
      const targetId = anyId();
      stateModule.reorderQueuedMessage(id, targetId);
      model = modelReorder(model, id, targetId);
    }

    verify(`after step ${step} (op ${op})`);
  }
}

describe('queued messages fuzz', () => {
  const seeds = Array.from({ length: 10 }, (_, i) => i + 100);
  for (const seed of seeds) {
    it(`matches the reference model under random op sequences (seed ${seed})`, async () => {
      const stateModule = await loadState();
      runScenario(seed, stateModule);
    });
  }

  it('survives a persistence round-trip mid-sequence', async () => {
    // Reload the module (as a webview restore does) and check the queue comes
    // back in the same session-aware order it was saved in.
    let stateModule = await loadState();
    stateModule.enqueueMessage({ id: 'a1', sessionId: 'session-a', text: '1' });
    stateModule.enqueueMessage({ id: 'b1', sessionId: 'session-b', text: '2' });
    stateModule.enqueueMessage({ id: 'a2', sessionId: 'session-a', text: '3' });
    stateModule.reorderQueuedMessage('a2', 'a1');
    const saved = stateModule.state.queuedMessages.map((item) => item.id);
    expect(saved).toEqual(['a2', 'b1', 'a1']);

    vi.resetModules();
    stateModule = await loadState();
    expect(stateModule.state.queuedMessages.map((item) => item.id)).toEqual(saved);
  });
});
