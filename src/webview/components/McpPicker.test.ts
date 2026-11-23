import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import { McpPicker } from './McpPicker';
import { resetDefaultAppState, setState, showMcpSettings, state } from '../lib/state';
import type { McpStatus } from '../../shared/protocol';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
  startAuth: vi.fn(),
  completeAuth: vi.fn(),
  removeAuth: vi.fn(),
  disconnect: vi.fn(),
  connect: vi.fn(),
  status: vi.fn(),
  setDefault: vi.fn(),
}));

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise MCP picker integration with bridge and client modules. */
vi.mock('../lib/bridge', () => ({ postMessage: mocks.postMessage }));
vi.mock('../lib/client', () => ({
  client: {
    mcp: {
      setDefault: mocks.setDefault,
      startAuth: mocks.startAuth,
      completeAuth: mocks.completeAuth,
      removeAuth: mocks.removeAuth,
      disconnect: mocks.disconnect,
      connect: mocks.connect,
      status: mocks.status,
    },
  },
}));

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

function mountView(view: Parameters<typeof render>[0]) {
  cleanup = render(view, container!);
  flushSolid();
}

function applyState(setter: Parameters<typeof setState>[0]) {
  setState(setter);
  flushSolid();
}
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;

function setMcpStatuses(statuses: Record<string, McpStatus>) {
  setState(storePath('mcpStatus', statuses));
}

async function flushMicrotasks(count = 2) {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  resetDefaultAppState();
  flushSolid();
  container = document.createElement('div');
  document.body.appendChild(container);
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  mocks.startAuth.mockReset();
  mocks.completeAuth.mockReset();
  mocks.removeAuth.mockReset();
  mocks.disconnect.mockReset().mockResolvedValue(true);
  mocks.connect.mockReset().mockResolvedValue(true);
  mocks.status.mockReset();
  mocks.setDefault.mockReset();
  mocks.postMessage.mockReset();
  mocks.startAuth.mockResolvedValue({
    authorizationUrl: 'https://mcp.example.com/authorize',
    oauthState: 'state-1',
  });
  mocks.completeAuth.mockResolvedValue({ status: 'connected' });
  mocks.removeAuth.mockResolvedValue({ success: true });
  mocks.status.mockResolvedValue({ oauth: { status: 'connected' } });
});

afterEach(() => {
  cleanup?.();
  flushSolid();
  cleanup = undefined;
  container?.remove();
  flushSolid();
  container = null;
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  flushSolid();
  resetDefaultAppState();
  flushSolid();
  vi.restoreAllMocks();
  flushSolid();
  vi.useRealTimers();
});

