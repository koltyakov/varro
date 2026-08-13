import { afterEach, beforeEach, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { AttachmentLabel } from './AttachmentLabel';

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
});

it('separates a file extension so it remains visible when the stem is truncated', () => {
  cleanup = render(
    () => <AttachmentLabel label="RFC-RFC-067 GitHub Usage Standards.md" preserveExtension />,
    container
  );

  expect(container.querySelector('.chip-label-stem')?.textContent).toBe(
    'RFC-RFC-067 GitHub Usage Standards'
  );
  expect(container.querySelector('.chip-label-extension')?.textContent).toBe('.md');
});

it('keeps labels without a file extension as one text node', () => {
  cleanup = render(() => <AttachmentLabel label="GitHub Usage Standards" />, container);

  expect(container.querySelector('.chip-label')?.textContent).toBe('GitHub Usage Standards');
  expect(container.querySelector('.chip-label-extension')).toBeNull();
});
