import cssEscape from 'css.escape';
import { beforeEach } from 'vitest';

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
