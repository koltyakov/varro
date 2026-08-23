import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { shareIosIcon } from '../../lib/ui-icons';
import { toCssUrl } from '../UiIcon';
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

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const overlay = document.body.querySelector('.chat-drop-overlay') as HTMLDivElement | null;

    expect(container?.querySelector('.chat-drop-overlay')).toBeNull();
    expect(overlay).toBeInstanceOf(HTMLDivElement);
    expect(overlay?.getAttribute('aria-hidden')).toBe('true');
    expect(overlay?.querySelector('.chat-drop-overlay-card')).toBeInstanceOf(HTMLDivElement);
    expect(
      overlay
        ?.querySelector<HTMLElement>('.chat-drop-overlay-icon .ui-icon')
        ?.style.getPropertyValue('--ui-icon-mask')
    ).toBe(toCssUrl(shareIosIcon));
    expect(overlay?.textContent).toContain('Drop to add to context');
  });
});
