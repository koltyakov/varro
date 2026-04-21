import { beforeEach } from 'vitest';

beforeEach(() => {
  window.localStorage.clear();
  delete (window as unknown as { __initialWebviewState?: unknown }).__initialWebviewState;
  delete (window as unknown as { __initialTheme?: unknown }).__initialTheme;
});
