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
