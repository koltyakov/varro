import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import { BusySendMenu } from './BusySendMenu';
import { chatBubbleQuestionIcon } from '../../lib/ui-icons';
import { toCssUrl } from '../UiIcon';

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
  it('keeps incompatible side questions visible but disabled with an explanation', () => {
    const action = vi.fn();
    cleanup = render(
      () => (
        <BusySendMenu
          onQueue={() => {}}
          onSteer={() => {}}
          onStopAndSend={() => {}}
          onSideQuestion={action}
          sideQuestionDisabledReason="Side questions cannot use skills"
        />
      ),
      container!
    );
    const button = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.textContent?.trim() === 'Side question'
    )!;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Side questions cannot use skills');
    button.click();
    expect(action).not.toHaveBeenCalled();
  });
  it('renders all busy-send actions and assigns the menu ref', () => {
    const onQueue = vi.fn();
    const onSteer = vi.fn();
    const onStopAndSend = vi.fn();
    const onSideQuestion = vi.fn();
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
          onSideQuestion,
        }),
      container!
    );

    expect(menuRef).toBeInstanceOf(HTMLDivElement);
    expect(menuRef?.className).toContain('busy-menu');
    expect(
      [...container!.querySelectorAll('.busy-menu-label')].map((label) => label.textContent)
    ).toEqual(['Queue', 'Steer', 'Side question', 'Stop and Send']);
    const icon = menuRef?.querySelectorAll<HTMLElement>('.busy-menu-icon .ui-icon')[2];
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(chatBubbleQuestionIcon));
    expect(container?.textContent).toContain('Enter');
  });

  it('dispatches each action without bubbling clicks outside the menu', () => {
    const onQueue = vi.fn();
    const onSteer = vi.fn();
    const onStopAndSend = vi.fn();
    const onSideQuestion = vi.fn();
    const outerClick = vi.fn();

    cleanup = render(
      () => (
        <div onClick={outerClick}>
          <BusySendMenu
            onQueue={onQueue}
            onSteer={onSteer}
            onSideQuestion={onSideQuestion}
            onStopAndSend={onStopAndSend}
          />
        </div>
      ),
      container!
    );

    const buttons = container?.querySelectorAll<HTMLButtonElement>('button');
    expect(buttons).toHaveLength(4);

    buttons?.[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    buttons?.[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    buttons?.[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    buttons?.[3]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onQueue).toHaveBeenCalledOnce();
    expect(onSteer).toHaveBeenCalledOnce();
    expect(onStopAndSend).toHaveBeenCalledOnce();
    expect(onSideQuestion).toHaveBeenCalledOnce();
    expect(outerClick).not.toHaveBeenCalled();
  });

  it('omits Side question when it is unavailable', () => {
    cleanup = render(
      () => <BusySendMenu onQueue={() => {}} onSteer={() => {}} onStopAndSend={() => {}} />,
      container!
    );
    expect(
      [...container!.querySelectorAll('.busy-menu-label')].map((label) => label.textContent)
    ).toEqual(['Queue', 'Steer', 'Stop and Send']);
  });
});