describe('McpPicker', () => {
  function renderConnectedOAuth() {
    setMcpStatuses({ oauth: { status: 'connected' }, local: { status: 'connected' } });
    setState(
      storePath('mcpDefaults', {
        global: { oauth: true, local: true },
        project: {},
        effective: { oauth: true, local: true },
        editable: true,
        oauthServers: ['oauth'],
      })
    );
    setState(storePath('sessionSelectedMcps', { 'session-1': ['oauth', 'local'] }));
    const onChange = vi.fn();
    cleanup = render(
      () => McpPicker({ sessionId: 'session-1', onChange, onClose: vi.fn() }),
      container!
    );
    return onChange;
  }

  function accountButton(label: 'Sign out of oauth' | 'Switch account for oauth') {
    return container!.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  }

  it('offers account actions only for connected OAuth-enabled servers', () => {
    renderConnectedOAuth();
    flushSolid();
    expect(accountButton('Sign out of oauth')).not.toBeNull();
    expect(accountButton('Switch account for oauth')).not.toBeNull();
    expect(container!.querySelector('[aria-label="Sign out of local"]')).toBeNull();
    setMcpStatuses({ oauth: { status: 'disabled' } });
    flushSolid();
    expect(container!.querySelector('.mcp-picker-account-actions')).toBeNull();
  });

  it.each(['needs_auth', 'needs_client_registration'] as const)(
    'only toggles selection on a %s row; authentication requires its own button',
    async (status) => {
      setMcpStatuses({ oauth: { status } });
      flushSolid();
      applyState(storePath('sessionSelectedMcps', { 'session-1': ['oauth'] }));
      const onChange = vi.fn((names: string[]) =>
        setState(storePath('sessionSelectedMcps', 'session-1', names))
      );
      mountView(() => McpPicker({ sessionId: 'session-1', onChange, onClose: vi.fn() }));
      container!.querySelector<HTMLButtonElement>('.dropdown-item')!.click();
      flushSolid();
      expect(onChange).toHaveBeenLastCalledWith([]);
      expect(mocks.startAuth).not.toHaveBeenCalled();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      container!
        .querySelector('.dropdown-menu')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        );
      flushSolid();
      expect(onChange).toHaveBeenLastCalledWith(['oauth']);
      expect(mocks.startAuth).not.toHaveBeenCalled();
      const action = container!.querySelector<HTMLButtonElement>('.mcp-picker-action')!;
      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      action.dispatchEvent(enter);
      flushSolid();
      expect(enter.defaultPrevented).toBe(false);
      const selectionChanges = onChange.mock.calls.length;
      action.click();
      flushSolid();
      await flushMicrotasks(6);
      flushSolid();
      expect(onChange).toHaveBeenCalledTimes(selectionChanges);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(mocks.startAuth).toHaveBeenCalledTimes(status === 'needs_auth' ? 1 : 0);
    }
  );

  it('disconnects and removes credentials without opening a browser or changing session selections', async () => {
    const onChange = renderConnectedOAuth();
    flushSolid();
    mocks.status.mockResolvedValue({
      oauth: { status: 'disabled' },
      local: { status: 'connected' },
    });
    accountButton('Sign out of oauth').click();
    flushSolid();
    await flushMicrotasks(6);
    flushSolid();
    expect(mocks.disconnect).toHaveBeenCalledExactlyOnceWith('oauth');
    expect(mocks.removeAuth).toHaveBeenCalledExactlyOnceWith('oauth');
    expect(mocks.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeAuth.mock.invocationCallOrder[0]!
    );
    expect(mocks.removeAuth.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.status.mock.invocationCallOrder[0]!
    );
    expect(container!.textContent).toContain('Signed out of oauth');
    expect(state.mcpStatus.oauth?.status).toBe('disabled');
    expect(state.mcpStatus.local?.status).toBe('connected');
    expect(state.sessionSelectedMcps['session-1']).toEqual(['oauth', 'local']);
    expect(onChange).not.toHaveBeenCalled();
    expect(mocks.startAuth).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(container!.querySelector('.dropdown-menu'));
  });

  it('starts a fresh authorization only after Switch account clears the old credentials', async () => {
    const onChange = renderConnectedOAuth();
    flushSolid();
    mocks.status.mockResolvedValue({
      oauth: { status: 'disabled' },
      local: { status: 'connected' },
    });
    accountButton('Switch account for oauth').click();
    flushSolid();
    await flushMicrotasks(16);
    flushSolid();
    expect(mocks.removeAuth).toHaveBeenCalledExactlyOnceWith('oauth');
    expect(mocks.startAuth).toHaveBeenCalledExactlyOnceWith('oauth');
    expect(mocks.removeAuth.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.startAuth.mock.invocationCallOrder[0]!
    );
    // OpenCode reconnects after sign-in only for servers that are not disabled.
    expect(mocks.connect).toHaveBeenCalledExactlyOnceWith('oauth');
    expect(mocks.connect.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.startAuth.mock.invocationCallOrder[0]!
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Choose the other account or customer tenant'
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'does not sign you out of that website'
    );
    expect(mocks.postMessage).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://mcp.example.com/authorize' },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(['disconnect', 'removeAuth'] as const)(
    'does not start new authorization when %s fails',
    async (operation) => {
      renderConnectedOAuth();
      flushSolid();
      mocks[operation].mockRejectedValue(new Error('Credential service unavailable'));
      mocks.status.mockResolvedValue({
        oauth: { status: operation === 'disconnect' ? 'connected' : 'disabled' },
        local: { status: 'connected' },
      });
      accountButton('Switch account for oauth').click();
      flushSolid();
      await flushMicrotasks(8);
      flushSolid();
      expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
        'Could not switch accounts for oauth'
      );
      expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
        'Credential service unavailable'
      );
      expect(mocks.startAuth).not.toHaveBeenCalled();
      expect(mocks.postMessage).not.toHaveBeenCalled();
      if (operation === 'disconnect') expect(mocks.removeAuth).not.toHaveBeenCalled();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }
  );

  it('reports a status refresh failure after credentials are removed without claiming the old login remains', async () => {
    renderConnectedOAuth();
    flushSolid();
    mocks.status.mockRejectedValue(new Error('Status unavailable'));
    accountButton('Switch account for oauth').click();
    flushSolid();
    await flushMicrotasks(8);
    flushSolid();
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
      'Credentials for oauth were removed'
    );
    expect(mocks.startAuth).not.toHaveBeenCalled();
  });

  it('does not claim sign-out succeeded if the server still reports an active connection', async () => {
    renderConnectedOAuth();
    flushSolid();
    accountButton('Sign out of oauth').click();
    flushSolid();
    await flushMicrotasks(8);
    flushSolid();
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain('still connected');
    expect(container!.textContent).not.toContain('Signed out of oauth');
    expect(mocks.startAuth).not.toHaveBeenCalled();
  });

  it('leaves Enter on account buttons to their native action and prevents duplicate submissions', async () => {
    renderConnectedOAuth();
    flushSolid();
    let finishRemoval!: () => void;
    mocks.removeAuth.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRemoval = resolve;
        })
    );
    const button = accountButton('Sign out of oauth');
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    flushSolid();
    expect(event.defaultPrevented).toBe(false);
    button.click();
    flushSolid();
    await flushMicrotasks(4);
    flushSolid();
    expect(button.disabled).toBe(true);
    accountButton('Switch account for oauth').click();
    flushSolid();
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    finishRemoval();
    await flushMicrotasks(6);
    flushSolid();
  });

  it('finishes clearing credentials but does not open authorization after the picker closes', async () => {
    renderConnectedOAuth();
    flushSolid();
    let finishRemoval!: () => void;
    mocks.removeAuth.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRemoval = resolve;
        })
    );
    accountButton('Switch account for oauth').click();
    flushSolid();
    await flushMicrotasks(4);
    flushSolid();
    cleanup?.();
    flushSolid();
    cleanup = undefined;
    finishRemoval();
    await flushMicrotasks(8);
    flushSolid();
    expect(mocks.removeAuth).toHaveBeenCalledTimes(1);
    expect(mocks.startAuth).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it('does not start credential removal in a new view after closing during disconnect', async () => {
    renderConnectedOAuth();
    flushSolid();
    let finishDisconnect!: () => void;
    mocks.disconnect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDisconnect = resolve;
        })
    );
    accountButton('Switch account for oauth').click();
    flushSolid();
    cleanup?.();
    flushSolid();
    cleanup = undefined;
    finishDisconnect();
    await flushMicrotasks(6);
    flushSolid();
    expect(mocks.removeAuth).not.toHaveBeenCalled();
    expect(mocks.startAuth).not.toHaveBeenCalled();
  });

  it('filters a small server list by the command argument and keeps search editable', () => {
    setMcpStatuses({
      atlassian: {
        status: 'needs_auth',
        error: 'MCP server "https://mcp.atlassian.com/v2/mcp" requires a login',
      },
      'browser-bridge': { status: 'disabled' },
      lightpanda: { status: 'disabled' },
    });
    flushSolid();
    mountView(() =>
      McpPicker({ sessionId: null, initialQuery: 'at', onChange: vi.fn(), onClose: vi.fn() })
    );
    const search = container!.querySelector<HTMLInputElement>('[aria-label="Search MCPs"]')!;
    expect(search.value).toBe('at');
    expect(document.activeElement).toBe(search);
    expect(container!.querySelectorAll('.dropdown-name')).toHaveLength(1);
    expect(container!.querySelector('.dropdown-name')?.textContent).toBe('atlassian');
    expect(container!.querySelector('.mcp-status-tag')).toBeNull();
    expect(container!.querySelector('.mcp-picker-error')).toBeNull();
    expect(container!.textContent).not.toContain('requires a login');
    expect(container!.querySelector('.mcp-picker-action')?.textContent).toBe('Sign in');
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    flushSolid();
    expect(container!.querySelectorAll('.dropdown-name')).toHaveLength(3);
    expect(container!.querySelector('[aria-label="Search MCPs"]')).toBe(search);
    search.value = 'sign in';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    flushSolid();
    expect(container!.querySelectorAll('.dropdown-name')).toHaveLength(1);
  });

  it('shows search only when more than eight MCPs exist and filters by name or status', async () => {
    setMcpStatuses({
      alpha: { status: 'connected' },
      beta: { status: 'disabled' },
      gamma: { status: 'failed', error: 'Timed out' },
      delta: { status: 'connected' },
      epsilon: { status: 'connected' },
      zeta: { status: 'connected' },
      eta: { status: 'connected' },
      theta: { status: 'connected' },
      iota: { status: 'needs_auth' },
    });
    flushSolid();

    mountView(() =>
      McpPicker({
        sessionId: 'session-1',
        onChange: vi.fn(),
        onClose: vi.fn(),
      })
    );
    await flushMicrotasks();
    flushSolid();

    const searchInput = container?.querySelector('input[aria-label="Search MCPs"]');
    expect(searchInput).toBeInstanceOf(HTMLInputElement);
    expect(document.activeElement).toBe(searchInput);

    expect(container?.textContent).toContain('Timed out');

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    (searchInput as HTMLInputElement).value = 'auth';
    searchInput?.dispatchEvent(new Event('input', { bubbles: true }));
    flushSolid();
    await flushMicrotasks();
    flushSolid();

    expect(
      Array.from(container?.querySelectorAll('.dropdown-name') ?? []).map((item) =>
        item.textContent?.trim()
      )
    ).toEqual(['iota']);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    (searchInput as HTMLInputElement).value = 'missing';
    searchInput?.dispatchEvent(new Event('input', { bubbles: true }));
    flushSolid();
    await flushMicrotasks();
    flushSolid();

    expect(container?.textContent).toContain('No matching MCPs');
  });

  it('shows the empty fallback when no MCPs are available', () => {
    mountView(() =>
      McpPicker({
        sessionId: 'session-1',
        onChange: vi.fn(),
        onClose: vi.fn(),
      })
    );

    expect(container?.querySelector('.dropdown-header')?.textContent).toBe('MCPs');
    expect(container?.textContent).toContain('No MCPs found');
    expect(container?.querySelector('input[aria-label="Search MCPs"]')).toBeNull();
  });

  it('wraps keyboard focus, toggles the focused MCP, and closes on escape', async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();

    setMcpStatuses({
      alpha: { status: 'connected' },
      zeta: { status: 'disabled' },
    });
    flushSolid();
    applyState(storePath('sessionSelectedMcps', { 'session-1': ['zeta'] }));

    mountView(() =>
      McpPicker({
        sessionId: 'session-1',
        onChange,
        onClose,
      })
    );
    await flushMicrotasks();
    flushSolid();

    const menu = container?.querySelector('.dropdown-menu');
    expect(menu).toBeInstanceOf(HTMLDivElement);
    expect(document.activeElement).toBe(menu);
    const items = Array.from(container!.querySelectorAll<HTMLButtonElement>('.dropdown-item'));
    expect(
      items.find((item) => item.textContent?.includes('alpha'))?.getAttribute('aria-pressed')
    ).toBe('false');
    expect(
      items.find((item) => item.textContent?.includes('zeta'))?.getAttribute('aria-pressed')
    ).toBe('true');
    const selectedIcon = items
      .find((item) => item.textContent?.includes('zeta'))
      ?.querySelector<HTMLElement>('.ui-icon');
    expect(selectedIcon?.style.getPropertyValue('--ui-icon-width')).toBe('12px');

    menu?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    );
    flushSolid();
    await flushMicrotasks();
    flushSolid();

    const focusedItem = container?.querySelector('.dropdown-item.keyboard-focus');
    expect(focusedItem?.textContent).toContain('zeta');

    menu?.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    );
    flushSolid();

    expect(onChange).toHaveBeenCalledWith([]);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });

    menu?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    flushSolid();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves Space to search input while retaining navigation and actions', async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    setMcpStatuses(
      Object.fromEntries(
        ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota'].map(
          (name) => [name, { status: 'connected' as const }]
        )
      )
    );
    flushSolid();

    mountView(() =>
      McpPicker({
        sessionId: 'session-1',
        onChange,
        onClose,
      })
    );
    await flushMicrotasks();
    flushSolid();

    const searchInput = container?.querySelector<HTMLInputElement>('[aria-label="Search MCPs"]');
    const spaceEvent = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    searchInput?.dispatchEvent(spaceEvent);
    flushSolid();
    expect(spaceEvent.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();

    const arrowEvent = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    searchInput?.dispatchEvent(arrowEvent);
    flushSolid();
    await flushMicrotasks();
    flushSolid();
    expect(arrowEvent.defaultPrevented).toBe(true);

    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    searchInput?.dispatchEvent(enterEvent);
    flushSolid();
    expect(enterEvent.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);

    const escapeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    searchInput?.dispatchEvent(escapeEvent);
    flushSolid();
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the original popup gap', async () => {
    setMcpStatuses({
      alpha: { status: 'connected' },
    });
    flushSolid();

    mountView(() =>
      McpPicker({
        sessionId: 'session-1',
        onChange: vi.fn(),
        onClose: vi.fn(),
      })
    );
    await flushMicrotasks();
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const anchor = container?.firstElementChild as HTMLDivElement | null;
    expect(anchor?.style.bottom).toBe('100%');
    expect(anchor?.style.paddingBottom).toBe('10px');
  });

  it('toggles MCPs against the connected defaults in a new chat draft', async () => {
    const onChange = vi.fn();
    applyState(
      storePath('mcpDefaults', {
        global: { alpha: true, 'browser-bridge': false },
        project: {},
        effective: { alpha: true, 'browser-bridge': false },
        editable: true,
      })
    );
    setMcpStatuses({
      alpha: { status: 'connected' },
      'browser-bridge': { status: 'failed', error: 'Connection closed' },
    });
    flushSolid();

    mountView(() =>
      McpPicker({
        sessionId: null,
        onChange,
        onClose: vi.fn(),
      })
    );
    await flushMicrotasks();
    flushSolid();

    const items = Array.from(container!.querySelectorAll<HTMLButtonElement>('.dropdown-item'));
    const browserBridge = items.find((item) => item.textContent?.includes('browser-bridge'));
    browserBridge?.click();
    flushSolid();

    expect(onChange).toHaveBeenCalledWith(['alpha', 'browser-bridge']);
  });

  it('keeps on-demand MCPs visible without adopting shared connections as session selections', () => {
    const onChange = vi.fn();
    applyState(
      storePath('mcpDefaults', {
        global: { rare: false, offline: false },
        project: {},
        effective: { rare: false, offline: false },
        editable: true,
      })
    );
    setMcpStatuses({ rare: { status: 'connected' } });
    flushSolid();
    mountView(() => McpPicker({ sessionId: 'fresh', onChange, onClose: vi.fn() }));
    const items = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('.dropdown-item[aria-pressed]')
    );
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.getAttribute('aria-pressed') === 'false')).toBe(true);
    items.find((item) => item.textContent?.includes('offline'))?.click();
    flushSolid();
    expect(onChange).toHaveBeenCalledWith(['offline']);
    expect(mocks.setDefault).not.toHaveBeenCalled();
  });

  it('offers just one settings button beyond the session toggles', () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    applyState(
      storePath('mcpDefaults', {
        global: { rare: false },
        project: {},
        effective: { rare: false },
        editable: true,
      })
    );
    applyState(storePath('sessionSelectedMcps', { current: [] }));
    mountView(() => McpPicker({ sessionId: 'current', onChange, onClose }));
    expect(container!.querySelectorAll('button')).toHaveLength(2);
    expect(container!.querySelector('select')).toBeNull();
    expect(container!.textContent).not.toContain('Use defaults');
    expect(container!.textContent).not.toContain('Connections are shared');
    const settings = container!.querySelector<HTMLButtonElement>('.dropdown-footer button')!;
    expect(settings.textContent).toBe('Manage MCPs');
    const icon = settings.querySelector('svg');
    expect(icon?.getAttribute('viewBox')).toBe('0 0 32 32');
    expect(icon?.classList.contains('h-[18px]')).toBe(true);
    expect(icon?.classList.contains('w-[18px]')).toBe(true);
    settings.click();
    flushSolid();
    expect(showMcpSettings()).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
    expect(mocks.setDefault).not.toHaveBeenCalled();
  });

  it('leaves Enter on the settings button to its native action rather than toggling an MCP', () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    setMcpStatuses({ alpha: { status: 'connected' } });
    flushSolid();
    mountView(() => McpPicker({ sessionId: null, onChange, onClose }));
    const settings = container!.querySelector<HTMLButtonElement>('.dropdown-footer button')!;
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    settings.dispatchEvent(event);
    flushSolid();
    expect(event.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    settings.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    flushSolid();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('selects needs_auth MCPs and completes the explicit OAuth lifecycle', async () => {
    const onChange = vi.fn();
    setMcpStatuses({ oauth: { status: 'needs_auth' } });
    flushSolid();

    mountView(() =>
      McpPicker({
        sessionId: 'session-1',
        onChange,
        onClose: vi.fn(),
      })
    );
    await flushMicrotasks();
    flushSolid();

    container?.querySelector<HTMLButtonElement>('.mcp-picker-action')?.click();
    flushSolid();
    await vi.waitFor(() => expect(mocks.startAuth).toHaveBeenCalledWith('oauth'));
    flushSolid();

    expect(onChange).toHaveBeenCalledWith(['oauth']);
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')).toBe(
      'mcp-auth-title'
    );
    expect(mocks.postMessage).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://mcp.example.com/authorize' },
    });

    const input = document.querySelector<HTMLInputElement>('.provider-connect-input');
    expect(input).toBeInstanceOf(HTMLInputElement);
    input!.value = 'oauth-code';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    flushSolid();
    document.querySelector<HTMLFormElement>('.provider-connect-form')?.requestSubmit();

    await vi.waitFor(() =>
      expect(mocks.completeAuth).toHaveBeenCalledWith('oauth', 'oauth-code', 'state-1')
    );
    flushSolid();
    expect(mocks.status).toHaveBeenCalled();
  });

  it.each([true, undefined])(
    'uses capability-specific wording for paste=%s without changing the submitted value',
    async (paste) => {
      mocks.startAuth.mockResolvedValue({
        authorizationUrl: 'https://mcp.example.com/authorize',
        oauthState: 'state-1',
        paste,
      });
      setMcpStatuses({ oauth: { status: 'needs_auth' } });
      flushSolid();
      mountView(() => McpPicker({ sessionId: null, onChange: vi.fn(), onClose: vi.fn() }));
      container!.querySelector<HTMLButtonElement>('.mcp-picker-action')!.click();
      flushSolid();
      await flushMicrotasks(6);
      flushSolid();
      const dialog = document.querySelector('[role="dialog"]')!;
      expect(dialog.querySelector('summary')?.textContent).toBe(
        paste ? 'Paste the browser redirect URL instead' : 'Use an authorization code instead'
      );
      expect(dialog.querySelector('details')?.open).toBe(paste === true);
      const input = dialog.querySelector<HTMLInputElement>('.provider-connect-input')!;
      expect(input.labels?.[0]?.textContent).toContain(
        paste ? 'Browser redirect URL' : 'Authorization code'
      );
      const value = paste
        ? 'http://localhost/callback?code=a%2Bb&state=opaque%2Fstate'
        : 'legacy-code';
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      flushSolid();
      dialog.querySelector<HTMLFormElement>('form')!.requestSubmit();
      await flushMicrotasks(6);
      flushSolid();
      expect(mocks.completeAuth).toHaveBeenCalledExactlyOnceWith('oauth', value, 'state-1');
    }
  );

  it('still detects automatic MCP authorization when the redirect URL fallback is open', async () => {
    vi.useFakeTimers();
    mocks.startAuth.mockResolvedValue({
      authorizationUrl: 'https://mcp.example.com/authorize',
      oauthState: 'state-1',
      paste: true,
    });
    mocks.status.mockResolvedValue({ oauth: { status: 'connected' } });
    setMcpStatuses({ oauth: { status: 'needs_auth' } });
    flushSolid();
    mountView(() => McpPicker({ sessionId: null, onChange: vi.fn(), onClose: vi.fn() }));
    container!.querySelector<HTMLButtonElement>('.mcp-picker-action')!.click();
    flushSolid();
    await flushMicrotasks(6);
    flushSolid();
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Authorization successful'
    );
    expect(mocks.completeAuth).not.toHaveBeenCalled();
  });

  it('does not submit a pasted MCP redirect twice while its request is pending', async () => {
    mocks.startAuth.mockResolvedValue({
      authorizationUrl: 'https://mcp.example.com/authorize',
      oauthState: 'state-1',
      paste: true,
    });
    let resolve!: (value: McpStatus) => void;
    mocks.completeAuth.mockReturnValue(
      new Promise<McpStatus>((done) => {
        resolve = done;
      })
    );
    setMcpStatuses({ oauth: { status: 'needs_auth' } });
    flushSolid();
    mountView(() => McpPicker({ sessionId: null, onChange: vi.fn(), onClose: vi.fn() }));
    container!.querySelector<HTMLButtonElement>('.mcp-picker-action')!.click();
    flushSolid();
    await flushMicrotasks(6);
    flushSolid();
    const form = document.querySelector<HTMLFormElement>('.provider-connect-form')!;
    const input = form.querySelector('input')!;
    input.value = 'http://localhost/callback?code=fixture';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSolid();
    form.requestSubmit();
    form.requestSubmit();
    await flushMicrotasks(6);
    flushSolid();
    expect(mocks.completeAuth).toHaveBeenCalledTimes(1);
    resolve({ status: 'connected' });
    flushSolid();
    await flushMicrotasks(6);
    flushSolid();
  });

  it('detects browser authorization without requiring a code and stops checking after connection', async () => {
    vi.useFakeTimers();
    mocks.status
      .mockResolvedValueOnce({ oauth: { status: 'needs_auth' } })
      .mockResolvedValueOnce({ oauth: { status: 'connected' } });
    setMcpStatuses({ oauth: { status: 'needs_auth' } });
    flushSolid();
    mountView(() => McpPicker({ sessionId: null, onChange: vi.fn(), onClose: vi.fn() }));
    container!.querySelector<HTMLButtonElement>('.mcp-picker-action')!.click();
    flushSolid();
    await flushMicrotasks(4);
    flushSolid();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('updates automatically');
    expect(dialog.querySelector('details')?.open).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(dialog.textContent).not.toContain('Authorization successful');
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(dialog.textContent).toContain('Authorization successful');
    expect(dialog.textContent).toContain('oauth is connected');
    expect(dialog.querySelector('input')).toBeNull();
    expect(container!.querySelector('.mcp-status-tag')?.textContent).toBe('connected');
    expect(mocks.completeAuth).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    flushSolid();
    expect(mocks.status).toHaveBeenCalledTimes(2);
    Array.from(dialog.querySelectorAll('button'))
      .find((button) => button.textContent === 'Done')!
      .click();
    flushSolid();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('reflects a server status event immediately without waiting for the next check', async () => {
    vi.useFakeTimers();
    setMcpStatuses({ oauth: { status: 'needs_auth' } });
    flushSolid();
    mountView(() => McpPicker({ sessionId: null, onChange: vi.fn(), onClose: vi.fn() }));
    container!.querySelector<HTMLButtonElement>('.mcp-picker-action')!.click();
    flushSolid();
    await flushMicrotasks(4);
    flushSolid();
    setMcpStatuses({ oauth: { status: 'connected' } });
    flushSolid();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Authorization successful'
    );
    await vi.advanceTimersByTimeAsync(2_000);
    flushSolid();
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.completeAuth).not.toHaveBeenCalled();
  });

  it('ignores an in-flight status check after the dialog closes', async () => {
    vi.useFakeTimers();
    let resolveStatus: ((statuses: Record<string, McpStatus>) => void) | undefined;
    mocks.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        })
    );
    setMcpStatuses({ oauth: { status: 'needs_auth' } });
    flushSolid();
    mountView(() => McpPicker({ sessionId: null, onChange: vi.fn(), onClose: vi.fn() }));
    container!.querySelector<HTMLButtonElement>('.mcp-picker-action')!.click();
    flushSolid();
    await flushMicrotasks(4);
    flushSolid();
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(mocks.status).toHaveBeenCalledTimes(1);
    document.querySelector<HTMLButtonElement>('.provider-connect-close')!.click();
    flushSolid();
    resolveStatus?.({ oauth: { status: 'connected' } });
    flushSolid();
    await flushMicrotasks(4);
    flushSolid();
    await vi.advanceTimersByTimeAsync(10_000);
    flushSolid();
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(container!.querySelector('.mcp-picker-action')?.textContent).toBe('Sign in');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('retries failed checks, bounds automatic refresh, and offers an explicit refresh afterward', async () => {
    vi.useFakeTimers();
    mocks.status.mockRejectedValueOnce(new Error('Status temporarily unavailable'));
    mocks.status.mockResolvedValue({ oauth: { status: 'needs_auth' } });
    setMcpStatuses({ oauth: { status: 'needs_auth' } });
    flushSolid();
    mountView(() => McpPicker({ sessionId: null, onChange: vi.fn(), onClose: vi.fn() }));
    container!.querySelector<HTMLButtonElement>('.mcp-picker-action')!.click();
    flushSolid();
    await flushMicrotasks(4);
    flushSolid();
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Status temporarily unavailable'
    );
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    flushSolid();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Still waiting for sign-in'
    );
    const checks = mocks.status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    flushSolid();
    expect(mocks.status).toHaveBeenCalledTimes(checks);
    mocks.status.mockResolvedValue({ oauth: { status: 'connected' } });
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find((button) => button.textContent === 'Refresh status')!
      .click();
    flushSolid();
    await flushMicrotasks(4);
    flushSolid();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Authorization successful'
    );
  });

  it('does not open OAuth after the authorization dialog is closed', async () => {
    let resolveAuth:
      | ((authorization: { authorizationUrl: string; oauthState: string }) => void)
      | undefined;
    mocks.startAuth.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAuth = resolve;
        })
    );
    setMcpStatuses({ oauth: { status: 'needs_auth' } });
    flushSolid();
    mountView(() =>
      McpPicker({
        sessionId: 'session-1',
        onChange: vi.fn(),
        onClose: vi.fn(),
      })
    );

    container?.querySelector<HTMLButtonElement>('.mcp-picker-action')?.click();
    flushSolid();
    await vi.waitFor(() => expect(mocks.startAuth).toHaveBeenCalledWith('oauth'));
    flushSolid();
    document.querySelector<HTMLButtonElement>('.provider-connect-close')?.click();
    flushSolid();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    resolveAuth?.({
      authorizationUrl: 'https://mcp.example.com/authorize',
      oauthState: 'state-1',
    });
    flushSolid();
    await flushMicrotasks(4);
    flushSolid();

    expect(mocks.postMessage).not.toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://mcp.example.com/authorize' },
    });
  });

  it('rejects unsafe authorization URLs without opening them', async () => {
    mocks.startAuth.mockResolvedValue({
      authorizationUrl: 'http://mcp.example.com/authorize',
      oauthState: 'state-1',
    });
    setMcpStatuses({ oauth: { status: 'needs_auth' } });
    flushSolid();
    mountView(() =>
      McpPicker({
        sessionId: 'session-1',
        onChange: vi.fn(),
        onClose: vi.fn(),
      })
    );

    container?.querySelector<HTMLButtonElement>('.mcp-picker-action')?.click();
    flushSolid();

    await vi.waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Only HTTPS')
    );
    flushSolid();
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it('shows configuration guidance without starting auth for client registration', async () => {
    const onChange = vi.fn();
    setMcpStatuses({
      registered: {
        status: 'needs_client_registration',
        error: 'Set clientId in opencode.json.',
      },
    });
    flushSolid();
    mountView(() =>
      McpPicker({
        sessionId: 'session-1',
        onChange,
        onClose: vi.fn(),
      })
    );

    container?.querySelector<HTMLButtonElement>('.mcp-picker-action')?.click();
    flushSolid();
    await flushMicrotasks();
    flushSolid();

    expect(onChange).toHaveBeenCalledWith(['registered']);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Add a client ID for this server'
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Set clientId in opencode.json.'
    );
    expect(mocks.startAuth).not.toHaveBeenCalled();
  });

  it('removes credentials and starts a fresh authorization flow', async () => {
    setMcpStatuses({ oauth: { status: 'needs_auth' } });
    flushSolid();
    mountView(() =>
      McpPicker({
        sessionId: 'session-1',
        onChange: vi.fn(),
        onClose: vi.fn(),
      })
    );
    container?.querySelector<HTMLButtonElement>('.mcp-picker-action')?.click();
    flushSolid();
    await vi.waitFor(() => expect(mocks.startAuth).toHaveBeenCalledTimes(1));
    flushSolid();

    const removeButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Remove credentials')
    );
    removeButton?.click();
    flushSolid();

    await vi.waitFor(() => expect(mocks.removeAuth).toHaveBeenCalledWith('oauth'));
    flushSolid();
    await vi.waitFor(() => expect(mocks.startAuth).toHaveBeenCalledTimes(2));
    flushSolid();
    expect(mocks.status).toHaveBeenCalled();
  });
});
