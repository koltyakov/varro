import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ChatTextAnnotation } from './ChatTextAnnotation';

let root: HTMLDivElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
  root = document.createElement('div');
  root.innerHTML =
    '<div class="interactive-list" tabindex="0"><div class="interactive-item-container"><p>Selected chat passage</p></div></div><div class="composer-mount"></div>';
  document.body.append(root);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  root.remove();
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

function mount(props: Partial<Parameters<typeof ChatTextAnnotation>[0]> = {}) {
  const onSave = vi.fn();
  dispose = render(
    () => (
      <ChatTextAnnotation chatRoot={() => root} sessionId="session-1" onSave={onSave} {...props} />
    ),
    root.querySelector('.composer-mount')!
  );
  return onSave;
}

function select(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

function contextMenu(element: Element) {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 100,
    clientY: 120,
  });
  element.dispatchEvent(event);
  return event;
}

async function openEditor() {
  const passage = root.querySelector('p')!;
  select(passage);
  contextMenu(passage);
  document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
  await Promise.resolve();
  return document.querySelector<HTMLTextAreaElement>('[aria-label="Annotation"]')!;
}

function enterNote(textarea: HTMLTextAreaElement, text: string) {
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('chat text annotation', () => {
  it.each(['Copy', 'Copy markdown'])(
    'copies a captured selection with %s during streaming',
    async (action) => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const onSave = mount();
      const row = root.querySelector('.interactive-item-container')!;
      row.innerHTML =
        '<div class="rendered-markdown"><p>A <strong>selected</strong> passage</p><p>Not selected</p></div>';
      const passage = row.querySelector('p')!;
      select(passage);
      contextMenu(passage);
      await Promise.resolve();
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
      expect(buttons.map((button) => button.textContent)).toEqual([
        'Annotate',
        'Copy',
        'Copy markdown',
      ]);
      // Streaming can replace the selected DOM, and virtual rows can unmount before the click.
      passage.innerHTML = 'Changed while streaming';
      row.remove();
      window.getSelection()?.removeAllRanges();
      buttons.find((button) => button.textContent === action)!.click();
      expect(writeText).toHaveBeenCalledExactlyOnceWith(
        action === 'Copy' ? 'A selected passage' : 'A **selected** passage'
      );
      expect(document.querySelector('.chat-annotation-popup')).toBeNull();
      expect(onSave).not.toHaveBeenCalled();
    }
  );

  it('does not offer Copy markdown for plain message selections', () => {
    mount();
    const passage = root.querySelector('p')!;
    select(passage);
    contextMenu(passage);
    expect(
      Array.from(document.querySelectorAll('[role="menuitem"]'), (item) => item.textContent)
    ).toEqual(['Annotate', 'Copy']);
  });

  it.each(['whole', 'partial'])(
    'only offers Copy when a %s Markdown selection matches plain text',
    (selection) => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      mount();
      const passage = root.querySelector('p')!;
      passage.className = 'rendered-markdown';
      if (selection === 'whole') {
        select(passage);
      } else {
        passage.innerHTML = '<strong>Not selected</strong> Selected chat passage';
        const range = document.createRange();
        range.selectNodeContents(passage.lastChild!);
        window.getSelection()?.addRange(range);
      }
      contextMenu(passage);
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
      expect(buttons.map((button) => button.textContent)).toEqual(['Annotate', 'Copy']);
      buttons.find((button) => button.textContent === 'Copy')!.click();
      expect(writeText).toHaveBeenCalledExactlyOnceWith('Selected chat passage');
    }
  );

  it('includes Copy markdown in keyboard menu navigation', async () => {
    mount();
    const passage = root.querySelector('p')!;
    passage.className = 'rendered-markdown';
    passage.innerHTML = '<strong>Selected chat passage</strong>';
    select(passage);
    contextMenu(passage);
    await Promise.resolve();
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement?.textContent).toBe('Copy markdown');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.textContent).toBe('Annotate');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement?.textContent).toBe('Copy markdown');
  });

  it.each(['Escape', 'unmount'])(
    'retains a temporary selection highlight while typing and clears it on %s',
    async (action) => {
      const highlights = new Map<string, Set<Range>>();
      vi.stubGlobal('CSS', { highlights });
      vi.stubGlobal(
        'Highlight',
        class extends Set<Range> {
          constructor(...ranges: Range[]) {
            super(ranges);
          }
        }
      );
      mount();
      const textarea = await openEditor();
      expect(document.querySelectorAll('style[data-chat-annotation-highlight]')).toHaveLength(1);
      const highlight = highlights.get('varro-chat-annotation-selection');
      expect([...highlight!][0]!.toString()).toBe('Selected chat passage');
      window.getSelection()?.removeAllRanges();
      enterNote(textarea, 'My note');
      expect(highlights.size).toBe(1);
      if (action === 'Escape') {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } else {
        dispose?.();
        dispose = undefined;
      }
      expect(highlights.size).toBe(0);
      expect(document.querySelector('style[data-chat-annotation-highlight]')).toBeNull();
    }
  );

  it('opens a selected-text menu and saves the captured passage with a note', async () => {
    const onSave = mount();
    const passage = root.querySelector('p')!;
    select(passage);
    expect(contextMenu(passage).defaultPrevented).toBe(true);
    await Promise.resolve();
    const annotate = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(annotate.textContent).toBe('Annotate');
    expect(document.activeElement).toBe(annotate);
    annotate.click();
    await Promise.resolve();
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(document.activeElement).toBe(textarea);
    expect(document.querySelector('.chat-annotation-hint')?.textContent).toBe('Esc to cancel');
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(
      'Selected chat passage'
    );
    const save = document.querySelector<HTMLButtonElement>('.chat-annotation-save')!;
    expect(save.disabled).toBe(true);
    enterNote(textarea, "I don't agree");
    save.click();
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      pastedText:
        "Chat annotation\n\nSource session: session-1\n\nSelected text:\n> Selected chat passage\n\nComment:\nI don't agree",
    });
    expect(document.querySelector('.chat-annotation-popup')).toBeNull();
  });

  it('retains a text snapshot when selection changes and the virtual row unmounts', async () => {
    const onSave = mount();
    const textarea = await openEditor();
    root.querySelector('.interactive-item-container')!.remove();
    window.getSelection()?.removeAllRanges();
    enterNote(textarea, 'Keep this context');
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
    );
    expect(onSave.mock.calls[0]![0].pastedText).toContain('> Selected chat passage');
  });

  it('leaves the native menu alone without a selection, outside message rows, or in the composer', () => {
    mount();
    const passage = root.querySelector('p')!;
    expect(contextMenu(passage).defaultPrevented).toBe(false);
    const composer = root.querySelector('.composer-mount')!;
    composer.innerHTML = '<div contenteditable="true">Composer draft</div>';
    const editor = composer.firstElementChild!;
    select(editor);
    expect(contextMenu(editor).defaultPrevented).toBe(false);
    select(passage);
    expect(contextMenu(composer).defaultPrevented).toBe(false);
    expect(document.querySelector('.chat-annotation-popup')).toBeNull();
  });

  it('rejects a selection spanning the transcript and the composer', () => {
    mount();
    const passage = root.querySelector('p')!;
    const composer = root.querySelector('.composer-mount')!;
    composer.append(document.createTextNode('Draft'));
    const range = document.createRange();
    range.setStart(passage.firstChild!, 0);
    range.setEnd(composer.lastChild!, 5);
    window.getSelection()?.addRange(range);
    expect(contextMenu(passage).defaultPrevented).toBe(false);
  });

  it.each(['Cancel', 'Escape', 'outside'])(
    'dismisses with %s without adding an attachment',
    async (action) => {
      const onSave = mount();
      await openEditor();
      if (action === 'Cancel') {
        Array.from(document.querySelectorAll('button'))
          .find((button) => button.textContent === 'Cancel')!
          .click();
      } else if (action === 'Escape') {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } else {
        root.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      }
      expect(document.querySelector('.chat-annotation-popup')).toBeNull();
      expect(onSave).not.toHaveBeenCalled();
    }
  );

  it('closes on session change rather than attaching to another conversation', async () => {
    const [session, setSession] = createSignal('session-1');
    const onSave = mount({
      get sessionId() {
        return session();
      },
    });
    await openEditor();
    setSession('session-2');
    expect(document.querySelector('.chat-annotation-popup')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('preserves the note and shows an actionable error when attachment fails', async () => {
    const onSave = vi.fn(() => {
      throw new Error('Draft attachment budget exceeded');
    });
    mount({ onSave });
    const textarea = await openEditor();
    enterNote(textarea, 'My note');
    document.querySelector<HTMLButtonElement>('.chat-annotation-save')!.click();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Draft attachment budget exceeded'
    );
    expect(textarea.value).toBe('My note');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
