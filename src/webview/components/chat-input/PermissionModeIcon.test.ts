import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PermissionModeIcon } from './PermissionModeIcon';

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

describe('PermissionModeIcon', () => {
  it('renders a distinct auto permission icon', () => {
    cleanup = render(
      () => [
        PermissionModeIcon({ mode: 'default' }),
        PermissionModeIcon({ mode: 'auto' }),
        PermissionModeIcon({ mode: 'full' }),
      ],
      container!
    );

    const defaultPath = container?.querySelector('.permission-mode-icon.default path');
    const autoPath = container?.querySelector('.permission-mode-icon.auto path');
    const fullPath = container?.querySelector('.permission-mode-icon.full path');

    expect(container?.querySelectorAll('.permission-mode-icon.auto path')).toHaveLength(1);
    expect(autoPath?.getAttribute('d')).toContain('M56 60');
    expect(autoPath?.getAttribute('d')).toContain('180.68555 32');
    expect(fullPath?.getAttribute('d')).toContain('M31.25 7.4');
    expect(fullPath?.getAttribute('d')).toContain('16.4 9.8');
    expect(fullPath?.getAttribute('d')).toContain('18 26.4');
    expect(fullPath?.getAttribute('fill-rule')).toBe('evenodd');
    expect(defaultPath?.getAttribute('d')).toContain('M13.5 2.4');
    expect(defaultPath?.getAttribute('d')).not.toBe(autoPath?.getAttribute('d'));
    expect(fullPath?.getAttribute('d')).not.toBe(autoPath?.getAttribute('d'));
  });
});
