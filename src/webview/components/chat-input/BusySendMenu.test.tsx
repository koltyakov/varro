import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { BusySendMenu } from './BusySendMenu';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
});

describe('BusySendMenu', () => {
  it('renders all busy-send actions and assigns the menu ref', () => {
    const onQueue = vi.fn();
    const onSteer = vi.fn();
    const onStopAndSend = vi.fn();
    let menuRef: HTMLDivElement | undefined;

    cleanup = render(
      () =>
        BusySendMenu({
          ref: (el) => {
            menuRef = el;
          },
          onQueue,
          onSteer,
          onStopAndSend,
        }),
      container!
    );

    expect(menuRef).toBeInstanceOf(HTMLDivElement);
    expect(menuRef?.className).toContain('busy-menu');
    expect(container?.textContent).toContain('Add to Queue');
    expect(container?.textContent).toContain('Steer with Message');
    expect(container?.textContent).toContain('Stop and Send');
    expect(container?.textContent).toContain('Enter');
  });

  it('dispatches each action without bubbling clicks outside the menu', () => {
    const onQueue = vi.fn();
    const onSteer = vi.fn();
    const onStopAndSend = vi.fn();
    const outerClick = vi.fn();

    cleanup = render(
      () => (
        <div onClick={outerClick}>
          <BusySendMenu onQueue={onQueue} onSteer={onSteer} onStopAndSend={onStopAndSend} />
        </div>
      ),
      container!
    );

    const buttons = container?.querySelectorAll<HTMLButtonElement>('button');
    expect(buttons).toHaveLength(3);

    buttons?.[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    buttons?.[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    buttons?.[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onQueue).toHaveBeenCalledOnce();
    expect(onSteer).toHaveBeenCalledOnce();
    expect(onStopAndSend).toHaveBeenCalledOnce();
    expect(outerClick).not.toHaveBeenCalled();
  });
});
