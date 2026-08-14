import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
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
    expect(container?.querySelector('.composer-external-link-icon')).toBeNull();
    expect(reference?.dataset.chipMarker).toBeUndefined();
    expect(reference?.getAttribute('contenteditable')).toBeNull();
    expect(extractText(editor)).toBe('See https://iconoir.com');

    if (!reference?.firstChild) throw new Error('Expected external link text');
    reference.firstChild.textContent = 'https://iconoir.dev';
    setCollapsedSelection(reference.firstChild, 'https://iconoir.dev'.length);
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
    if (!editor || !reference?.firstChild) throw new Error('Expected editable external link');
    editor.focus();
    reference.firstChild.textContent = "https://iconoir.com what's this";
    setCollapsedSelection(reference.firstChild, "https://iconoir.com what's this".length);
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
    if (!editor || !reference?.firstChild) throw new Error('Expected editable external link');
    editor.focus();
    setCollapsedSelection(reference.firstChild, 'https://iconoir.com'.length);
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

  it('reports no insertion when paste handling prevents the paste', () => {
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
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? '@README.md' : '') },
    });

    editor?.dispatchEvent(event);

    expect(onInput).not.toHaveBeenCalled();
    expect(onPasteInsertion).toHaveBeenCalledWith(event, null);
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

    originalContainer!.getBoundingClientRect = () =>
      ({ left: 10, right: 510, width: 500 }) as DOMRect;
    frame.getBoundingClientRect = () => ({ top: 380 }) as DOMRect;
    const inlineChip = frame.querySelector<HTMLElement>('.inline-chip')!;
    inlineChip.getBoundingClientRect = () => ({ left: 30, right: 100, width: 70 }) as DOMRect;
    inlineChip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    const preview = document.querySelector<HTMLElement>('.chat-attachment-image-preview');
    expect(preview?.querySelector('img')?.getAttribute('src')).toBe('blob:image-1');
    expect(preview?.style.bottom).toBe(`${window.innerHeight - 380 + 22}px`);
  });

  it('uses the chip title for hover text when provided', async () => {
    const chip: RichComposerChip = {
      id: 'file:/workspace/src/webview/components/chat-input/BusySendMenu.test.tsx',
      type: 'mention-file',
      label: 'BusySendMenu.test.tsx',
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

    const iconPath = container?.querySelector('.inline-chip .inline-chip-icon path');
    expect(iconPath?.getAttribute('d')).toBe(
      'M1.75 3h3.1c.31 0 .6.14.79.38l.86 1.12h7.75c.41 0 .75.34.75.75V6H1V3.75C1 3.34 1.34 3 1.75 3zM1 7h14v4.25c0 .97-.78 1.75-1.75 1.75H2.75A1.75 1.75 0 011 11.25V7z'
    );
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
