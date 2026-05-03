import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { DropOverlay } from './DropOverlay';

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

describe('DropOverlay', () => {
  it('renders the drop affordance into a body portal', () => {
    cleanup = render(() => DropOverlay(), container!);

    const overlay = document.body.querySelector('.chat-drop-overlay') as HTMLDivElement | null;

    expect(container?.querySelector('.chat-drop-overlay')).toBeNull();
    expect(overlay).toBeInstanceOf(HTMLDivElement);
    expect(overlay?.getAttribute('aria-hidden')).toBe('true');
    expect(overlay?.querySelector('.chat-drop-overlay-card')).toBeInstanceOf(HTMLDivElement);
    expect(overlay?.textContent).toContain('Drop to add to context');
  });

  it('removes the portal content when it unmounts', () => {
    cleanup = render(() => DropOverlay(), container!);

    expect(document.body.querySelector('.chat-drop-overlay')).toBeInstanceOf(HTMLDivElement);

    cleanup?.();
    cleanup = undefined;

    expect(document.body.querySelector('.chat-drop-overlay')).toBeNull();
  });
});
