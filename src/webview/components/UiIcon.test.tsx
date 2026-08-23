import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { createUiIconElement, toCssUrl, UiIcon } from './UiIcon';

describe('UiIcon', () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.textContent = '';
  });

  it('uses a shared SVG URL as a current-color mask at the requested size', () => {
    const container = document.createElement('div');
    document.body.append(container);
    dispose = render(
      () => <UiIcon source="/assets/copy.svg" class="test-icon" width={12} height="1em" />,
      container
    );

    const icon = container.querySelector<HTMLElement>('.ui-icon.test-icon');
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl('/assets/copy.svg'));
    expect(icon?.style.getPropertyValue('--ui-icon-width')).toBe('12px');
    expect(icon?.style.getPropertyValue('--ui-icon-height')).toBe('1em');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('preserves accessible labels and forwarded attributes', () => {
    const container = document.createElement('div');
    document.body.append(container);
    dispose = render(
      () => (
        <UiIcon source="/assets/warning.svg" aria-label="Warning" role="img" data-kind="warning" />
      ),
      container
    );

    const icon = container.querySelector<HTMLElement>('.ui-icon');
    expect(icon?.getAttribute('aria-label')).toBe('Warning');
    expect(icon?.hasAttribute('aria-hidden')).toBe(false);
    expect(icon?.dataset.kind).toBe('warning');
  });

  it('creates equivalent imperative icon elements', () => {
    const first = createUiIconElement('/assets/check.svg', {
      className: 'copy-state',
      width: 14,
      height: 14,
    });
    const second = createUiIconElement('/assets/check.svg');

    expect(first.classList.contains('copy-state')).toBe(true);
    expect(first.style.getPropertyValue('--ui-icon-width')).toBe('14px');
    expect(first.style.getPropertyValue('--ui-icon-mask')).toBe(
      second.style.getPropertyValue('--ui-icon-mask')
    );
    expect(first.getAttribute('aria-hidden')).toBe('true');
  });
});
