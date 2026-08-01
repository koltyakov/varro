import cssEscape from 'css.escape';
import { beforeEach } from 'vitest';

if (!globalThis.CSS) {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: {},
    writable: true,
  });
}
if (typeof globalThis.CSS.escape !== 'function') {
  Object.defineProperty(globalThis.CSS, 'escape', {
    configurable: true,
    value: cssEscape,
    writable: true,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  delete (window as unknown as { __initialWebviewState?: unknown }).__initialWebviewState;
  delete (window as unknown as { __initialTheme?: unknown }).__initialTheme;
});
