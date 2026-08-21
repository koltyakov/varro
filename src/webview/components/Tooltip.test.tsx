import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TOOLTIP_DELAY, Tooltip } from './Tooltip';

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
  vi.useRealTimers();
});

describe('Tooltip', () => {
  it('uses the default delay and associates the tooltip with its trigger', async () => {
    cleanup = render(
      () => (
        <Tooltip content="Helpful detail">
          <button aria-label="Action">Run</button>
        </Tooltip>
      ),
      container
    );

    const button = container.querySelector('button');
    expect(button?.getAttribute('title')).toBeNull();
    expect(button?.getAttribute('aria-describedby')).toBeTruthy();

    button?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(DEFAULT_TOOLTIP_DELAY - 1);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe('Helpful detail');
    expect(tooltip?.querySelector('.themed-tooltip-arrow')).not.toBeNull();
    expect(tooltip?.classList.contains('bottom')).toBe(true);
  });

  it('supports a per-tooltip delay and cancels before it elapses', async () => {
    cleanup = render(
      () => (
        <Tooltip content="Quick detail" delay={250}>
          <button>Run</button>
        </Tooltip>
      ),
      container
    );

    const button = container.querySelector('button');
    button?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(249);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    button?.dispatchEvent(new MouseEvent('mouseleave'));
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('does not show when disabled', async () => {
    cleanup = render(
      () => (
        <Tooltip content="Hidden detail" delay={0} disabled>
          <button>Run</button>
        </Tooltip>
      ),
      container
    );

    container.querySelector('button')?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.runAllTimersAsync();

    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('hides and stays hidden while a dropdown is expanded', async () => {
    const [expanded, setExpanded] = createSignal(false);
    cleanup = render(
      () => (
        <Tooltip content="Choose an option" delay={0}>
          <button aria-expanded={expanded()}>Choose</button>
        </Tooltip>
      ),
      container
    );

    const button = container.querySelector('button');
    button?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.runAllTimersAsync();
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();

    setExpanded(true);
    await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).toBeNull());

    button?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.runAllTimersAsync();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});
