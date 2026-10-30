import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markdownCitationSelection } from './markdown-citation-selection';

const disposers: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  window.getSelection()?.removeAllRanges();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(label = 'README.md') {
  const root = document.createElement('div');
  root.innerHTML =
    '<code><span class="link-leading-content"><img class="file-path-icon" alt=""><span class="link-leading-label"></span></span></code>';
  document.body.append(root);
  const wrapper = root.querySelector<HTMLElement>('.link-leading-content');
  const labelElement = root.querySelector('.link-leading-label');
  if (!wrapper || !labelElement) throw new Error('Expected citation fixture');
  const text = document.createTextNode(label);
  labelElement.append(text);
  const readWrapperBox = vi
    .spyOn(wrapper, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(10, 20, 100, 22));
  // JSDOM has no layout. Browser tests verify the full line-height selection pixels.
  const readLabelBox = vi
    .spyOn(labelElement, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(25, 23, 85, 16));
  const dispose = markdownCitationSelection.bind(root);
  disposers.push(dispose);
  return { root, wrapper, text, readWrapperBox, readLabelBox, dispose };
}

function select(text: Text, start: number, end: number): void {
  window.getSelection()?.setBaseAndExtent(text, start, text, end);
  document.dispatchEvent(new Event('selectionchange'));
  vi.advanceTimersToNextFrame();
}

describe('markdown citation selection', () => {
  it('coalesces selection events and reads geometry only for selected references', () => {
    const addListener = vi.spyOn(document, 'addEventListener');
    const first = fixture();
    const second = fixture('missing.ts');
    expect(addListener.mock.calls.filter(([type]) => type === 'selectionchange')).toHaveLength(1);
    window.getSelection()?.setBaseAndExtent(first.text, 0, first.text, first.text.length);
    for (let index = 0; index < 10; index++) document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersToNextFrame();
    expect(first.readLabelBox).toHaveBeenCalledTimes(1);
    expect(first.readWrapperBox).toHaveBeenCalledTimes(1);
    expect(second.readWrapperBox).not.toHaveBeenCalled();
    expect(second.readLabelBox).not.toHaveBeenCalled();
    expect(first.wrapper.classList).toContain('file-icon-selected');
    expect(first.wrapper.style.getPropertyValue('--file-selection-width')).toBe('15px');
    expect(window.getSelection()?.toString()).toBe('README.md');

    const writeStyle = vi.spyOn(first.wrapper.style, 'setProperty');
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersToNextFrame();
    expect(writeStyle).not.toHaveBeenCalled();
  });

  it('includes the first character in either direction but excludes suffixes and carets', () => {
    const { text, wrapper, readLabelBox } = fixture();
    select(text, 0, 1);
    expect(wrapper.classList).toContain('file-icon-selected');
    select(text, 1, 0);
    expect(wrapper.classList).toContain('file-icon-selected');
    select(text, 1, text.length);
    expect(wrapper.classList).not.toContain('file-icon-selected');
    expect(wrapper.style.cssText).toBe('');
    select(text, 0, 0);
    expect(wrapper.classList).not.toContain('file-icon-selected');
    expect(readLabelBox).toHaveBeenCalledTimes(2);
  });

  it('batches geometry reads before writes for a selection spanning roots', () => {
    const first = fixture();
    const second = fixture('missing.ts');
    const order: string[] = [];
    first.readWrapperBox.mockImplementation(() => {
      order.push('read');
      return new DOMRect(10, 20, 100, 22);
    });
    second.readWrapperBox.mockImplementation(() => {
      order.push('read');
      return new DOMRect(10, 40, 100, 22);
    });
    vi.spyOn(first.wrapper.style, 'setProperty').mockImplementation(() => {
      order.push('write');
    });
    vi.spyOn(second.wrapper.style, 'setProperty').mockImplementation(() => {
      order.push('write');
    });
    window.getSelection()?.setBaseAndExtent(first.text, 0, second.text, second.text.length);
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersToNextFrame();
    expect(order.slice(0, 2)).toEqual(['read', 'read']);
    expect(order.slice(2)).toEqual(['write', 'write']);
  });

  it('refreshes selected geometry on resize without measuring collapsed selections', () => {
    const { text, wrapper, readWrapperBox, readLabelBox } = fixture();
    select(text, 0, text.length);
    readWrapperBox.mockReturnValue(new DOMRect(10, 21, 100, 24));
    readLabelBox.mockReturnValue(new DOMRect(27, 24, 83, 16));
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersToNextFrame();
    expect(wrapper.style.getPropertyValue('--file-selection-width')).toBe('17px');
    expect(readWrapperBox).toHaveBeenCalledTimes(2);
    select(text, 0, 0);
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersToNextFrame();
    expect(readWrapperBox).toHaveBeenCalledTimes(2);
  });

  it('clears replaced nodes and cancels pending work when the final renderer unmounts', () => {
    const { root, wrapper, text, dispose } = fixture();
    select(text, 0, text.length);
    root.replaceChildren();
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersToNextFrame();
    expect(wrapper.classList).not.toContain('file-icon-selected');
    expect(wrapper.style.cssText).toBe('');

    const removeListener = vi.spyOn(document, 'removeEventListener');
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame');
    document.dispatchEvent(new Event('selectionchange'));
    dispose();
    expect(cancelFrame).toHaveBeenCalledTimes(1);
    expect(removeListener.mock.calls.filter(([type]) => type === 'selectionchange')).toHaveLength(
      1
    );
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    document.dispatchEvent(new Event('selectionchange'));
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('cleans an unmounted renderer without stopping the remaining renderer', () => {
    const first = fixture();
    const second = fixture('missing.ts');
    select(first.text, 0, first.text.length);
    first.dispose();
    expect(first.wrapper.classList).not.toContain('file-icon-selected');
    expect(first.wrapper.style.cssText).toBe('');
    select(second.text, 0, second.text.length);
    expect(second.wrapper.classList).toContain('file-icon-selected');
  });
});
