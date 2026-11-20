import { ariaBoolean } from '../lib/aria';
import { createSignal } from 'solid-js';
import { render } from '@solidjs/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissComposerOverlays } from './chat-input/composer-overlay-dismiss';
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
  it('attaches to an editor-owned element without moving or removing it', async () => {
    const editor = document.createElement('div');
    const chip = document.createElement('span');
    chip.textContent = 'Problems 1';
    editor.appendChild(chip);
    container.appendChild(editor);
    const tooltipRoot = document.createElement('div');
    container.appendChild(tooltipRoot);
    cleanup = render(
      () => <Tooltip target={chip} content="Captured problem" delay={0} />,
      tooltipRoot
    );
    expect(chip.parentNode).toBe(editor);
    chip.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Captured problem');
    cleanup();
    cleanup = undefined;
    expect(chip.parentNode).toBe(editor);
    expect(chip.hasAttribute('aria-describedby')).toBe(false);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
  it('does not install global composer-dismiss listeners while dormant', () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');
    try {
      cleanup = render(
        () => (
          <>
            <Tooltip content="First detail">
              <button>First</button>
            </Tooltip>
            <Tooltip content="Second detail">
              <button>Second</button>
            </Tooltip>
            <Tooltip content="Third detail">
              <button>Third</button>
            </Tooltip>
          </>
        ),
        container
      );

      expect(
        addEventListener.mock.calls.filter(([type]) => type === 'varro:composer-overlay-dismiss')
      ).toHaveLength(0);
    } finally {
      addEventListener.mockRestore();
    }
  });

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

  it('renders a description panel without an arrow', async () => {
    cleanup = render(
      () => (
        <Tooltip content="Goal description" variant="panel">
          <button>Goal</button>
        </Tooltip>
      ),
      container
    );
    container.querySelector('button')?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(DEFAULT_TOOLTIP_DELAY);
    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip?.classList.contains('panel')).toBe(true);
    expect(tooltip?.textContent).toBe('Goal description');
    expect(tooltip?.querySelector('.themed-tooltip-arrow')).toBeNull();
  });

  it('aligns a description panel above the full owning row and follows resizing', async () => {
    let width = 420;
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.id === 'goal-row') return new DOMRect(20, 500, width, 28);
        if (this.getAttribute('role') === 'tooltip')
          return new DOMRect(0, 0, Number.parseFloat(this.style.width), 60);
        return new DOMRect(40, 508, 200, 14);
      });
    try {
      cleanup = render(
        () => (
          <div id="goal-row">
            <Tooltip
              content="Goal description"
              variant="panel"
              anchor={() => container.querySelector<HTMLElement>('#goal-row') ?? undefined}
            >
              <button>Goal</button>
            </Tooltip>
          </div>
        ),
        container
      );
      container.querySelector('button')?.dispatchEvent(new MouseEvent('mouseenter'));
      await vi.advanceTimersByTimeAsync(DEFAULT_TOOLTIP_DELAY);
      const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]');
      expect(tooltip?.style.width).toBe('420px');
      expect(tooltip?.style.left).toBe('20px');
      expect(tooltip?.style.top).toBe('433px');
      width = 240;
      window.dispatchEvent(new Event('resize'));
      await vi.waitFor(() => expect(tooltip?.style.width).toBe('240px'));
      expect(tooltip?.style.left).toBe('20px');
      expect(tooltip?.style.top).toBe('433px');
    } finally {
      rect.mockRestore();
    }
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

  it('supports tooltips to the left of their trigger', async () => {
    cleanup = render(
      () => (
        <Tooltip content="Side detail" placement="left" delay={0}>
          <button>Run</button>
        </Tooltip>
      ),
      container
    );

    container.querySelector('button')?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(0);

    expect(document.querySelector('[role="tooltip"]')?.classList.contains('left')).toBe(true);
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
          <button aria-expanded={ariaBoolean(expanded())}>Choose</button>
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

  it('cancels pending and visible tooltips when the composer dismisses overlays', async () => {
    cleanup = render(
      () => (
        <Tooltip content="Composer action" delay={250}>
          <button>Run</button>
        </Tooltip>
      ),
      container
    );

    const button = container.querySelector('button');
    button?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(249);
    dismissComposerOverlays();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    button?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(250);
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();

    dismissComposerOverlays();
    await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).toBeNull());
  });
});
