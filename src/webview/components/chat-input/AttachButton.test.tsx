import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_API_VERSION, registerHostExtension } from '../../host/extensions';
import { DEFAULT_TOOLTIP_DELAY } from '../Tooltip';
import { AttachButton } from './AttachButton';

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;
let disposeHost: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  disposeHost?.();
  disposeHost = undefined;
  container.remove();
  vi.useRealTimers();
});

describe('AttachButton', () => {
  it('explains the reliable VS Code drag route without changing the picker action', async () => {
    const onAttach = vi.fn();
    cleanup = render(() => <AttachButton onAttach={onAttach} />, container);
    const button = container.querySelector('button')!;
    button.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(DEFAULT_TOOLTIP_DELAY);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Attach files or folders. For drag and drop, hold Shift before entering VS Code.'
    );
    button.click();
    expect(onAttach).toHaveBeenCalledOnce();
  });

  it('does not suggest the VS Code workaround in another host', async () => {
    disposeHost = registerHostExtension({
      apiVersion: HOST_API_VERSION,
      id: 'test.host',
      metadata: { name: 'Other host', version: '1', repository: '', ideName: 'Other IDE' },
    });
    cleanup = render(() => <AttachButton onAttach={() => {}} />, container);
    container.querySelector('button')!.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(DEFAULT_TOOLTIP_DELAY);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Attach files or folders');
  });
});
