import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { Permission, QuestionRequest } from '../../types';

vi.mock('../QuestionPrompt', () => ({
  QuestionPrompt: (props: { request: QuestionRequest }) => (
    <div class="mock-question-prompt">question:{props.request.id}</div>
  ),
}));

vi.mock('../PermissionPrompt', () => ({
  PermissionPrompt: (props: { permission: Permission }) => (
    <div class="mock-permission-prompt">permission:{props.permission.id}</div>
  ),
}));

import {
  ChatContentBottomFade,
  PendingActionRows,
  StickyUserMessagePreviewCard,
} from './MessageListChrome';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

describe('MessageListChrome', () => {
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

  it('renders the sticky user message preview shell with hidden semantics', () => {
    cleanup = render(
      () => (
        <StickyUserMessagePreviewCard
          preview={{ id: 'msg-1', index: 3, text: 'Summarize the latest failing test output.' }}
        />
      ),
      container!
    );

    const wrapper = container?.querySelector('.latest-user-message-sticky-wrap');

    expect(wrapper?.getAttribute('aria-hidden')).toBe('true');
    expect(container?.querySelector('.latest-user-message-sticky-text')?.textContent).toBe(
      'Summarize the latest failing test output.'
    );
    expect(container?.querySelector('.latest-user-message-sticky-bottom-fade')).not.toBeNull();
  });

  it('invokes onEdit with the preview when the sticky card is clicked', () => {
    const onEdit = vi.fn();
    const preview = { id: 'msg-1', index: 3, text: 'Summarize the latest failing test output.' };
    cleanup = render(
      () => <StickyUserMessagePreviewCard preview={preview} onEdit={onEdit} />,
      container!
    );

    const card = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(card?.classList.contains('latest-user-message-sticky-clickable')).toBe(true);
    expect(card?.getAttribute('title')).toBe('Click to edit message');

    card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onEdit).toHaveBeenCalledWith(preview);
  });

  it('invokes the generic click handler with a custom title', () => {
    const onClick = vi.fn();
    const preview = { id: 'msg-1', index: 3, text: 'Summarize the latest failing test output.' };
    cleanup = render(
      () => (
        <StickyUserMessagePreviewCard
          preview={preview}
          title="Click to scroll to message"
          onClick={onClick}
        />
      ),
      container!
    );

    const card = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(card?.classList.contains('latest-user-message-sticky-clickable')).toBe(true);
    expect(card?.getAttribute('title')).toBe('Click to scroll to message');

    card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClick).toHaveBeenCalledWith(preview);
  });

  it('is not clickable without an onEdit handler', () => {
    cleanup = render(
      () => <StickyUserMessagePreviewCard preview={{ id: 'msg-1', index: 3, text: 'A prompt.' }} />,
      container!
    );

    const card = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(card?.classList.contains('latest-user-message-sticky-clickable')).toBe(false);
  });

  it('renders the chat content bottom fade shell with hidden semantics', () => {
    cleanup = render(() => <ChatContentBottomFade />, container!);

    const wrapper = container?.querySelector('.interactive-list-bottom-fade-wrap');

    expect(wrapper?.getAttribute('aria-hidden')).toBe('true');
    expect(container?.querySelector('.interactive-list-bottom-fade-gradient')).not.toBeNull();
  });

  it('renders pending question and permission rows in interactive containers', () => {
    const questions: QuestionRequest[] = [
      {
        id: 'question-1',
        sessionID: 'session-1',
        questions: [],
      },
      {
        id: 'question-2',
        sessionID: 'session-1',
        questions: [],
      },
    ];
    const permissions: Permission[] = [
      {
        id: 'permission-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: 'message-1',
        callID: 'call-1',
        title: 'Run command',
        metadata: {},
        time: { created: 1 },
      },
    ];

    cleanup = render(
      () => <PendingActionRows questions={questions} permissions={permissions} />,
      container!
    );

    const rows = Array.from(container?.querySelectorAll('.interactive-item-container') || []);

    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.classList.contains('interactive-response'))).toBe(true);
    expect(rows.map((row) => row.textContent)).toEqual([
      'question:question-1',
      'question:question-2',
      'permission:permission-1',
    ]);
  });
});
