import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WarningIcon } from './WarningIcon';

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
  it('renders without relying on an external icon font', () => {
    cleanup = render(() => <WarningIcon class="test-icon" width={14} height={14} />, container!);

    const icon = container?.querySelector('svg.test-icon');
    expect(icon).toBeInstanceOf(SVGSVGElement);
    expect(icon?.querySelector('path')).not.toBeNull();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(container?.querySelector('.codicon')).toBeNull();
  });
});
