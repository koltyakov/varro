import { describe, expect, it } from 'vitest';
import type { MessageEntry, Part } from '../types';
import { createMessageIndex } from './message-index';

/**
 * Oracle test for the message index cache.
 *
 * The index is a performance cache over the message list; every lookup it
 * answers must match what a linear scan of the actual array would say. A
 * stale or mis-maintained cache doesn't crash — it silently routes streaming
 * deltas and part updates to the wrong part, which is exactly the kind of
 * regression example tests miss. So: apply long random sequences of the same
 * mutations the store performs (append/remove parts, add/remove/replace
 * messages, in-place part updates) with the store's notification discipline,
 * and after every step compare every id lookup — plus ids that were deleted —
 * against the brute-force answer.
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

let idCounter = 0;

function makePart(messageID: string, text = ''): Part {
  idCounter += 1;
  return {
    id: `part-${idCounter}`,
    sessionID: 'session-1',
    messageID,
    type: 'text',
    text,
  };
}

function makeMessage(partCount: number): MessageEntry {
  idCounter += 1;
  const id = `message-${idCounter}`;
  const info = {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 0 },
    agent: 'build',
    model: { providerID: 'provider-1', modelID: 'model-1' },
  } as MessageEntry['info'];
  return {
    info,
    parts: Array.from({ length: partCount }, () => makePart(id)),
  };
}

function bruteForceMessageIndex(msgs: MessageEntry[], id: string) {
  return msgs.findIndex((m) => m.info.id === id);
}

function bruteForcePartLocation(msgs: MessageEntry[], partId: string) {
  for (let msgIdx = 0; msgIdx < msgs.length; msgIdx++) {
    const partIdx = msgs[msgIdx]!.parts.findIndex((p) => p.id === partId);
    if (partIdx !== -1) return { msgIdx, partIdx };
  }
  return null;
}

function runScenario(seed: number) {
  const rng = mulberry32(seed);
  const index = createMessageIndex();
  const msgs: MessageEntry[] = [];
  const removedMessageIds: string[] = [];
  const removedPartIds: string[] = [];

  for (let i = 0; i < randomInt(rng, 2, 4); i++) {
    msgs.push(makeMessage(randomInt(rng, 0, 3)));
  }
  index.invalidate();

  const verify = (label: string) => {
    for (const entry of msgs) {
      expect(
        index.findMessageIndex(msgs, entry.info.id),
        `seed ${seed} ${label}: message ${entry.info.id} index diverged from linear scan`
      ).toBe(bruteForceMessageIndex(msgs, entry.info.id));
      for (const part of entry.parts) {
        expect(
          index.findPartLocation(msgs, part.id),
          `seed ${seed} ${label}: part ${part.id} location diverged from linear scan`
        ).toEqual(bruteForcePartLocation(msgs, part.id));
      }
    }
    for (const id of removedMessageIds) {
      expect(
        index.findMessageIndex(msgs, id),
        `seed ${seed} ${label}: removed message ${id} still resolvable`
      ).toBe(bruteForceMessageIndex(msgs, id));
    }
    for (const id of removedPartIds) {
      expect(
        index.findPartLocation(msgs, id),
        `seed ${seed} ${label}: removed part ${id} still resolvable`
      ).toEqual(bruteForcePartLocation(msgs, id));
    }
    expect(index.findMessageIndex(msgs, 'never-existed')).toBe(-1);
    expect(index.findPartLocation(msgs, 'never-existed')).toBeNull();
  };

  verify('initial');

  for (let step = 0; step < 120; step++) {
    const op = randomInt(rng, 0, 5);

    if (op === 0) {
      // Append a part to an existing message and register it, mirroring
      // upsertPart / flushPendingStreamingDeltasFor.
      if (msgs.length > 0) {
        const msgIdx = randomInt(rng, 0, msgs.length - 1);
        const part = makePart(msgs[msgIdx]!.info.id);
        msgs[msgIdx]!.parts.push(part);
        index.appendPart(msgs, part.id, {
          msgIdx,
          partIdx: msgs[msgIdx]!.parts.length - 1,
        });
      }
    } else if (op === 1) {
      // Remove a part, mirroring removeMessagePart. This is the op with the
      // trickiest cache maintenance: every later part of the same message
      // shifts left.
      const withParts = msgs
        .map((entry, msgIdx) => ({ entry, msgIdx }))
        .filter(({ entry }) => entry.parts.length > 0);
      if (withParts.length > 0) {
        const { entry, msgIdx } = withParts[randomInt(rng, 0, withParts.length - 1)]!;
        const partIdx = randomInt(rng, 0, entry.parts.length - 1);
        const [removed] = entry.parts.splice(partIdx, 1);
        removedPartIds.push(removed!.id);
        index.removePart(msgs, removed!.id, { msgIdx, partIdx });
      }
    } else if (op === 2) {
      // Insert a new message at a random position (history pagination and
      // optimistic-message reconciliation both do mid-list inserts).
      const insertAt = randomInt(rng, 0, msgs.length);
      msgs.splice(insertAt, 0, makeMessage(randomInt(rng, 0, 3)));
      index.invalidate();
    } else if (op === 3) {
      // Remove a whole message.
      if (msgs.length > 0) {
        const removeAt = randomInt(rng, 0, msgs.length - 1);
        const [removed] = msgs.splice(removeAt, 1);
        removedMessageIds.push(removed!.info.id);
        for (const part of removed!.parts) removedPartIds.push(part.id);
        index.invalidate();
      }
    } else if (op === 4) {
      // Replace a part in place (same id, same position) — content-only
      // change that must not disturb the cached locations.
      const withParts = msgs.filter((entry) => entry.parts.length > 0);
      if (withParts.length > 0) {
        const entry = withParts[randomInt(rng, 0, withParts.length - 1)]!;
        const partIdx = randomInt(rng, 0, entry.parts.length - 1);
        const part = entry.parts[partIdx]!;
        entry.parts[partIdx] = { ...part, text: `updated-${step}` } as Part;
        index.notifyPartContentChange();
      }
    } else {
      // Replace a whole message entry with a rebuilt one (same id), the way
      // upsertMessage swaps entries on refresh.
      if (msgs.length > 0) {
        const msgIdx = randomInt(rng, 0, msgs.length - 1);
        const current = msgs[msgIdx]!;
        const rebuilt: MessageEntry = {
          info: { ...current.info },
          parts: current.parts.map((part) => ({ ...part })),
        };
        // Occasionally drop or add a part during the swap.
        if (rebuilt.parts.length > 0 && rng() < 0.5) {
          const [removed] = rebuilt.parts.splice(randomInt(rng, 0, rebuilt.parts.length - 1), 1);
          removedPartIds.push(removed!.id);
        } else {
          rebuilt.parts.push(makePart(rebuilt.info.id));
        }
        msgs[msgIdx] = rebuilt;
        index.invalidate();
      }
    }

    verify(`after step ${step}`);
  }
}

describe('message index oracle', () => {
  const seeds = Array.from({ length: 10 }, (_, i) => i + 1);
  for (const seed of seeds) {
    it(`matches linear-scan lookups under random mutations (seed ${seed})`, () => {
      runScenario(seed);
    });
  }

  it('self-heals lookups when a mutation happened without notification', () => {
    // The index is deliberately resilient: findMessageIndex/findPartLocation
    // validate cache hits by id and fall back to scanning, so a missed
    // invalidate must degrade to correct-but-slower, never to wrong answers.
    const index = createMessageIndex();
    const msgs = [makeMessage(2), makeMessage(2), makeMessage(2)];
    index.invalidate();
    expect(index.findMessageIndex(msgs, msgs[2]!.info.id)).toBe(2);
    const partId = msgs[2]!.parts[1]!.id;
    expect(index.findPartLocation(msgs, partId)).toEqual({ msgIdx: 2, partIdx: 1 });

    // Rogue mutation: drop the first message without telling the index.
    msgs.splice(0, 1);

    expect(index.findMessageIndex(msgs, msgs[1]!.info.id)).toBe(1);
    expect(index.findPartLocation(msgs, partId)).toEqual({ msgIdx: 1, partIdx: 1 });
  });
});
