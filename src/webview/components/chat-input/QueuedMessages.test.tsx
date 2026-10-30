import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { createChatAnnotation, getChatAnnotationLabel } from '../../../shared/chat-annotation';
import { QueuedMessages, type QueuedMessageItem } from './QueuedMessages';

let container: HTMLDivElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
});

function mount(items: QueuedMessageItem[], pendingSteers: QueuedMessageItem[] = []) {
  const onEdit = vi.fn();
  dispose = render(
    () => (
      <QueuedMessages
        items={items}
        pendingSteers={pendingSteers}
        canEdit
        canSendImmediately
        onRetryDispatch={vi.fn()}
        onSendAsSteer={vi.fn()}
        onSetPaused={vi.fn()}
        onReorder={vi.fn()}
        onEdit={onEdit}
        onCancelEdit={vi.fn()}
        onRemove={vi.fn()}
      />
    ),
    container
  );
  return onEdit;
}

describe('queued annotation previews', () => {
  it('shows bracketed comment previews without changing the text or attachments used for editing', () => {
    const file = createChatAnnotation('Selected passage', 'Test $& note');
    const text = `This is a test message @${file.relativePath}`;
    const item = { id: 'queued-1', sessionId: 'session-1', text, droppedFiles: [file] };
    const onEdit = mount([item]);
    expect(container.querySelector('.chat-queue-label .ui-icon')).toBeNull();
    expect(container.querySelector('[aria-label="1 attachment"]')).not.toBeNull();
    expect(container.querySelector('.chat-queue-label')?.textContent).toBe(
      'This is a test message [Test $& note]'
    );
    expect(container.querySelector('.chat-queue-drag-handle')?.getAttribute('aria-label')).toBe(
      'Reorder queued message: This is a test message [Test $& note]'
    );
    container.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]')!.click();
    expect(onEdit).toHaveBeenCalledWith(item);
    expect(item.text).toBe(text);
    expect(item.droppedFiles).toEqual([file]);
  });

  it('formats multiple annotations using the same shortened comment labels as the chips', () => {
    const first = createChatAnnotation('First passage', 'Please check this assumption. '.repeat(4));
    const second = createChatAnnotation('Second passage', 'Also this');
    mount([
      {
        id: 'queued-2',
        sessionId: 'session-1',
        text: `@${first.relativePath} and @${second.relativePath}`,
        droppedFiles: [first, second],
      },
    ]);
    expect(container.querySelector('.chat-queue-label')?.textContent).toBe(
      `[${getChatAnnotationLabel('Please check this assumption. '.repeat(4))}] and [Also this]`
    );
  });

  it('also formats annotation references in pending steering previews', () => {
    const file = createChatAnnotation('Selected passage', 'Check this');
    mount(
      [],
      [
        {
          id: 'steer-1',
          sessionId: 'session-1',
          text: `Steer @${file.relativePath}`,
          droppedFiles: [file],
        },
      ]
    );
    const label = container.querySelector('.chat-queue-label');
    expect(label?.textContent).toBe('Steer [Check this]');
    expect(label?.getAttribute('title')).toBe('Steer [Check this]');
  });

  it('uses canonical pending-message labels when composer attachment snapshots are unavailable', () => {
    const file = createChatAnnotation('Original passage', 'Check this');
    const text = `Steer @${file.relativePath}`;
    mount(
      [{ id: 'queued', sessionId: 'session-1', text, droppedFiles: [file] }],
      [
        {
          id: 'pending',
          sessionId: 'session-1',
          text,
          annotationLabels: { [`@${file.relativePath}`]: 'Check this' },
        },
      ]
    );
    expect(
      [...container.querySelectorAll('.chat-queue-label')].map((label) => label.textContent)
    ).toEqual(['Steer [Check this]', 'Steer [Check this]']);
    expect(container.querySelector('.chat-queue-label .ui-icon')).toBeNull();
  });

  it('leaves ordinary file mentions and missing annotation attachments unchanged', () => {
    const text = 'Check @notes.txt and @annotation-12345678.txt';
    mount([
      {
        id: 'queued-3',
        sessionId: 'session-1',
        text,
        droppedFiles: [{ path: '/repo/notes.txt', relativePath: 'notes.txt', type: 'file' }],
      },
    ]);
    expect(container.querySelector('.chat-queue-label')?.textContent).toBe(text);
  });

  it('counts duplicate references to one annotation once', () => {
    const file = createChatAnnotation('Selected passage', 'Test');
    mount([
      {
        id: 'queued-duplicate',
        sessionId: 'session-1',
        text: `@${file.relativePath}`,
        droppedFiles: [file, { ...file }],
      },
    ]);
    expect(container.querySelector('[aria-label="1 attachment"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="2 attachments"]')).toBeNull();
  });

  it('still counts separate current-document context alongside an annotation', () => {
    const file = createChatAnnotation('Selected passage', 'Test');
    mount([
      {
        id: 'queued-context',
        sessionId: 'session-1',
        text: `@${file.relativePath}`,
        droppedFiles: [file, { path: '/repo/main.ts', relativePath: 'main.ts', type: 'file' }],
      },
    ]);
    expect(container.querySelector('[aria-label="2 attachments"]')).not.toBeNull();
  });
});
