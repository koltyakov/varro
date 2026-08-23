import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WarningIcon } from './WarningIcon';
import { warningTriangleSolidIcon } from '../lib/ui-icons';
import { toCssUrl } from './UiIcon';

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

describe('WarningIcon', () => {
  it('renders the centrally mapped icon with the requested size', () => {
    cleanup = render(() => <WarningIcon class="test-icon" width={14} height={14} />, container!);

    const icon = container?.querySelector<HTMLElement>('.ui-icon.test-icon');
    expect(icon).toBeInstanceOf(HTMLSpanElement);
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(warningTriangleSolidIcon));
    expect(icon?.style.getPropertyValue('--ui-icon-width')).toBe('14px');
    expect(icon?.style.getPropertyValue('--ui-icon-height')).toBe('14px');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(container?.querySelector('.codicon')).toBeNull();
  });
});
