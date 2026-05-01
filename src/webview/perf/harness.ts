import { createRoot } from 'solid-js';
import { expect } from 'vitest';

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
