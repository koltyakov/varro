import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { McpPicker } from './McpPicker';
import { resetDefaultAppState, setState } from '../lib/state';
import type { McpStatus } from '../../shared/protocol';

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
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
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
});
