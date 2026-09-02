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

    const icons = ['default', 'auto', 'full'].map((mode) =>
      container?.querySelector(`.permission-mode-icon.${mode}`)
    );
    const pathData = icons.map((icon) => icon?.querySelector('path')?.getAttribute('d'));

    expect(container?.querySelectorAll('.permission-mode-icon')).toHaveLength(3);
    expect(icons.every((icon) => icon?.querySelector('svg') instanceof SVGSVGElement)).toBe(true);
    expect(pathData.every(Boolean)).toBe(true);
    expect(new Set(pathData).size).toBe(3);
  });
});
