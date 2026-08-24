import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { emptyPageIcon, folderIcon } from '../../lib/ui-icons';
import { toCssUrl } from '../UiIcon';
import {
  RichComposerArea,
  extractText,
  findNodeAtOffset,
  type RichComposerChip,
} from './RichComposerArea';

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
  document.querySelector('.chat-attachment-image-preview')?.remove();
});

async function flushAsyncWork(count = 3) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function setCollapsedSelection(target: Node, offset: number) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(target, offset);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function expectChipUiIcon(element: Element | null | undefined, source: string) {
  expect(element).toBeInstanceOf(HTMLSpanElement);
  expect(element?.classList).toContain('ui-icon');
  expect(element?.classList).toContain('inline-chip-icon');
  if (!(element instanceof HTMLSpanElement)) throw new Error('Expected chip UI icon element');
  expect(element.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(source));
  expect(element.style.getPropertyValue('--ui-icon-width')).toBe('11px');
  expect(element.style.getPropertyValue('--ui-icon-height')).toBe('11px');
}

function renderComposer(props: {
  value: string;
  cursorOffset: number;
  chips: RichComposerChip[];
  onInput?: (text: string, cursorOffset: number) => void;
  onPaste?: (e: ClipboardEvent) => void;
  onPasteInsertion?: Parameters<typeof RichComposerArea>[0]['onPasteInsertion'];
  onChipClick?: (chipId: string) => void;
  onRemoveChip?: (chipId: string) => void;
}) {
  cleanup = render(
    () =>
      RichComposerArea({
        editorRef: () => {},
        placeholder: 'Compose',
        value: props.value,
        cursorOffset: props.cursorOffset,
        chips: props.chips,
        isFocused: true,
        showCompletionMenu: false,
        completionItems: [],
        completionSelectedIndex: 0,
        onInput: props.onInput || (() => {}),
        onKeyDown: () => {},
        onPaste: props.onPaste || (() => {}),
        onPasteInsertion: props.onPasteInsertion,
        onFocus: () => {},
        onBlur: () => {},
        onClick: () => {},
        onKeyUp: () => {},
        onSelect: () => {},
        onSelectCompletion: () => {},
        onChipClick: props.onChipClick,
        onRemoveChip: props.onRemoveChip,
      }),
    container!
  );
}

