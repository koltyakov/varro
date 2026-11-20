import { onTestFinished, vi } from 'vitest';
import { isString } from '../shared/type-utils';

/**
 * Only for deliberately oversized fixtures or test-owned wide observers, never a whole suite.
 * Name each expected computation; other fan-in findings and diagnostic codes still reach stderr.
 * Restore before exercising normal interactions when only fixture setup is intentionally wide.
 */
export function suppressExpectedHugeFanIn(computations: readonly string[]): () => void {
  const expected = new Set(computations);
  // oxlint-disable-next-line eslint/no-console -- Forward every warning except the named fixture diagnostics.
  const warn = console.warn.bind(console);
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    const message = args[0];
    const computation = isString(message)
      ? /^\[HUGE_FAN_IN\] Computation "([^"]+)" tracked \d+ sources\./.exec(message)?.[1]
      : undefined;
    if (computation !== undefined && expected.has(computation)) return;
    warn(...args);
  });
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    spy.mockRestore();
  };
  onTestFinished(restore);
  return restore;
}
