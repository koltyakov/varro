import { createRoot } from 'solid-js';
import { expect } from 'vitest';
import type { AssistantMessage, Message, Part, TextPart, UserMessage } from '../types';

export function createPerfRoot(register: () => void) {
  return createRoot((dispose) => {
    register();
    return dispose;
  });
}

export async function settlePerfEffects(turns = 2) {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

export async function expectEffectDependencyIsolation(args: {
  label: string;
  getCount(): number;
  mutate(): void | Promise<void>;
  settle?(): Promise<void>;
}) {
  const before = args.getCount();
  await args.mutate();
  await (args.settle?.() ?? settlePerfEffects());
  expect(args.getCount(), `${args.label} should ignore unrelated state changes`).toBe(before);
}

export function expectCachedCallBudget<T>(args: {
  label: string;
  run(): T;
  maxRatio?: number;
  minDurationMs?: number;
}) {
  const firstStartedAt = performance.now();
  const firstValue = args.run();
  const firstDuration = performance.now() - firstStartedAt;

  const secondStartedAt = performance.now();
  const secondValue = args.run();
  const secondDuration = performance.now() - secondStartedAt;

  expect(
    secondDuration,
    `${args.label} cached call should stay within the parse budget`
  ).toBeLessThanOrEqual(
    Math.max(firstDuration * (args.maxRatio ?? 0.25), args.minDurationMs ?? 0.5)
  );

  return {
    firstValue,
    secondValue,
    firstDuration,
    secondDuration,
  };
}

// Shared message fixtures for perf scenarios in session-1.

export function createAssistantMessage(id: string): AssistantMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: 'parent-1',
    modelID: 'gpt-4o',
    providerID: 'openai',
    mode: 'default',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

export function createUserMessage(id: string): UserMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-4o' },
  };
}

export function createTextPart(id: string, messageID: string, text: string): TextPart {
  return {
    id,
    sessionID: 'session-1',
    messageID,
    type: 'text',
    text,
  };
}

export function entry(info: Message, parts: Part[]) {
  return { info, parts };
}
