import cssEscape from 'css.escape';
import type * as Solid from 'solid-js';
import type * as SolidStore from 'solid-js/store';
import type * as SolidWeb from 'solid-js/web';
import { beforeEach, vi } from 'vitest';

// resetModules must reload application state, not split Solid's owner graph between
// top-level test imports and dynamically imported hooks/components. Mock factories
// stay cached across resets and return the real runtime without replacing any APIs.
/* oxlint-disable anti-slop/no-module-mocking -- Preserve the real Solid runtime across application module resets. */
vi.mock('solid-js', async (importOriginal) => importOriginal<typeof Solid>());
vi.mock('solid-js/store', async (importOriginal) => importOriginal<typeof SolidStore>());
vi.mock('solid-js/web', async (importOriginal) => importOriginal<typeof SolidWeb>());
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

beforeEach(() => {
  window.localStorage.clear();
  Reflect.deleteProperty(window, '__initialWebviewState');
  Reflect.deleteProperty(window, '__initialTheme');
});
