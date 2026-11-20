import { createMemo, createRoot, createSignal, OBSERVE } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { suppressExpectedHugeFanIn } from './expected-solid-diagnostics';

/* oxlint-disable eslint/no-console -- Exercise the diagnostic filter and verify unrelated output is forwarded. */
describe('expected Solid diagnostics', () => {
  let warn: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  let error: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;

  beforeEach(() => {
    warn = vi.fn();
    error = vi.fn();
    vi.stubGlobal('console', {
      ...console,
      warn: (...args: unknown[]) => warn(...args),
      error: (...args: unknown[]) => error(...args),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('filters only the named fan-in computation, including its attached repair guide', () => {
    const restore = suppressExpectedHugeFanIn(['fixture-total']);
    console.warn(
      '[HUGE_FAN_IN] Computation "fixture-total" tracked 80004 sources.\n' +
        '  in fixture-total\n[HUGE_FAN_IN] agent repair guide: guide'
    );
    expect(warn).not.toHaveBeenCalled();

    const otherComputation = '[HUGE_FAN_IN] Computation "unexpected" tracked 2001 sources.';
    const otherCode = '[HUGE_FAN_OUT] Signal "fixture-total" changed with 2001 subscribers.';
    const standaloneGuide = '[HUGE_FAN_IN] agent repair guide: guide';
    const detail = { count: 2001 };
    console.warn(otherComputation, detail);
    console.warn(otherCode);
    console.warn(standaloneGuide);
    console.warn('Application warning');
    console.warn(detail);
    console.error('[HUGE_FAN_IN] Computation "fixture-total" tracked 80004 sources.');
    expect(warn.mock.calls).toEqual([
      [otherComputation, detail],
      [otherCode],
      [standaloneGuide],
      ['Application warning'],
      [detail],
    ]);
    expect(error).toHaveBeenCalledOnce();
    restore();
  });

  it('restores warnings before normal interactions and allows repeated cleanup', () => {
    const restore = suppressExpectedHugeFanIn(['fixture-total']);
    restore();
    restore();
    const message = '[HUGE_FAN_IN] Computation "fixture-total" tracked 80004 sources.';
    console.warn(message);
    expect(warn).toHaveBeenCalledExactlyOnceWith(message);
  });

  it('keeps real Solid findings on the structured diagnostics channel', () => {
    const capture = OBSERVE!.diagnostics.capture();
    const restore = suppressExpectedHugeFanIn(['deliberately-wide-test-observer']);
    try {
      createRoot((dispose) => {
        try {
          const sources = Array.from({ length: 2001 }, () => createSignal(1)[0]);
          const total = createMemo(() => sources.reduce((sum, read) => sum + read(), 0), {
            name: 'deliberately-wide-test-observer',
          });
          expect(total()).toBe(2001);
          expect(warn).not.toHaveBeenCalled();
          expect(capture.events).toContainEqual(
            expect.objectContaining({
              code: 'HUGE_FAN_IN',
              nodeName: 'deliberately-wide-test-observer',
              data: { count: 2001 },
            })
          );
          const unexpected = createMemo(() => sources.reduce((sum, read) => sum + read(), 0), {
            name: 'unexpected-application-computation',
          });
          expect(unexpected()).toBe(2001);
          expect(warn).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining(
              '[HUGE_FAN_IN] Computation "unexpected-application-computation" tracked 2001 sources.'
            )
          );
        } finally {
          dispose();
        }
      });
    } finally {
      restore();
      capture.stop();
    }
  });
});
/* oxlint-enable eslint/no-console */
