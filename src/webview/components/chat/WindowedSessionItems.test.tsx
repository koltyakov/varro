import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { expect, it } from 'vitest';
import { WindowedSessionItems } from './WindowedSessionItems';

it('bounds mounted rows and retains distant keyboard and action owners', () => {
  const container = document.createElement('div');
  container.className = 'session-list-scroll';
  document.body.append(container);
  const [focused, setFocused] = createSignal(-1);
  const ids = Array.from({ length: 2000 }, (_, index) => `session-${index}`);
  const dispose = render(
    () => (
      <WindowedSessionItems ids={ids} focusedIndex={focused()} retainedIds={['session-1999']}>
        {(id, index, observe) => (
          <div ref={observe} data-session-id={id}>
            {index()}
          </div>
        )}
      </WindowedSessionItems>
    ),
    container
  );
  try {
    expect(container.querySelectorAll('[data-session-id]').length).toBeLessThan(30);
    expect(container.querySelector('[data-session-id="session-1999"]')).not.toBeNull();
    setFocused(1000);
    expect(container.querySelector('[data-session-id="session-1000"]')?.textContent).toBe('1000');
    container.scrollTop = 64 * 1500;
    container.dispatchEvent(new Event('scroll'));
    expect(container.querySelector('[data-session-id="session-1500"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-session-id]').length).toBeLessThan(35);
  } finally {
    dispose();
    container.remove();
  }
});
