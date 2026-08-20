import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const entryRoot = document.createElement('div');
  entryRoot.id = 'root';
  document.body.appendChild(entryRoot);
  return {
    cleanupBridge: vi.fn(),
    clearStartupHandlers: vi.fn(),
    disposeSolid: vi.fn(),
    entryRoot,
    render: vi.fn<() => () => void>(),
  };
});

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise the webview entry module's integration boundaries. */
vi.mock('solid-js/web', () => ({ render: mocks.render }));
vi.mock('./App', () => ({ AppRoot: () => null }));
vi.mock('./lib/bridge', () => ({ cleanupBridge: mocks.cleanupBridge }));

import { bootstrap, bootstrapWebview } from './index';
import { fixture } from './test-fixtures';
import type { UnknownRecord } from '../shared/type-utils';

mocks.entryRoot.remove();

let root: HTMLDivElement;
let cleanup: (() => void) | undefined;
let consoleError: ReturnType<typeof vi.spyOn>;
const STARTUP_HANDLERS_KEY = '__clearVarroBootstrapFailureHandlers';
// SAFETY: The fixture provides the unknown fields read by this statement.
const bootstrapWindow = fixture<UnknownRecord>(window);

describe('webview bootstrap', () => {
  beforeEach(() => {
    mocks.cleanupBridge.mockReset();
    mocks.clearStartupHandlers.mockReset();
    mocks.disposeSolid.mockReset();
    mocks.render.mockReset();
    mocks.render.mockReturnValue(mocks.disposeSolid);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    bootstrapWindow[STARTUP_HANDLERS_KEY] = mocks.clearStartupHandlers;
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    root.remove();
    delete bootstrapWindow[STARTUP_HANDLERS_KEY];
    consoleError.mockRestore();
  });

  it('renders a fallback when the initial render throws', () => {
    const error = new Error('boot failed');
    mocks.render.mockImplementationOnce(() => {
      throw error;
    });

    cleanup = bootstrap(root);

    expect(root.textContent).toContain('Something went wrong');
    expect(root.textContent).not.toContain('boot failed');
    expect(mocks.clearStartupHandlers).toHaveBeenCalledOnce();
    expect(mocks.cleanupBridge).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith('Varro webview bootstrap failed', error);
  });

  it('logs and cleans up safely when the root element is missing', () => {
    const result = bootstrapWebview(null);

    expect(result).toBeUndefined();
    expect(mocks.clearStartupHandlers).toHaveBeenCalledOnce();
    expect(mocks.cleanupBridge).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      'Varro webview bootstrap failed',
      expect.objectContaining({ message: 'Webview root element not found' })
    );
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

  it('logs disposal errors and still cleans up the bridge', () => {
    const error = new Error('dispose failed');
    mocks.disposeSolid.mockImplementationOnce(() => {
      throw error;
    });
    cleanup = bootstrap(root);

    cleanup();
    cleanup = undefined;

    expect(consoleError).toHaveBeenCalledWith('Varro webview disposal failed', error);
    expect(mocks.cleanupBridge).toHaveBeenCalledOnce();
  });

  it('logs bridge cleanup errors after rendering the safe fallback', () => {
    const bootError = new Error('boot failed');
    const cleanupError = new Error('bridge cleanup failed');
    mocks.render.mockImplementationOnce(() => {
      throw bootError;
    });
    mocks.cleanupBridge.mockImplementationOnce(() => {
      throw cleanupError;
    });

    cleanup = bootstrap(root);

    expect(root.textContent).toContain('Something went wrong');
    expect(root.textContent).not.toContain('boot failed');
    expect(consoleError).toHaveBeenCalledWith('Varro webview bridge cleanup failed', cleanupError);
  });
});
