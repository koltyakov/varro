import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { McpPicker } from './McpPicker';
import { resetDefaultAppState, setState } from '../lib/state';
import type { McpStatus } from '../../shared/protocol';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
  startAuth: vi.fn(),
  completeAuth: vi.fn(),
  removeAuth: vi.fn(),
  status: vi.fn(),
}));

vi.mock('../lib/bridge', () => ({ postMessage: mocks.postMessage }));
vi.mock('../lib/client', () => ({
  client: {
    mcp: {
      startAuth: mocks.startAuth,
      completeAuth: mocks.completeAuth,
      removeAuth: mocks.removeAuth,
      status: mocks.status,
    },
  },
}));

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;

function setMcpStatuses(statuses: Record<string, McpStatus>) {
  setState('mcpStatus', statuses);
}

async function flushMicrotasks(count = 2) {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  resetDefaultAppState();
  container = document.createElement('div');
  document.body.appendChild(container);
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  mocks.startAuth.mockReset();
  mocks.completeAuth.mockReset();
  mocks.removeAuth.mockReset();
  mocks.status.mockReset();
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
  cleanup = undefined;
  container?.remove();
  container = null;
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  resetDefaultAppState();
  vi.restoreAllMocks();
});

describe('McpPicker', () => {
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

    cleanup = render(
      () =>
        McpPicker({
          sessionId: 'session-1',
          onChange: vi.fn(),
          onClose: vi.fn(),
        }),
      container!
    );
    await flushMicrotasks();

    const searchInput = container?.querySelector('input[aria-label="Search MCPs"]');
    expect(searchInput).toBeInstanceOf(HTMLInputElement);
    expect(document.activeElement).toBe(searchInput);

    expect(container?.textContent).toContain('Timed out');

    (searchInput as HTMLInputElement).value = 'needs auth';
    searchInput?.dispatchEvent(new Event('input', { bubbles: true }));
    await flushMicrotasks();

    expect(
      Array.from(container?.querySelectorAll('.dropdown-name') ?? []).map((item) =>
        item.textContent?.trim()
      )
    ).toEqual(['iota']);

    (searchInput as HTMLInputElement).value = 'missing';
    searchInput?.dispatchEvent(new Event('input', { bubbles: true }));
    await flushMicrotasks();

    expect(container?.textContent).toContain('No matching MCPs');
  });

  it('shows the empty fallback when no MCPs are available', () => {
    cleanup = render(
      () =>
        McpPicker({
          sessionId: 'session-1',
          onChange: vi.fn(),
          onClose: vi.fn(),
        }),
      container!
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
    setState('sessionSelectedMcps', { 'session-1': ['zeta'] });

    cleanup = render(
      () =>
        McpPicker({
          sessionId: 'session-1',
          onChange,
          onClose,
        }),
      container!
    );
    await flushMicrotasks();

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

    menu?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    );
    await flushMicrotasks();

    const focusedItem = container?.querySelector('.dropdown-item.keyboard-focus');
    expect(focusedItem?.textContent).toContain('zeta');

    menu?.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    );

    expect(onChange).toHaveBeenCalledWith([]);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });

    menu?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );

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

    cleanup = render(
      () =>
        McpPicker({
          sessionId: 'session-1',
          onChange,
          onClose,
        }),
      container!
    );
    await flushMicrotasks();

    const searchInput = container?.querySelector<HTMLInputElement>('[aria-label="Search MCPs"]');
    const spaceEvent = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    searchInput?.dispatchEvent(spaceEvent);
    expect(spaceEvent.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();

    const arrowEvent = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    searchInput?.dispatchEvent(arrowEvent);
    await flushMicrotasks();
    expect(arrowEvent.defaultPrevented).toBe(true);

    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    searchInput?.dispatchEvent(enterEvent);
    expect(enterEvent.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);

    const escapeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    searchInput?.dispatchEvent(escapeEvent);
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the original popup gap', async () => {
    setMcpStatuses({
      alpha: { status: 'connected' },
    });

    cleanup = render(
      () =>
        McpPicker({
          sessionId: 'session-1',
          onChange: vi.fn(),
          onClose: vi.fn(),
        }),
      container!
    );
    await flushMicrotasks();

    const anchor = container?.firstElementChild as HTMLDivElement | null;
    expect(anchor?.style.bottom).toBe('100%');
    expect(anchor?.style.paddingBottom).toBe('10px');
  });

  it('toggles MCPs against the connected defaults in a new chat draft', async () => {
    const onChange = vi.fn();
    setMcpStatuses({
      alpha: { status: 'connected' },
      'browser-bridge': { status: 'failed', error: 'Connection closed' },
    });

    cleanup = render(
      () =>
        McpPicker({
          sessionId: null,
          onChange,
          onClose: vi.fn(),
        }),
      container!
    );
    await flushMicrotasks();

    const items = Array.from(container!.querySelectorAll<HTMLButtonElement>('.dropdown-item'));
    const browserBridge = items.find((item) => item.textContent?.includes('browser-bridge'));
    browserBridge?.click();

    expect(onChange).toHaveBeenCalledWith(['alpha', 'browser-bridge']);
  });

  it('selects needs_auth MCPs and completes the explicit OAuth lifecycle', async () => {
    const onChange = vi.fn();
    setMcpStatuses({ oauth: { status: 'needs_auth' } });

    cleanup = render(
      () =>
        McpPicker({
          sessionId: 'session-1',
          onChange,
          onClose: vi.fn(),
        }),
      container!
    );
    await flushMicrotasks();

    container?.querySelector<HTMLButtonElement>('.dropdown-item')?.click();
    await vi.waitFor(() => expect(mocks.startAuth).toHaveBeenCalledWith('oauth'));

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
    document.querySelector<HTMLFormElement>('.provider-connect-form')?.requestSubmit();

    await vi.waitFor(() => expect(mocks.completeAuth).toHaveBeenCalledWith('oauth', 'oauth-code'));
    expect(mocks.status).toHaveBeenCalled();
  });

  it('rejects unsafe authorization URLs without opening them', async () => {
    mocks.startAuth.mockResolvedValue({
      authorizationUrl: 'http://mcp.example.com/authorize',
      oauthState: 'state-1',
    });
    setMcpStatuses({ oauth: { status: 'needs_auth' } });
    cleanup = render(
      () =>
        McpPicker({
          sessionId: 'session-1',
          onChange: vi.fn(),
          onClose: vi.fn(),
        }),
      container!
    );

    container?.querySelector<HTMLButtonElement>('.dropdown-item')?.click();

    await vi.waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Only HTTPS')
    );
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
    cleanup = render(
      () =>
        McpPicker({
          sessionId: 'session-1',
          onChange,
          onClose: vi.fn(),
        }),
      container!
    );

    container?.querySelector<HTMLButtonElement>('.dropdown-item')?.click();
    await flushMicrotasks();

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
    cleanup = render(
      () =>
        McpPicker({
          sessionId: 'session-1',
          onChange: vi.fn(),
          onClose: vi.fn(),
        }),
      container!
    );
    container?.querySelector<HTMLButtonElement>('.dropdown-item')?.click();
    await vi.waitFor(() => expect(mocks.startAuth).toHaveBeenCalledTimes(1));

    const removeButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Remove credentials')
    );
    removeButton?.click();

    await vi.waitFor(() => expect(mocks.removeAuth).toHaveBeenCalledWith('oauth'));
    await vi.waitFor(() => expect(mocks.startAuth).toHaveBeenCalledTimes(2));
    expect(mocks.status).toHaveBeenCalled();
  });
});
