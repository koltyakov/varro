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
          preview={{
            id: 'msg-1',
            index: 3,
            text: 'Summarize the latest failing test output.',
            attachmentCount: 0,
            imageCount: 0,
          }}
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

  it('toggles the overflow fade as the preview scrolls', async () => {
    cleanup = render(
      () => (
        <StickyUserMessagePreviewCard
          preview={{
            id: 'msg-1',
            index: 3,
            text: 'A very long prompt that overflows the preview window.',
            attachmentCount: 0,
            imageCount: 0,
          }}
        />
      ),
      container!
    );

    const clip = container?.querySelector<HTMLElement>('.latest-user-message-sticky-text-clip');
    const text = container?.querySelector<HTMLElement>('.latest-user-message-sticky-text');
    expect(clip).not.toBeNull();
    expect(text).not.toBeNull();

    Object.defineProperties(text!, {
      clientHeight: { configurable: true, value: 72 },
      scrollHeight: { configurable: true, value: 200 },
    });
    text!.scrollTop = 0;
    text!.dispatchEvent(new Event('scroll'));
    expect(clip?.classList.contains('has-more-below')).toBe(true);

    text!.scrollTop = 128;
    text!.dispatchEvent(new Event('scroll'));
    expect(clip?.classList.contains('has-more-below')).toBe(false);
  });

  it('invokes the click handler with a custom title', () => {
    const onClick = vi.fn();
    const preview = {
      id: 'msg-1',
      index: 3,
      text: 'Summarize the latest failing test output.',
      attachmentCount: 0,
      imageCount: 0,
    };
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

  it('is not clickable without an onClick handler', () => {
    cleanup = render(
      () => (
        <StickyUserMessagePreviewCard
          preview={{
            id: 'msg-1',
            index: 3,
            text: 'A prompt.',
            attachmentCount: 0,
            imageCount: 0,
          }}
        />
      ),
      container!
    );

    const card = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(card?.classList.contains('latest-user-message-sticky-clickable')).toBe(false);
  });

  it('shows loading feedback and ignores repeat clicks', () => {
    const onClick = vi.fn();
    cleanup = render(
      () => (
        <StickyUserMessagePreviewCard
          preview={{
            id: 'msg-1',
            index: -1,
            text: 'A prompt behind history.',
            attachmentCount: 0,
            imageCount: 0,
          }}
          loading
          onClick={onClick}
        />
      ),
      container!
    );

    const card = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(card?.classList.contains('is-loading')).toBe(true);
    expect(card?.textContent).toContain('Loading…');
    card?.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders attachment and image counters when the preview contains them', () => {
    cleanup = render(
      () => (
        <StickyUserMessagePreviewCard
          preview={{
            id: 'msg-1',
            index: 3,
            text: 'See attached.',
            attachmentCount: 2,
            imageCount: 1,
          }}
        />
      ),
      container!
    );

    const meta = container?.querySelector('.latest-user-message-sticky-meta');
    expect(meta).not.toBeNull();
    const items = Array.from(
      container?.querySelectorAll('.latest-user-message-sticky-meta-item') || []
    );
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.textContent)).toEqual(['1', '2']);
  });

  it('omits the meta row when there are no attachments or images', () => {
    cleanup = render(
      () => (
        <StickyUserMessagePreviewCard
          preview={{
            id: 'msg-1',
            index: 3,
            text: 'A prompt.',
            attachmentCount: 0,
            imageCount: 0,
          }}
        />
      ),
      container!
    );

    expect(container?.querySelector('.latest-user-message-sticky-meta')).toBeNull();
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
