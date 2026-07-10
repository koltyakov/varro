import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cleanupBridge: vi.fn(),
  clearStartupHandlers: vi.fn(),
  disposeSolid: vi.fn(),
  render: vi.fn<() => () => void>(),
}));

vi.mock('solid-js/web', () => ({ render: mocks.render }));
vi.mock('./App', () => ({ AppRoot: () => null }));
vi.mock('./lib/bridge', () => ({ cleanupBridge: mocks.cleanupBridge }));

import { bootstrap } from './index';

let root: HTMLDivElement;
let cleanup: (() => void) | undefined;
const STARTUP_HANDLERS_KEY = '__clearVarroBootstrapFailureHandlers';
const bootstrapWindow = window as unknown as Record<string, unknown>;

describe('webview bootstrap', () => {
  beforeEach(() => {
    mocks.cleanupBridge.mockReset();
    mocks.clearStartupHandlers.mockReset();
    mocks.disposeSolid.mockReset();
    mocks.render.mockReset();
    mocks.render.mockReturnValue(mocks.disposeSolid);
    bootstrapWindow[STARTUP_HANDLERS_KEY] = mocks.clearStartupHandlers;
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    root.remove();
    delete bootstrapWindow[STARTUP_HANDLERS_KEY];
  });

  it('renders a fallback when the initial render throws', () => {
    mocks.render.mockImplementationOnce(() => {
      throw new Error('boot failed');
    });

    cleanup = bootstrap(root);

    expect(root.textContent).toContain('Something went wrong');
    expect(root.textContent).not.toContain('boot failed');
    expect(mocks.clearStartupHandlers).toHaveBeenCalledOnce();
    expect(mocks.cleanupBridge).toHaveBeenCalledOnce();
  });

  it('clears startup handlers without cleaning up after a successful render', () => {
    cleanup = bootstrap(root);

    expect(mocks.clearStartupHandlers).toHaveBeenCalledOnce();
    expect(mocks.cleanupBridge).not.toHaveBeenCalled();
    expect(mocks.disposeSolid).not.toHaveBeenCalled();
  });

  it('does not retain global startup handlers during normal actions', () => {
    cleanup = bootstrap(root);

    window.dispatchEvent(new Event('error', { cancelable: true }));
    window.dispatchEvent(new Event('unhandledrejection', { cancelable: true }));

    expect(root.textContent).not.toContain('Something went wrong');
    expect(mocks.cleanupBridge).not.toHaveBeenCalled();
  });

  it('cleans up Solid and the bridge during normal bootstrap disposal', () => {
    cleanup = bootstrap(root);
    cleanup();
    cleanup = undefined;

    expect(mocks.disposeSolid).toHaveBeenCalledOnce();
    expect(mocks.cleanupBridge).toHaveBeenCalledOnce();
  });
});
