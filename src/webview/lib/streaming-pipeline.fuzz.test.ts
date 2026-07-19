import { beforeEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, MessageEntry, Part } from '../types';
import { defaultAppState } from './app-state';
import { flushPendingStreamingDeltasFor } from './streaming-deltas';
import {
  applyMessagePartDelta,
  clearMessages,
  clearStreamingState,
  finishMessageStreaming,
  setMessagesIncremental,
  state,
  upsertMessage,
  upsertPart,
} from './state';

/**
 * Deterministic fuzz of the streaming pipeline against the rendering oracle.
 *
 * Hand-written scenario tests pin known interleavings; this test generates
 * hundreds of server-shaped event schedules (part announcements, chunked
 * deltas, stale part snapshots, stale mid-run refreshes, frame flushes) and
 * checks the invariants that make streaming *look correct* to the user:
 *
 *  1. The text a part renders (the Message.tsx selector: streamingText for
 *     the active part, committed text otherwise) is always a prefix of the
 *     part's final text — no garbled or interleaved chunks.
 *  2. Rendered text never gets shorter — no flicker/rollback while stale
 *     snapshots and refreshes race the delta stream.
 *  3. Rendered text never runs ahead of what the server actually delivered.
 *  4. After the message finishes, every part holds exactly its full text and
 *     the streaming state is cleared.
 *
 * Failures print the seed, so any regression is replayable.
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

function assistantMessage(id: string, sessionID: string): AssistantMessage {
  return {
    id,
    sessionID,
    role: 'assistant',
    time: { created: 0 },
    parentID: 'user-1',
    modelID: 'model-1',
    providerID: 'provider-1',
    mode: 'default',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function streamedPartSnapshot(
  partId: string,
  type: 'text' | 'reasoning',
  text: string,
  messageId: string,
  sessionId: string
): Part {
  if (type === 'reasoning') {
    return {
      id: partId,
      sessionID: sessionId,
      messageID: messageId,
      type: 'reasoning',
      text,
      time: { start: 0 },
    };
  }
  return {
    id: partId,
    sessionID: sessionId,
    messageID: messageId,
    type: 'text',
    text,
  };
}

/** Split text into 1..n non-empty ordered chunks at random cut points. */
function chunkText(rng: Rng, text: string) {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const size = randomInt(rng, 1, Math.max(1, Math.min(12, text.length - offset)));
    chunks.push(text.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
}

function buildFinalText(rng: Rng, seed: number, partIndex: number) {
  const words = randomInt(rng, 4, 14);
  const parts: string[] = [];
  for (let w = 0; w < words; w++) {
    parts.push(`s${seed}p${partIndex}w${w}`);
  }
  return parts.join(' ');
}

const MESSAGE_ID = 'message-1';
const SESSION_ID = 'session-1';

type PartPlan = {
  partId: string;
  type: 'text' | 'reasoning';
  finalText: string;
  chunks: string[];
};

/** What the user currently sees for a part — mirrors Message.tsx:115. */
function renderedText(partId: string) {
  const entry = state.messages.find((m) => m.info.id === MESSAGE_ID);
  const part = entry?.parts.find((p) => p.id === partId);
  const committed = part && (part.type === 'text' || part.type === 'reasoning') ? part.text : '';
  if (state.streamingPartId === partId) return state.streamingText || committed;
  return committed;
}

function flushFrame() {
  // Synchronous equivalent of the requestAnimationFrame flush the queue
  // schedules in production; keeps the fuzz deterministic and fast.
  flushPendingStreamingDeltasFor(defaultAppState);
}

function cloneEntriesWithStaleTexts(rng: Rng, delivered: Map<string, string>): MessageEntry[] {
  return state.messages.map((entry) => ({
    info: JSON.parse(JSON.stringify(entry.info)) as MessageEntry['info'],
    parts: entry.parts.map((part) => {
      const clone = JSON.parse(JSON.stringify(part)) as Part;
      const deliveredText = delivered.get(part.id);
      if (deliveredText !== undefined && (clone.type === 'text' || clone.type === 'reasoning')) {
        // A refresh returns whatever the server has accumulated so far —
        // any prefix of the delivered stream, possibly behind local state.
        clone.text = deliveredText.slice(0, randomInt(rng, 0, deliveredText.length));
      }
      return clone;
    }),
  }));
}

function runScenario(seed: number) {
  const rng = mulberry32(seed);
  clearMessages();
  clearStreamingState();

  upsertMessage({ info: assistantMessage(MESSAGE_ID, SESSION_ID), parts: [] });

  const partCount = randomInt(rng, 2, 4);
  const plans: PartPlan[] = [];
  for (let i = 0; i < partCount; i++) {
    const finalText = buildFinalText(rng, seed, i);
    plans.push({
      partId: `part-${i}`,
      type: rng() < 0.35 ? 'reasoning' : 'text',
      finalText,
      chunks: chunkText(rng, finalText),
    });
  }

  const delivered = new Map<string, string>();
  const lastRendered = new Map<string, number>();
  const announced: PartPlan[] = [];

  const checkInvariants = (label: string) => {
    for (const plan of announced) {
      const rendered = renderedText(plan.partId);
      const deliveredText = delivered.get(plan.partId) ?? '';
      expect(
        plan.finalText.startsWith(rendered),
        `seed ${seed} ${label}: part ${plan.partId} rendered text is not a prefix of its final text: "${rendered}"`
      ).toBe(true);
      expect(
        rendered.length,
        `seed ${seed} ${label}: part ${plan.partId} rendered text ran ahead of delivered stream`
      ).toBeLessThanOrEqual(deliveredText.length);
      const previousLength = lastRendered.get(plan.partId) ?? 0;
      expect(
        rendered.length,
        `seed ${seed} ${label}: part ${plan.partId} rendered text shrank from ${previousLength} to ${rendered.length}`
      ).toBeGreaterThanOrEqual(previousLength);
      lastRendered.set(plan.partId, rendered.length);
    }
  };

  const maybeInjectRaces = () => {
    // Stale part snapshot: the server re-sends a part with the text it had
    // at some earlier point of the stream.
    if (announced.length > 0 && rng() < 0.2) {
      const plan = announced[randomInt(rng, 0, announced.length - 1)]!;
      const deliveredText = delivered.get(plan.partId) ?? '';
      const staleText = deliveredText.slice(0, randomInt(rng, 0, deliveredText.length));
      upsertPart(streamedPartSnapshot(plan.partId, plan.type, staleText, MESSAGE_ID, SESSION_ID));
      checkInvariants('after stale part snapshot');
    }
    // Stale mid-run refresh: a full message list sync races the live stream.
    // Mirrors session-selection.ts, which passes preserveExtraParts while the
    // latest assistant message is still running.
    if (rng() < 0.12) {
      setMessagesIncremental(cloneEntriesWithStaleTexts(rng, delivered), {
        preserveExtraParts: true,
      });
      checkInvariants('after stale refresh');
    }
    if (rng() < 0.4) {
      flushFrame();
      checkInvariants('after frame flush');
    }
  };

  // Parts stream sequentially, matching how servers emit content blocks. Two
  // things make this adversarial anyway:
  //  - With up-front announcement (an initial sync that already contains all
  //    parts), the transition from one part to the next happens without a
  //    flush in between, so deltas of both parts share a frame — the
  //    "superseded in the same frame" family of flush paths.
  //  - The finalized snapshot of a part can arrive late, while the next part
  //    is already streaming, racing the previous-part commit logic.
  const announceUpfront = rng() < 0.5;
  if (announceUpfront) {
    for (const plan of plans) {
      upsertPart(streamedPartSnapshot(plan.partId, plan.type, '', MESSAGE_ID, SESSION_ID));
      announced.push(plan);
      delivered.set(plan.partId, '');
    }
    checkInvariants('after up-front part announcements');
  }

  const pendingFinalize: PartPlan[] = [];
  const sendFinalizedSnapshot = (plan: PartPlan) => {
    upsertPart(
      streamedPartSnapshot(plan.partId, plan.type, plan.finalText, MESSAGE_ID, SESSION_ID)
    );
    checkInvariants('after finalized part snapshot');
  };

  for (const plan of plans) {
    if (!announceUpfront) {
      upsertPart(streamedPartSnapshot(plan.partId, plan.type, '', MESSAGE_ID, SESSION_ID));
      announced.push(plan);
      delivered.set(plan.partId, '');
      checkInvariants('after part announcement');
    }

    for (const chunk of plan.chunks) {
      applyMessagePartDelta(MESSAGE_ID, plan.partId, chunk, SESSION_ID);
      delivered.set(plan.partId, delivered.get(plan.partId)! + chunk);
      maybeInjectRaces();
      // Occasionally close out an earlier part only now, mid-stream of the
      // current part.
      if (pendingFinalize.length > 0 && rng() < 0.3) {
        sendFinalizedSnapshot(pendingFinalize.shift()!);
      }
    }

    // The server closes out every streamed part with a finalized snapshot —
    // sometimes immediately, sometimes while the next part streams.
    if (rng() < 0.5) {
      sendFinalizedSnapshot(plan);
    } else {
      pendingFinalize.push(plan);
    }
  }

  flushFrame();
  checkInvariants('after all deltas delivered');
  for (const plan of pendingFinalize) {
    sendFinalizedSnapshot(plan);
  }

  flushFrame();
  finishMessageStreaming(MESSAGE_ID);

  const entry = state.messages.find((m) => m.info.id === MESSAGE_ID);
  expect(entry, `seed ${seed}: message disappeared`).toBeTruthy();
  for (const plan of plans) {
    const part = entry!.parts.find((p) => p.id === plan.partId);
    expect(part, `seed ${seed}: part ${plan.partId} missing after stream ended`).toBeTruthy();
    expect(
      part!.type === 'text' || part!.type === 'reasoning' ? part!.text : null,
      `seed ${seed}: part ${plan.partId} final committed text diverged`
    ).toBe(plan.finalText);
  }
  expect(state.streamingPartId, `seed ${seed}: streaming part id not cleared`).toBeNull();
  expect(state.streamingText, `seed ${seed}: streaming text not cleared`).toBe('');
}

describe('streaming pipeline fuzz', () => {
  beforeEach(() => {
    clearMessages();
    clearStreamingState();
  });

  const seeds = Array.from({ length: 40 }, (_, i) => i + 1);
  for (const seed of seeds) {
    it(`renders monotonically growing prefixes and settles exactly (seed ${seed})`, () => {
      runScenario(seed);
    });
  }
});
