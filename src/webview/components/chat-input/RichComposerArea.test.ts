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
        onPaste: () => {},
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

  it('inserts plain text paste through onInput', () => {
    const onInput = vi.fn();

    renderComposer({ value: '', cursorOffset: 0, chips: [], onInput });

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.focus();
    if (editor) setCollapsedSelection(editor, 0);

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? 'pasted text' : '') },
    });

    editor?.dispatchEvent(event);

    expect(onInput).toHaveBeenCalledWith('pasted text', 11);
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