describe('RichComposerArea', () => {
  it('uses a stable accessible label alongside the dynamic placeholder', () => {
    renderComposer({ value: '', cursorOffset: 0, chips: [] });

    const editor = container?.querySelector('.rich-composer');
    expect(editor?.getAttribute('aria-label')).toBe('Message composer');
    expect(editor?.getAttribute('aria-placeholder')).toBe('Compose');
  });

  it('renders session references as non-clickable inline links', () => {
    const onChipClick = vi.fn();
    renderComposer({
      value: 'session:ses_auth',
      cursorOffset: 'session:ses_auth'.length,
      chips: [
        {
          id: 'session:ses_auth',
          type: 'mention-session',
          label: 'Authentication work',
          icon: 'session',
          textMarker: 'session:ses_auth',
        },
      ],
      onChipClick,
    });

    const reference = container?.querySelector<HTMLElement>('.composer-session-reference');
    expect(reference?.textContent).toBe('Authentication work');
    expect(reference?.querySelector('.inline-chip-icon')).not.toBeNull();
    expect(reference?.dataset.chipId).toBeUndefined();
    expect(reference?.getAttribute('contenteditable')).toBeNull();

    reference?.click();
    expect(onChipClick).not.toHaveBeenCalled();
  });

  it('replaces a session reference when typing anywhere in its title', () => {
    const onInput = vi.fn();
    const marker = 'session:ses_auth';
    renderComposer({
      value: `before ${marker} after`,
      cursorOffset: `before ${marker}`.length,
      chips: [
        {
          id: marker,
          type: 'mention-session',
          label: 'Authentication work',
          icon: 'session',
          textMarker: marker,
        },
      ],
      onInput,
    });

    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    const label = container?.querySelector<HTMLElement>(
      '.composer-session-reference .inline-chip-label'
    );
    if (!editor || !label?.firstChild) throw new Error('Expected session reference label');
    setCollapsedSelection(label.firstChild, 7);

    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: 'X',
    });
    editor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onInput).toHaveBeenCalledWith('before X after', 'before X'.length);
  });

  it('deletes a selected session title through the underlying marker', () => {
    const onInput = vi.fn();
    const marker = 'session:ses_auth';
    renderComposer({
      value: `before ${marker} after`,
      cursorOffset: `before ${marker}`.length,
      chips: [
        {
          id: marker,
          type: 'mention-session',
          label: 'Authentication work',
          icon: 'session',
          textMarker: marker,
        },
      ],
      onInput,
    });

    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    const label = container?.querySelector<HTMLElement>(
      '.composer-session-reference .inline-chip-label'
    );
    if (!editor || !label) throw new Error('Expected session reference label');
    const range = document.createRange();
    range.selectNodeContents(label);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    editor.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'deleteContentBackward',
      })
    );

    expect(onInput).toHaveBeenCalledWith('before  after', 'before '.length);
  });

  it.each(['Backspace', 'Delete'])(
    'removes a session reference with %s inside its title',
    (key) => {
      const onInput = vi.fn();
      const marker = 'session:ses_auth';
      renderComposer({
        value: `before ${marker} after`,
        cursorOffset: `before ${marker}`.length,
        chips: [
          {
            id: marker,
            type: 'mention-session',
            label: 'Authentication work',
            icon: 'session',
            textMarker: marker,
          },
        ],
        onInput,
      });

      const editor = container?.querySelector<HTMLElement>('.rich-composer');
      const label = container?.querySelector<HTMLElement>(
        '.composer-session-reference .inline-chip-label'
      );
      if (!editor || !label?.firstChild) throw new Error('Expected session reference label');
      setCollapsedSelection(label.firstChild, 7);
      editor.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

      expect(onInput).toHaveBeenCalledWith('before  after', 'before '.length);
    }
  );

  it('renders external URLs as editable inline text', () => {
    const onInput = vi.fn();
    renderComposer({
      value: 'See https://iconoir.com',
      cursorOffset: 'See https://iconoir.com'.length,
      chips: [
        {
          id: 'external-link:https://iconoir.com',
          type: 'external-link',
          label: 'https://iconoir.com',
          icon: 'external-link',
          textMarker: 'https://iconoir.com',
        },
      ],
      onInput,
    });

    const reference = container?.querySelector<HTMLElement>('.composer-external-link');
    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');
    expect(reference?.textContent).toBe('https://iconoir.com');
    expect(container?.querySelector('.composer-external-link-icon')).toBeInstanceOf(
      HTMLImageElement
    );
    expect(reference?.dataset.chipMarker).toBeUndefined();
    expect(reference?.getAttribute('contenteditable')).toBeNull();
    expect(extractText(editor)).toBe('See https://iconoir.com');
    expect(reference?.querySelector('.link-leading-content')?.textContent).toBe('h');

    const linkText = reference?.lastChild;
    if (!linkText || linkText.nodeType !== Node.TEXT_NODE)
      throw new Error('Expected external link text');
    linkText.textContent = 'ttps://iconoir.dev';
    setCollapsedSelection(linkText, 'ttps://iconoir.dev'.length);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));

    expect(onInput).toHaveBeenCalledWith(
      'See https://iconoir.dev',
      'See https://iconoir.dev'.length
    );
  });

  it('moves text typed after a URL into plain composer text', () => {
    const onInput = vi.fn();
    renderComposer({
      value: 'https://iconoir.com',
      cursorOffset: 'https://iconoir.com'.length,
      chips: [
        {
          id: 'external-link:https://iconoir.com',
          type: 'external-link',
          label: 'https://iconoir.com',
          icon: 'external-link',
          textMarker: 'https://iconoir.com',
        },
      ],
      onInput,
    });

    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    const reference = container?.querySelector<HTMLElement>('.composer-external-link');
    const linkText = reference?.lastChild;
    if (!editor || !linkText || linkText.nodeType !== Node.TEXT_NODE) {
      throw new Error('Expected editable external link');
    }
    editor.focus();
    linkText.textContent = "ttps://iconoir.com what's this";
    setCollapsedSelection(linkText, "ttps://iconoir.com what's this".length);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));

    expect(reference.textContent).toBe('https://iconoir.com');
    expect(reference.nextSibling?.textContent).toBe(" what's this");
    expect(onInput).toHaveBeenCalledWith(
      "https://iconoir.com what's this",
      "https://iconoir.com what's this".length
    );
    expect(document.activeElement).toBe(editor);
  });

  it('inserts a typed space after a URL as plain composer text', () => {
    const onInput = vi.fn();
    renderComposer({
      value: 'https://iconoir.com',
      cursorOffset: 'https://iconoir.com'.length,
      chips: [
        {
          id: 'external-link:https://iconoir.com',
          type: 'external-link',
          label: 'https://iconoir.com',
          icon: 'external-link',
          textMarker: 'https://iconoir.com',
        },
      ],
      onInput,
    });

    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    const reference = container?.querySelector<HTMLElement>('.composer-external-link');
    const linkText = reference?.lastChild;
    if (!editor || !linkText || linkText.nodeType !== Node.TEXT_NODE) {
      throw new Error('Expected editable external link');
    }
    editor.focus();
    setCollapsedSelection(linkText, 'ttps://iconoir.com'.length);
    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: ' ',
    });
    editor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onInput).toHaveBeenCalledWith('https://iconoir.com ', 'https://iconoir.com '.length);
    expect(document.activeElement).toBe(editor);
  });

  it.each([
    { key: 'Backspace', cursor: 'before session:ses_auth'.length },
    { key: 'Delete', cursor: 'before '.length },
  ])('deletes a whole session reference with $key', ({ key, cursor }) => {
    const onInput = vi.fn();
    const onRemoveChip = vi.fn();
    const value = 'before session:ses_auth after';
    renderComposer({
      value,
      cursorOffset: cursor,
      chips: [
        {
          id: 'session:ses_auth',
          type: 'mention-session',
          label: 'Authentication work',
          icon: 'session',
          textMarker: 'session:ses_auth',
        },
      ],
      onInput,
      onRemoveChip,
    });

    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');
    const target = findNodeAtOffset(editor, cursor);
    if (!target) throw new Error('Expected cursor target');
    setCollapsedSelection(target.node, target.offset);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

    expect(onInput).toHaveBeenCalledWith('before  after', 'before '.length);
    expect(onRemoveChip).toHaveBeenCalledWith('session:ses_auth');
  });

  it('maps chip-end offsets onto the invisible caret spacer after the chip', () => {
    const editor = document.createElement('div');
    const chip = document.createElement('span');
    chip.dataset.chipMarker = '@README.md';
    const spacer = document.createTextNode('\u200B');

    editor.appendChild(chip);
    editor.appendChild(spacer);

    expect(findNodeAtOffset(editor, '@README.md'.length)).toEqual({ node: spacer, offset: 1 });
  });

  it('maps offsets after a chip spacer onto following typed text', () => {
    const editor = document.createElement('div');
    const chip = document.createElement('span');
    chip.dataset.chipMarker = '[Image]';
    const spacerAndText = document.createTextNode('\u200B hello');

    editor.appendChild(chip);
    editor.appendChild(spacerAndText);

    expect(findNodeAtOffset(editor, '[Image]'.length + 1)).toEqual({
      node: spacerAndText,
      offset: 2,
    });
    expect(findNodeAtOffset(editor, '[Image]'.length + 6)).toEqual({
      node: spacerAndText,
      offset: 7,
    });
  });

  it('maps offsets beyond a nested editable span onto following text', () => {
    const editor = document.createElement('div');
    const link = document.createElement('span');
    const linkText = document.createTextNode('link');
    const trailingText = document.createTextNode(' next');
    link.appendChild(linkText);
    editor.append(link, trailingText);

    expect(findNodeAtOffset(editor, 'link '.length)).toEqual({
      node: trailingText,
      offset: 1,
    });
  });

  it('inserts plain text paste through onInput', () => {
    const onInput = vi.fn();
    const onPasteInsertion = vi.fn();

    renderComposer({ value: '', cursorOffset: 0, chips: [], onInput, onPasteInsertion });

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.focus();
    if (editor) setCollapsedSelection(editor, 0);

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? 'pasted text' : '') },
    });

    editor?.dispatchEvent(event);

    expect(onInput).toHaveBeenCalledWith('pasted text', 11);
    expect(onPasteInsertion).toHaveBeenCalledWith(event, {
      start: 0,
      end: 11,
      text: 'pasted text',
      value: 'pasted text',
    });
  });

  it('inserts exactly one controlled newline on Shift+Enter', () => {
    const onInput = vi.fn();
    const value = 'something';
    renderComposer({ value, cursorOffset: value.length, chips: [], onInput });

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor?.firstChild) throw new Error('Expected populated composer editor');
    setCollapsedSelection(editor.firstChild, value.length);
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onInput).toHaveBeenCalledWith('something\n', 'something\n'.length);
  });

  it('scrolls to reveal the caret after Shift+Enter', async () => {
    const originalRangeRect = Range.prototype.getBoundingClientRect;
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(0, 220, 0, 20),
    });

    try {
      cleanup = render(() => {
        const [value, setValue] = createSignal('last visible line');
        const [cursorOffset, setCursorOffset] = createSignal(value().length);

        return RichComposerArea({
          editorRef: () => {},
          placeholder: 'Compose',
          get value() {
            return value();
          },
          get cursorOffset() {
            return cursorOffset();
          },
          chips: [],
          isFocused: true,
          showCompletionMenu: false,
          completionItems: [],
          completionSelectedIndex: 0,
          onInput: (text, nextOffset) => {
            setValue(text);
            setCursorOffset(nextOffset);
          },
          onKeyDown: () => {},
          onPaste: () => {},
          onFocus: () => {},
          onBlur: () => {},
          onClick: () => {},
          onKeyUp: () => {},
          onSelect: () => {},
          onSelectCompletion: () => {},
        });
      }, container!);

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor?.firstChild) throw new Error('Expected populated composer editor');
      editor.focus();
      editor.scrollTop = 40;
      editor.getBoundingClientRect = () => new DOMRect(0, 20, 0, 180);
      setCollapsedSelection(editor.firstChild, 'last visible line'.length);

      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
      await flushAsyncWork();

      expect(editor.scrollTop).toBe(80);
    } finally {
      if (originalRangeRect) {
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
          configurable: true,
          value: originalRangeRect,
        });
      } else {
        Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
      }
    }
  });

  it('keeps revealing trailing blank lines when the collapsed range has no bounds', async () => {
    const originalRangeRect = Range.prototype.getBoundingClientRect;
    const originalElementRect = HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(),
    });
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value: function (this: HTMLElement) {
        if (this.dataset.caretMeasure) {
          const editor = this.parentElement!;
          const top = 180 + editor.querySelectorAll('br').length * 20 - editor.scrollTop;
          return new DOMRect(0, top, 0, 20);
        }
        return originalElementRect.call(this);
      },
    });

    try {
      cleanup = render(() => {
        const [value, setValue] = createSignal('last visible line');
        const [cursorOffset, setCursorOffset] = createSignal(value().length);

        return RichComposerArea({
          editorRef: () => {},
          placeholder: 'Compose',
          get value() {
            return value();
          },
          get cursorOffset() {
            return cursorOffset();
          },
          chips: [],
          isFocused: true,
          showCompletionMenu: false,
          completionItems: [],
          completionSelectedIndex: 0,
          onInput: (text, nextOffset) => {
            setValue(text);
            setCursorOffset(nextOffset);
          },
          onKeyDown: () => {},
          onPaste: () => {},
          onFocus: () => {},
          onBlur: () => {},
          onClick: () => {},
          onKeyUp: () => {},
          onSelect: () => {},
          onSelectCompletion: () => {},
        });
      }, container!);

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor?.firstChild) throw new Error('Expected populated composer editor');
      editor.focus();
      editor.getBoundingClientRect = () => new DOMRect(0, 20, 0, 180);
      setCollapsedSelection(editor.firstChild, 'last visible line'.length);

      for (let index = 0; index < 4; index++) {
        editor.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          })
        );
        await flushAsyncWork();
      }

      expect(extractText(editor)).toBe('last visible line\n\n\n\n');
      expect(editor.scrollTop).toBe(80);
      expect(editor.querySelector('[data-caret-measure]')).toBeNull();

      for (let index = 0; index < 3; index++) {
        editor.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Backspace',
            bubbles: true,
            cancelable: true,
          })
        );
        await flushAsyncWork();
      }

      const placeholder = editor.querySelector<HTMLElement>('[data-caret-placeholder]');
      expect(extractText(editor)).toBe('last visible line\n');
      expect(window.getSelection()?.focusNode).toBe(placeholder?.firstChild);
      expect(window.getSelection()?.focusOffset).toBe(1);
    } finally {
      if (originalRangeRect) {
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
          configurable: true,
          value: originalRangeRect,
        });
      } else {
        Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
      }
      Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        writable: true,
        value: originalElementRect,
      });
    }
  });

  it('keeps the caret on the inserted line before an existing blank line', async () => {
    const firstBlock =
      'From: GPT-5.6 Sol Default\nTo: GPT-5.6 Sol High\nNormal: GPT-5.6 Sol Default -> High';
    const secondBlock =
      'From: GPT-5.6 Sol Default\nTo: GPT-5.6 Luna Default\nNormal: GPT-5.6 Sol Default -> GPT-5.6 Luna Default';

    cleanup = render(() => {
      const [value, setValue] = createSignal(`${firstBlock}\n\n${secondBlock}`);
      const [cursorOffset, setCursorOffset] = createSignal(firstBlock.length);

      return RichComposerArea({
        editorRef: () => {},
        placeholder: 'Compose',
        get value() {
          return value();
        },
        get cursorOffset() {
          return cursorOffset();
        },
        chips: [],
        isFocused: true,
        showCompletionMenu: false,
        completionItems: [],
        completionSelectedIndex: 0,
        onInput: (text, nextOffset) => {
          setValue(text);
          setCursorOffset(nextOffset);
        },
        onKeyDown: () => {},
        onPaste: () => {},
        onFocus: () => {},
        onBlur: () => {},
        onClick: () => {},
        onKeyUp: () => {},
        onSelect: () => {},
        onSelectCompletion: () => {},
      });
    }, container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');
    editor.focus();
    const target = findNodeAtOffset(editor, firstBlock.length);
    if (!target) throw new Error('Expected cursor target');
    setCollapsedSelection(target.node, target.offset);

    editor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
    await flushAsyncWork();

    const selection = window.getSelection();
    if (!selection?.rangeCount) throw new Error('Expected composer selection');
    const prefixRange = document.createRange();
    prefixRange.selectNodeContents(editor);
    prefixRange.setEnd(selection.focusNode!, selection.focusOffset);
    const prefix = document.createElement('div');
    prefix.appendChild(prefixRange.cloneContents());

    expect(extractText(editor)).toBe(`${firstBlock}\n\n\n${secondBlock}`);
    expect(extractText(prefix)).toBe(`${firstBlock}\n`);
  });

  it('renders a visible caret line when Shift+Enter follows an image chip', async () => {
    const marker = '[Image]';
    const chip: RichComposerChip = {
      id: 'img:1',
      type: 'image',
      label: 'Image',
      icon: 'image',
      textMarker: marker,
    };

    cleanup = render(() => {
      const [value, setValue] = createSignal(marker);
      const [cursorOffset, setCursorOffset] = createSignal(marker.length);

      return RichComposerArea({
        editorRef: () => {},
        placeholder: 'Compose',
        get value() {
          return value();
        },
        get cursorOffset() {
          return cursorOffset();
        },
        chips: [chip],
        isFocused: true,
        showCompletionMenu: false,
        completionItems: [],
        completionSelectedIndex: 0,
        onInput: (text, nextOffset) => {
          setValue(text);
          setCursorOffset(nextOffset);
        },
        onKeyDown: () => {},
        onPaste: () => {},
        onFocus: () => {},
        onBlur: () => {},
        onClick: () => {},
        onKeyUp: () => {},
        onSelect: () => {},
        onSelectCompletion: () => {},
      });
    }, container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');
    await flushAsyncWork();
    const target = findNodeAtOffset(editor, marker.length);
    if (!target) throw new Error('Expected cursor target');
    setCollapsedSelection(target.node, target.offset);

    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(event);
    await flushAsyncWork();

    expect(event.defaultPrevented).toBe(true);
    expect(extractText(editor)).toBe(`${marker}\n`);
    const placeholder = editor.querySelector('[data-caret-placeholder]');
    expect(editor.querySelectorAll('br')).toHaveLength(1);
    expect(placeholder).toBeInstanceOf(HTMLSpanElement);
    expect(window.getSelection()?.focusNode).toBe(placeholder?.firstChild);
    expect(window.getSelection()?.focusOffset).toBe(1);
  });

  it('continues a hyphen bullet on Shift+Enter', () => {
    const onInput = vi.fn();
    const value = '- Bullet item 1';
    renderComposer({ value, cursorOffset: value.length, chips: [], onInput });

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor?.firstChild) throw new Error('Expected populated composer editor');
    setCollapsedSelection(editor.firstChild, value.length);
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onInput).toHaveBeenCalledWith('- Bullet item 1\n- ', '- Bullet item 1\n- '.length);
  });

  it('removes an empty hyphen bullet on Shift+Enter', () => {
    const onInput = vi.fn();
    const value = '- Bullet item 1\n- Bullet item 2\n- ';
    renderComposer({ value, cursorOffset: value.length, chips: [], onInput });

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');
    const target = findNodeAtOffset(editor, value.length);
    if (!target) throw new Error('Expected cursor target');
    setCollapsedSelection(target.node, target.offset);
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(event);

    const expected = '- Bullet item 1\n- Bullet item 2\n';
    expect(event.defaultPrevented).toBe(true);
    expect(onInput).toHaveBeenCalledWith(expected, expected.length);
  });

  it('renders a trailing newline with a stable blank-line caret position', () => {
    const value = '- Bullet item 1\n- Bullet item 2\n';
    renderComposer({ value, cursorOffset: value.length, chips: [] });

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');
    const placeholder = editor.querySelector<HTMLElement>('[data-caret-placeholder]');
    const target = findNodeAtOffset(editor, value.length);

    expect(extractText(editor)).toBe(value);
    expect(placeholder).toBeInstanceOf(HTMLSpanElement);
    expect(target).toEqual({
      node: placeholder?.firstChild,
      offset: 1,
    });
  });

  it('renders an atomic chip at the start of a line with a caret stop before it', () => {
    const marker = '[Image 1]';
    const value = `Tests\n${marker}`;
    renderComposer({
      value,
      cursorOffset: 'Tests\n'.length,
      chips: [
        {
          id: 'img:1',
          type: 'image',
          label: 'Image 1',
          icon: 'image',
          textMarker: marker,
        },
      ],
    });

    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');
    const lineBreak = editor.querySelector('br');
    const leadingSpacer = lineBreak?.nextSibling;

    expect(editor.querySelectorAll('br')).toHaveLength(1);
    expect(editor.querySelector('[data-caret-placeholder]')).toBeNull();
    expect(leadingSpacer?.nodeType).toBe(Node.TEXT_NODE);
    expect(leadingSpacer?.textContent).toBe('\u200B');
    expect(leadingSpacer?.nextSibling).toBe(editor.querySelector('.inline-chip'));
    expect(extractText(editor)).toBe(value);
    expect(findNodeAtOffset(editor, 'Tests\n'.length)).toEqual({
      node: leadingSpacer,
      offset: 1,
    });
  });

  it('removes the newline before a line-start atomic chip with Backspace', () => {
    const marker = '[Image 1]';
    const value = `Tests\n${marker}`;
    const onInput = vi.fn();
    renderComposer({
      value,
      cursorOffset: 'Tests\n'.length,
      chips: [
        {
          id: 'img:1',
          type: 'image',
          label: 'Image 1',
          icon: 'image',
          textMarker: marker,
        },
      ],
      onInput,
    });

    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');
    const target = findNodeAtOffset(editor, 'Tests\n'.length);
    if (!target) throw new Error('Expected cursor target');
    setCollapsedSelection(target.node, target.offset);
    const event = new KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onInput).toHaveBeenCalledWith(`Tests${marker}`, 'Tests'.length);
  });

  it('removes a whole atomic chip with Backspace from its trailing caret stop', () => {
    const marker = '[Image 4]';
    const value = `sdsds ${marker}`;
    const onInput = vi.fn();
    const onRemoveChip = vi.fn();
    renderComposer({
      value,
      cursorOffset: value.length,
      chips: [
        {
          id: 'img:4',
          type: 'image',
          label: 'Image 4',
          icon: 'image',
          textMarker: marker,
        },
      ],
      onInput,
      onRemoveChip,
    });

    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');
    const target = findNodeAtOffset(editor, value.length);
    if (!target) throw new Error('Expected cursor target');
    setCollapsedSelection(target.node, target.offset);
    const event = new KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onInput).toHaveBeenCalledWith('sdsds ', 'sdsds '.length);
    expect(onRemoveChip).toHaveBeenCalledWith('img:4');
  });

  it.each([
    ['mention-file', ' '],
    ['mention-agent', ' '],
    ['image', ''],
  ] as const)('crosses a terminal %s chip with one horizontal arrow press', (type, separator) => {
    const marker = `[${type}]`;
    const prefix = 'before ';
    const value = `${prefix}${marker}${separator}`;
    renderComposer({
      value,
      cursorOffset: prefix.length + marker.length,
      chips: [
        {
          id: type,
          type,
          label: type,
          textMarker: marker,
        },
      ],
    });

    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');
    const target = findNodeAtOffset(editor, value.length);
    if (!target) throw new Error('Expected cursor target');
    setCollapsedSelection(target.node, target.offset);

    const getPrefix = () => {
      const selection = window.getSelection();
      if (!selection?.focusNode) throw new Error('Expected composer selection');
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.setEnd(selection.focusNode, selection.focusOffset);
      const fragment = document.createElement('div');
      fragment.appendChild(range.cloneContents());
      return extractText(fragment);
    };

    const left = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(left);
    expect(left.defaultPrevented).toBe(true);
    expect(getPrefix()).toBe(prefix);

    const right = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(right);
    expect(right.defaultPrevented).toBe(true);
    expect(getPrefix()).toBe(value);
    const selection = window.getSelection();
    const trailingSpacer = editor.querySelector('[data-chip-marker]')?.nextSibling;
    if (separator) {
      expect(selection?.focusNode).toBe(trailingSpacer);
      expect(selection?.focusOffset).toBe(2);
    } else {
      expect(selection?.focusNode).toBe(editor);
      expect(selection?.focusOffset).toBe(
        Array.from(editor.childNodes).indexOf(trailingSpacer!) + 1
      );
    }
  });

  it('replaces a selection spanning a session reference when pasting', () => {
    const onInput = vi.fn();
    const marker = 'session:ses_auth';
    renderComposer({
      value: `before ${marker} after`,
      cursorOffset: `before ${marker} after`.length,
      chips: [
        {
          id: marker,
          type: 'mention-session',
          label: 'Authentication work',
          icon: 'session',
          textMarker: marker,
        },
      ],
      onInput,
    });

    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    const label = container?.querySelector<HTMLElement>(
      '.composer-session-reference .inline-chip-label'
    );
    if (!editor || !label?.firstChild) throw new Error('Expected session reference');
    const range = document.createRange();
    range.selectNodeContents(label.firstChild);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? 'replacement' : '') },
    });
    editor.dispatchEvent(event);

    expect(onInput).toHaveBeenCalledWith('before replacement after', 'before replacement'.length);
  });

  it('reports the live selection when paste handling prevents the paste', () => {
    const onInput = vi.fn();
    const onPasteInsertion = vi.fn();

    renderComposer({
      value: '@README.md',
      cursorOffset: 10,
      chips: [],
      onInput,
      onPaste: (event) => event.preventDefault(),
      onPasteInsertion,
    });

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor?.firstChild) throw new Error('Expected populated composer editor');
    setCollapsedSelection(editor.firstChild, 0);
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? '@README.md' : '') },
    });

    editor?.dispatchEvent(event);

    expect(onInput).not.toHaveBeenCalled();
    expect(onPasteInsertion).toHaveBeenCalledWith(event, {
      start: 0,
      end: 0,
      text: '',
      value: '@README.md',
    });
  });

  it('accepts input immediately after syncing the controlled value', () => {
    const onInput = vi.fn();

    renderComposer({ value: 'restored draft', cursorOffset: 14, chips: [], onInput });

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');

    editor.textContent = 'updated draft';
    editor.focus();
    setCollapsedSelection(editor.firstChild || editor, 13);
    editor.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onInput).toHaveBeenCalledWith('updated draft', 13);
  });

  it('discards a native undo mutation after controlled history restoration', () => {
    const onInput = vi.fn();
    renderComposer({ value: '123', cursorOffset: 3, chips: [], onInput });

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');
    editor.textContent = '123123';
    editor.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'historyUndo', data: null })
    );

    expect(editor.textContent).toBe('123');
    expect(onInput).not.toHaveBeenCalled();
  });

  it('copies the underlying chip markers instead of visible labels', () => {
    const chip: RichComposerChip = {
      id: 'file:/workspace/README.md',
      type: 'mention-file',
      label: 'README.md',
      icon: 'file',
      textMarker: '@README.md',
    };

    renderComposer({ value: 'Review @README.md please', cursorOffset: 22, chips: [chip] });

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor!);
    selection?.removeAllRanges();
    selection?.addRange(range);

    const setData = vi.fn();
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { setData },
    });

    editor?.dispatchEvent(event);

    expect(setData).toHaveBeenCalledWith('text/plain', 'Review @README.md please');
  });

  it('removes attachment state when a chip disappears from the composer input', async () => {
    const chip: RichComposerChip = {
      id: 'file:/workspace/README.md',
      type: 'mention-file',
      label: 'README.md',
      icon: 'file',
      textMarker: '@README.md',
    };
    const onInput = vi.fn();
    const onRemoveChip = vi.fn();

    renderComposer({
      value: '@README.md',
      cursorOffset: 0,
      chips: [chip],
      onInput,
      onRemoveChip,
    });

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');

    await flushAsyncWork();
    editor.textContent = '';
    editor.focus();
    setCollapsedSelection(editor, 0);
    editor.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onInput).toHaveBeenCalledWith('', 0);
    expect(onRemoveChip).toHaveBeenCalledWith('file:/workspace/README.md');
  });

  it('marks the editor empty after content is cleared', async () => {
    renderComposer({ value: '', cursorOffset: 0, chips: [] });

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');

    await flushAsyncWork();
    expect(editor.dataset.empty).toBe('true');

    editor.textContent = 'hello';
    editor.focus();
    setCollapsedSelection(editor.firstChild || editor, 5);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    expect(editor.dataset.empty).toBe('false');

    editor.textContent = '';
    editor.focus();
    setCollapsedSelection(editor, 0);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    expect(extractText(editor)).toBe('');
    expect(editor.dataset.empty).toBe('true');
  });

  it('treats a lone browser-inserted br as empty content', async () => {
    renderComposer({ value: '', cursorOffset: 0, chips: [] });

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');

    await flushAsyncWork();
    editor.replaceChildren(document.createElement('br'));
    editor.focus();
    setCollapsedSelection(editor, 0);
    editor.dispatchEvent(new Event('input', { bubbles: true }));

    expect(extractText(editor)).toBe('');
    expect(editor.dataset.empty).toBe('true');
  });

  it('keeps typed text in order after an inline image chip', async () => {
    const chip: RichComposerChip = {
      id: 'img:1',
      type: 'image',
      label: 'Image',
      icon: 'image',
      textMarker: '[Image]',
    };

    cleanup = render(() => {
      const [value, setValue] = createSignal('[Image]');
      const [cursorOffset, setCursorOffset] = createSignal('[Image]'.length);

      return RichComposerArea({
        editorRef: () => {},
        placeholder: 'Compose',
        value: value(),
        cursorOffset: cursorOffset(),
        chips: [chip],
        isFocused: true,
        showCompletionMenu: false,
        completionItems: [],
        completionSelectedIndex: 0,
        onInput: (text, nextOffset) => {
          setValue(text);
          setCursorOffset(nextOffset);
        },
        onKeyDown: () => {},
        onPaste: () => {},
        onFocus: () => {},
        onBlur: () => {},
        onClick: () => {},
        onKeyUp: () => {},
        onSelect: () => {},
        onSelectCompletion: () => {},
      });
    }, container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');

    await flushAsyncWork();
    const trailingText = editor.childNodes[1];
    if (!trailingText || trailingText.nodeType !== Node.TEXT_NODE) {
      throw new Error('Expected spacer text node after chip');
    }

    trailingText.textContent = '\u200Ba';
    editor.focus();
    setCollapsedSelection(trailingText, 2);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAsyncWork();

    trailingText.textContent = '\u200Bab';
    editor.focus();
    setCollapsedSelection(trailingText, 3);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAsyncWork();

    expect(extractText(editor)).toBe('[Image]ab');
  });

  it('previews an inline pasted image above the input frame', async () => {
    const chip: RichComposerChip = {
      id: 'img:1',
      type: 'image',
      label: 'Image 1',
      icon: 'image',
      previewImage: { url: 'blob:image-1', alt: 'Image 1' },
      textMarker: '[Image 1]',
    };
    container!.className = 'chat-input-shell';
    const frame = document.createElement('div');
    frame.className = 'chat-input-container';
    container!.appendChild(frame);
    const originalContainer = container;
    container = frame;
    renderComposer({ value: '[Image 1]', cursorOffset: 0, chips: [chip] });
    container = originalContainer;
    await flushAsyncWork();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    originalContainer!.getBoundingClientRect = () =>
      ({ left: 10, right: 510, width: 500 }) as DOMRect;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    frame.getBoundingClientRect = () => ({ top: 380 }) as DOMRect;
    const inlineChip = frame.querySelector<HTMLElement>('.inline-chip')!;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    inlineChip.getBoundingClientRect = () => ({ left: 30, right: 100, width: 70 }) as DOMRect;
    inlineChip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    const preview = document.querySelector<HTMLElement>('.chat-attachment-image-preview');
    expect(preview?.querySelector('img')?.getAttribute('src')).toBe('blob:image-1');
    expect(preview?.style.bottom).toBe(`${window.innerHeight - 380 + 22}px`);
  });

  it('dismisses an image preview when the hovered chip is removed', async () => {
    const chip: RichComposerChip = {
      id: 'img:1',
      type: 'image',
      label: 'Image 1',
      icon: 'image',
      previewImage: { url: 'blob:image-1', alt: 'Image 1' },
      textMarker: '[Image 1]',
    };
    const [value, setValue] = createSignal(chip.textMarker);

    cleanup = render(
      () =>
        RichComposerArea({
          editorRef: () => {},
          placeholder: 'Compose',
          get value() {
            return value();
          },
          cursorOffset: 0,
          get chips() {
            return value().includes(chip.textMarker) ? [chip] : [];
          },
          isFocused: true,
          showCompletionMenu: false,
          completionItems: [],
          completionSelectedIndex: 0,
          onInput: () => {},
          onKeyDown: () => {},
          onPaste: () => {},
          onFocus: () => {},
          onBlur: () => {},
          onClick: () => {},
          onKeyUp: () => {},
          onSelect: () => {},
          onSelectCompletion: () => {},
        }),
      container!
    );
    await flushAsyncWork();

    const inlineChip = container?.querySelector<HTMLElement>('.inline-chip');
    inlineChip?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(document.querySelector('.chat-attachment-image-preview')).not.toBeNull();

    setValue('');
    await flushAsyncWork();

    expect(document.querySelector('.chat-attachment-image-preview')).toBeNull();
  });

  it('uses the chip title for hover text when provided', async () => {
    const chip: RichComposerChip = {
      id: 'file:/workspace/src/webview/components/chat-input/BusySendMenu.test.tsx',
      type: 'mention-file',
      label: 'BusySendMenu.test.tsx',
      path: 'src/webview/components/chat-input/BusySendMenu.test.tsx',
      title: 'src/webview/components/chat-input/BusySendMenu.test.tsx',
      icon: 'file',
      textMarker: '@src/webview/components/chat-input/BusySendMenu.test.tsx',
    };

    renderComposer({
      value: '@src/webview/components/chat-input/BusySendMenu.test.tsx',
      cursorOffset: 0,
      chips: [chip],
    });

    await flushAsyncWork();

    const inlineChip = container?.querySelector<HTMLElement>('.inline-chip');
    expect(inlineChip?.getAttribute('title')).toBe(
      'src/webview/components/chat-input/BusySendMenu.test.tsx'
    );
    expect(inlineChip?.querySelector('.file-type-icon')).toBeInstanceOf(HTMLImageElement);
  });

  it('renders directory chips with the folder icon', async () => {
    const chip: RichComposerChip = {
      id: 'file:/workspace/src',
      type: 'mention-file',
      label: 'src',
      icon: 'folder',
      textMarker: '@src/',
    };

    renderComposer({
      value: '@src/',
      cursorOffset: 0,
      chips: [chip],
    });

    await flushAsyncWork();

    const chipElement = container?.querySelector<HTMLElement>('.inline-chip');
    expectChipUiIcon(chipElement?.querySelector('.inline-chip-icon'), folderIcon);
    expect(chipElement?.dataset.chipMarker).toBe('@src/');
    expect(chipElement?.querySelector('.inline-chip-icon-wrap')?.children).toHaveLength(1);
  });

  it('renders default document chips with the empty-page icon', async () => {
    const chip: RichComposerChip = {
      id: 'document:notes',
      type: 'mention-file',
      label: 'Notes',
      textMarker: '@Notes',
    };

    renderComposer({ value: '@Notes', cursorOffset: 0, chips: [chip] });
    await flushAsyncWork();

    const chipElement = container?.querySelector<HTMLElement>('.inline-chip');
    expectChipUiIcon(chipElement?.querySelector('.inline-chip-icon'), emptyPageIcon);
    expect(chipElement?.dataset.chipMarker).toBe('@Notes');
    expect(chipElement?.querySelector('.inline-chip-label')?.textContent).toBe('Notes');
  });

  it('sizes agent icons consistently with image icons', async () => {
    renderComposer({
      value: '@vision [Image 1]',
      cursorOffset: 0,
      chips: [
        {
          id: 'agent:vision',
          type: 'mention-agent',
          label: 'vision',
          icon: 'agent',
          textMarker: '@vision',
        },
        {
          id: 'image:1',
          type: 'image',
          label: 'Image 1',
          icon: 'image',
          textMarker: '[Image 1]',
        },
      ],
    });

    await flushAsyncWork();

    const agentIcon = container?.querySelector('[data-chip-type="mention-agent"] img');
    const imageIcon = container?.querySelector('[data-chip-type="image"] img');
    expect(agentIcon).toBeInstanceOf(HTMLImageElement);
    expect(agentIcon?.classList).toContain('material-chip-icon');
    expect(imageIcon).toBeInstanceOf(HTMLImageElement);
    expect(imageIcon?.classList).toContain('material-chip-icon');
    expect(imageIcon?.classList).toContain('inline-chip-icon');
  });

  it('reports the chip id through onChipClick when an inline chip is clicked', async () => {
    const onChipClick = vi.fn();
    const chip: RichComposerChip = {
      id: 'file:/workspace/src/app.ts',
      type: 'mention-file',
      label: 'app.ts',
      icon: 'file',
      textMarker: '@src/app.ts',
    };

    renderComposer({
      value: '@src/app.ts',
      cursorOffset: 0,
      chips: [chip],
      onChipClick,
    });

    await flushAsyncWork();

    const label = container?.querySelector<HTMLElement>('.inline-chip .inline-chip-label');
    label?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onChipClick).toHaveBeenCalledWith('file:/workspace/src/app.ts');
  });

  it('does not call onChipClick for clicks on plain composer text', async () => {
    const onChipClick = vi.fn();

    renderComposer({
      value: 'hello world',
      cursorOffset: 0,
      chips: [],
      onChipClick,
    });

    await flushAsyncWork();

    const editor = container?.querySelector<HTMLElement>('[contenteditable]');
    editor?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onChipClick).not.toHaveBeenCalled();
  });
});
