import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import type { Permission, QuestionRequest } from '../../types';

vi.mock('../QuestionPrompt', () => ({
  QuestionPrompt: (props: { request: QuestionRequest }) => (
    <div class="mock-question-prompt">question:{props.request.id}</div>
  ),
}));

vi.mock('../PermissionPrompt', () => ({
  PermissionPrompt: (props: {
    permission: Permission;
    queuePosition?: number;
    queueTotal?: number;
  }) => (
    <div class="mock-permission-prompt">
      permission:{props.permission.id}:{props.queuePosition}/{props.queueTotal}
    </div>
  ),
}));

import {
  ChatContentBottomFade,
  PendingActionRows,
  StickyUserMessagePreviewCard,
  TurnNavigationRail,
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

  it('renders XML and SVG sticky previews as compact format chips', () => {
    cleanup = render(
      () => (
        <StickyUserMessagePreviewCard
          preview={{
            id: 'msg-svg',
            index: 3,
            text: '<svg>...</svg>',
            format: { kind: 'svg', byteSize: 18 * 1024 },
            formatPrefix: 'Change the agent chip icon to',
            attachmentCount: 0,
            imageCount: 0,
          }}
        />
      ),
      container!
    );

    expect(container?.querySelector('.latest-user-message-sticky-text')?.textContent).toBe(
      'Change the agent chip icon to SVG18 KB'
    );
    expect(container?.querySelector('.latest-user-message-sticky-text')?.textContent).not.toContain(
      '<svg>'
    );
  });

  it('renders sticky chips and links through the user message renderer', () => {
    cleanup = render(
      () => (
        <StickyUserMessagePreviewCard
          preview={{
            id: 'msg-rich',
            index: 3,
            text: 'Review @src/app.ts and https://example.com',
            attachmentCount: 1,
            imageCount: 0,
          }}
          parts={[
            {
              id: 'part-rich',
              sessionID: 'session-1',
              messageID: 'msg-rich',
              type: 'text',
              text: 'Review @src/app.ts and https://example.com',
            },
            {
              id: 'part-file',
              sessionID: 'session-1',
              messageID: 'msg-rich',
              type: 'text',
              text: '[Attached file: src/app.ts]',
            },
          ]}
        />
      ),
      container!
    );

    expect(
      container?.querySelector('.latest-user-message-sticky-text .inline-chip')
    ).not.toBeNull();
    expect(
      container?.querySelector<HTMLAnchorElement>(
        '.latest-user-message-sticky-text a.external-link'
      )?.href
    ).toBe('https://example.com/');
  });

  it('renders a prompt number counter on the sticky card when provided', () => {
    cleanup = render(
      () => (
        <StickyUserMessagePreviewCard
          preview={{
            id: 'msg-1',
            index: 3,
            text: 'A numbered prompt.',
            attachmentCount: 0,
            imageCount: 0,
          }}
          promptNumber={4}
        />
      ),
      container!
    );

    expect(
      container?.querySelector('.latest-user-message-sticky-shell > .prompt-number-badge')
        ?.textContent
    ).toBe('4');
  });

  it('renders conversation turn markers and selects a turn', () => {
    const turns = [
      {
        id: 'msg-1',
        index: 0,
        text: 'First prompt',
        attachmentCount: 0,
        imageCount: 0,
      },
      {
        id: 'msg-2',
        index: 2,
        text: 'Second prompt',
        attachmentCount: 0,
        imageCount: 0,
      },
    ];
    const onSelect = vi.fn();
    cleanup = render(
      () => <TurnNavigationRail turns={turns} activeTurnId="msg-2" onSelect={onSelect} />,
      container!
    );

    const markers = container?.querySelectorAll<HTMLButtonElement>('.turn-navigation-marker');
    expect(markers).toHaveLength(2);
    expect(markers?.[1]?.getAttribute('aria-current')).toBe('step');
    expect(markers?.[0]?.getAttribute('aria-label')).toBe('Go to turn 1: First prompt');

    markers?.[0]?.click();
    expect(onSelect).toHaveBeenCalledWith(turns[0]);
  });

  it('reveals the reserved sticky timestamp without mounting new content', () => {
    const now = new Date();
    const sentAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 13, 45).getTime();
    const [showSentTimestamp, setShowSentTimestamp] = createSignal(false);
    cleanup = render(
      () => (
        <StickyUserMessagePreviewCard
          preview={{
            id: 'msg-1',
            index: 3,
            text: 'A timestamped sticky prompt.',
            attachmentCount: 0,
            imageCount: 0,
          }}
          sentAt={sentAt}
          showSentTimestamp={showSentTimestamp()}
        />
      ),
      container!
    );

    const timestamp = container?.querySelector<HTMLTimeElement>('.latest-user-message-sticky-time');
    expect(timestamp?.classList.contains('is-visible')).toBe(false);
    expect(timestamp?.textContent).toBe(
      new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(sentAt)
    );

    setShowSentTimestamp(true);

    expect(container?.querySelector('.latest-user-message-sticky-time')).toBe(timestamp);
    expect(timestamp?.classList.contains('is-visible')).toBe(true);
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

  it('coalesces sticky text geometry changes until resizing settles', async () => {
    vi.useFakeTimers();
    let resizeCallback: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe() {}
        disconnect() {}
      }
    );
    const onGeometryChange = vi.fn();
    cleanup = render(
      () => (
        <StickyUserMessagePreviewCard
          preview={{
            id: 'msg-1',
            index: 3,
            text: 'A sticky prompt that changes height when the chat width changes.',
            attachmentCount: 0,
            imageCount: 0,
          }}
          onGeometryChange={onGeometryChange}
        />
      ),
      container!
    );

    for (let index = 0; index < 20; index += 1) {
      resizeCallback?.(
        [
          { target: container!.querySelector('.latest-user-message-sticky-text')! },
        ] as ResizeObserverEntry[],
        {} as ResizeObserver
      );
    }

    expect(onGeometryChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(onGeometryChange).toHaveBeenCalledOnce();
  });

  it('invokes the click handler without a redundant title', () => {
    const onClick = vi.fn();
    const preview = {
      id: 'msg-1',
      index: 3,
      text: 'Summarize the latest failing test output.',
      attachmentCount: 0,
      imageCount: 0,
    };
    cleanup = render(
      () => <StickyUserMessagePreviewCard preview={preview} onClick={onClick} />,
      container!
    );

    const card = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(card?.classList.contains('latest-user-message-sticky-clickable')).toBe(true);
    expect(card?.hasAttribute('title')).toBe(false);

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
    expect(card?.textContent).not.toContain('Loading…');
    expect(card?.querySelector('.latest-user-message-sticky-spinner')).not.toBeNull();
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
      {
        id: 'permission-2',
        type: 'edit',
        sessionID: 'session-1',
        messageID: 'message-2',
        callID: 'call-2',
        title: 'Edit file',
        metadata: {},
        time: { created: 2 },
      },
    ];

    cleanup = render(
      () => (
        <PendingActionRows
          questions={questions}
          permissions={permissions}
          permissionPosition={1}
          permissionTotal={2}
        />
      ),
      container!
    );

    const rows = Array.from(container?.querySelectorAll('.interactive-item-container') || []);

    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.classList.contains('interactive-response'))).toBe(true);
    expect(rows.map((row) => row.textContent)).toEqual([
      'question:question-1',
      'question:question-2',
      'permission:permission-1:1/2',
    ]);
  });
});
