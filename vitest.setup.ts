import cssEscape from 'css.escape';
import type * as Solid from 'solid-js';
import type * as Signals from '@solidjs/signals';
import type * as SolidWeb from '@solidjs/web';
import { afterEach, beforeEach, vi } from 'vitest';
import { isString } from './src/shared/type-utils';

// resetModules must reload application state, not split Solid's owner graph between
// top-level test imports and dynamically imported hooks/components. Mock factories
// stay cached across resets and return the real runtime without replacing any APIs.
/* oxlint-disable anti-slop/no-module-mocking -- Preserve the real Solid runtime across application module resets. */
vi.mock('solid-js', async (importOriginal) => importOriginal<typeof Solid>());
vi.mock('@solidjs/signals', async (importOriginal) => importOriginal<typeof Signals>());
vi.mock('@solidjs/web', async (importOriginal) => importOriginal<typeof SolidWeb>());
/* oxlint-enable anti-slop/no-module-mocking */

if (!globalThis.CSS) {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: {},
    writable: true,
  });
}
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- The test environment may provide an incomplete CSS runtime that requires a polyfill.
if (typeof globalThis.CSS.escape !== 'function') {
  Object.defineProperty(globalThis.CSS, 'escape', {
    configurable: true,
    value: cssEscape,
    writable: true,
  });
}

// Solid's dev runtime only warns about untracked reactive reads, so the warnings
// scroll past in passing runs. Fail the test that produced one instead.
// Follow-up guide lines share the prefix; only the read itself is counted.
const STRICT_READ_WARNING = '[STRICT_READ_UNTRACKED] Reactive value';
/* oxlint-disable no-console -- The guard wraps console.warn to observe Solid diagnostics. */
const consoleWarn = console.warn.bind(console);
let strictReadWarnings: string[] = [];
console.warn = (...args: unknown[]) => {
  const first = args[0];
  if (isString(first) && first.startsWith(STRICT_READ_WARNING)) strictReadWarnings.push(first);
  consoleWarn(...args);
};
/* oxlint-enable no-console */

afterEach(() => {
  const warnings = strictReadWarnings;
  strictReadWarnings = [];
  if (warnings.length > 0)
    throw new Error(
      `Solid reported ${warnings.length} untracked reactive read(s):\n${[...new Set(warnings)].join('\n')}`
    );
});

beforeEach(() => {
  strictReadWarnings = [];
  window.localStorage.clear();
  Reflect.deleteProperty(window, '__initialWebviewState');
  Reflect.deleteProperty(window, '__initialTheme');
});
