import { flush as flushSolid, createSignal } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import { markLoadingActivity, setState, startLoading, stopLoading } from '../../lib/state';
import {
  backgroundProcessView,
  closeBackgroundProcessView,
} from '../../lib/background-process-view';
import { attachmentIcon, hourglassIcon, mediaImageIcon } from '../../lib/ui-icons';
import { toCssUrl } from '../UiIcon';
import type { Permission, QuestionRequest } from '../../types';
import type { StickyUserMessagePreview } from './sticky-preview';

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise chrome integration with permission and question prompts. */
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
  LoadingRow,
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
    flushSolid();
    cleanup = undefined;
    container?.remove();
    flushSolid();
    container = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    stopLoading();
    flushSolid();
    closeBackgroundProcessView();
    flushSolid();
    setState(storePath('activeSessionId', null));
    flushSolid();
  });

  it('keeps elapsed time moving after a stale loading session resumes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T12:00:00Z'));
    flushSolid();
    startLoading();
    flushSolid();
    cleanup = render(() => <LoadingRow compacting={false} visible />, container!);
    flushSolid();

    vi.advanceTimersByTime(91_000);
    flushSolid();
    expect(container?.querySelector('.loading-indicator')?.classList.contains('stale')).toBe(true);

    markLoadingActivity();
    flushSolid();
    expect(container?.querySelector('.loading-indicator')?.classList.contains('stale')).toBe(false);

    vi.advanceTimersByTime(10_000);
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('1m 41s');

    stopLoading();
    flushSolid();
    startLoading();
    flushSolid();
    vi.advanceTimersByTime(10_000);
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('10s');
  });

  it('shows the background process card with its elapsed duration and no stale-session warning', () => {
    vi.useFakeTimers();
    startLoading();
    flushSolid();
    const startedAt = Date.now() - 13_000;
    cleanup = render(
      () => (
        <LoadingRow compacting={false} visible waiting toolsRunning waitingStartedAt={startedAt} />
      ),
      container!
    );
    flushSolid();
    expect(
      container?.querySelector('.background-process .tool-invocation-duration')?.textContent
    ).toBe('13s');
    vi.advanceTimersByTime(180_000);
    flushSolid();
    expect(
      container?.querySelector('.background-process .tool-invocation-title')?.textContent
    ).toBe('Background process');
    expect(
      container?.querySelector('.background-process .tool-invocation-duration')?.textContent
    ).toBe('3m 13s');
    expect(container?.querySelector('.tool-call-wait-icon')?.getAttribute('style')).toContain(
      toCssUrl(hourglassIcon)
    );
    expect(container?.querySelector('.loading-indicator')).toBeNull();
    expect(container?.textContent).not.toContain('Session may be stale');
    expect(container?.querySelector('.loading-action')).toBeNull();
  });

  it('opens a session-scoped details view without changing the loading slot', () => {
    setState(storePath('activeSessionId', 'ses_background'));
    flushSolid();
    startLoading();
    flushSolid();
    cleanup = render(() => <LoadingRow compacting={false} visible waiting />, container!);
    flushSolid();
    const button = container!.querySelector<HTMLButtonElement>(
      '[aria-label="View background process details"]'
    )!;
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    button.click();
    flushSolid();
    expect(backgroundProcessView()?.sessionID).toBe('ses_background');
    expect(container!.querySelector('.background-process')).not.toBeNull();
    expect(container!.querySelector('.loading-indicator')).toBeNull();
  });
  it('shows the command and retains it during the resume handoff without leaking across sessions', () => {
    setState(storePath('activeSessionId', 'ses_background'));
    flushSolid();
    const [command, setCommand] = createSignal<string | undefined>('python3 tools/serve.py 18765');
    startLoading();
    flushSolid();
    cleanup = render(
      () => <LoadingRow compacting={false} visible waiting waitingCommand={command()} />,
      container!
    );
    flushSolid();
    const title = () => container!.querySelector('.background-process .tool-invocation-title');
    expect(title()?.textContent).toBe('Background process: python3 tools/serve.py 18765');
    expect(title()?.getAttribute('title')).toBe('python3 tools/serve.py 18765');
    setCommand(undefined);
    flushSolid();
    expect(title()?.textContent).toBe('Background process: python3 tools/serve.py 18765');
    setState(storePath('activeSessionId', 'ses_other'));
    flushSolid();
    expect(title()?.textContent).toBe('Background process');
  });

  it('counts from the last completion without resetting on ordinary activity', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    flushSolid();
    startLoading(0);
    flushSolid();
    const [completedAt, setCompletedAt] = createSignal(80_000);
    cleanup = render(
      () => <LoadingRow compacting={false} visible elapsedStartedAt={completedAt()} />,
      container!
    );
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('20s');
    markLoadingActivity();
    flushSolid();
    vi.advanceTimersByTime(2_000);
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('22s');
    setCompletedAt(Date.now());
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('0s');
    vi.advanceTimersByTime(10_000);
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('10s');
  });

  it('shows duration after the first second of the turn', () => {
    vi.useFakeTimers();
    startLoading();
    flushSolid();
    cleanup = render(() => <LoadingRow compacting={false} visible />, container!);
    flushSolid();
    vi.advanceTimersByTime(999);
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')).toBeNull();
    vi.advanceTimersByTime(1);
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('1s');
  });

  it('keeps rotating verbs and showing duration through frequent completions and hidden previews', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    flushSolid();
    startLoading();
    flushSolid();
    const [completedAt, setCompletedAt] = createSignal(0);
    const [visible, setVisible] = createSignal(true);
    cleanup = render(
      () => <LoadingRow compacting={false} visible={visible()} elapsedStartedAt={completedAt()} />,
      container!
    );
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')).toBeNull();
    for (let second = 1; second <= 18; second += 1) {
      vi.advanceTimersByTime(1_000);
      flushSolid();
      setCompletedAt(Date.now());
      flushSolid();
      expect(container?.querySelector('.loading-verb')?.textContent).toBe(
        second < 6
          ? 'Thinking'
          : second < 12
            ? 'Analyzing'
            : second < 18
              ? 'Considering'
              : 'Pondering'
      );
      expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('0s');
    }
    setVisible(false);
    flushSolid();
    vi.advanceTimersByTime(6_000);
    flushSolid();
    setCompletedAt(Date.now());
    flushSolid();
    setVisible(true);
    flushSolid();
    expect(container?.querySelector('.loading-verb')?.textContent).toBe('Musing');
    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('0s');
  });

  it('hides loading duration whenever the preceding active tool displays its own timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    flushSolid();
    startLoading(0);
    flushSolid();
    const [duration, setDuration] = createSignal<string | null>('1m');
    const [followingText, setFollowingText] = createSignal(false);
    const [emptyRowText, setEmptyRowText] = createSignal('');
    const [toolsRunning, setToolsRunning] = createSignal(true);
    const [runningDuration, setRunningDuration] = createSignal(true);
    cleanup = render(
      () => (
        <>
          <div>
            <div data-assistant-render-key="part:tool">
              <div class="chat-tool-invocation-part">
                <div class="tool-invocation-header">
                  <span
                    class="tool-invocation-duration"
                    title={runningDuration() ? 'Elapsed time' : undefined}
                  >
                    {duration()}
                  </span>
                </div>
              </div>
            </div>
            {followingText() && <div data-assistant-render-key="part:text">A later response</div>}
          </div>
          <div>
            <div data-assistant-render-key="part:following-row">{emptyRowText()}</div>
          </div>
          <LoadingRow compacting={false} visible toolsRunning={toolsRunning()} />
        </>
      ),
      container!
    );
    flushSolid();
    expect(container?.querySelector('.loading-verb')?.textContent).not.toBe('Waiting');
    expect(container?.querySelector('.loading-elapsed')).toBeNull();
    setEmptyRowText('A new response');
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('1m 00s');
    setEmptyRowText('');
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')).toBeNull();
    setDuration('59s');
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')).toBeNull();
    setDuration('1m 1s');
    flushSolid();
    vi.advanceTimersByTime(1_000);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')).toBeNull();
    setFollowingText(true);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('1m 01s');
    setFollowingText(false);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')).toBeNull();
    setDuration(null);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('1m 01s');
    setDuration('1m 1s');
    flushSolid();
    await Promise.resolve();
    flushSolid();
    setRunningDuration(false);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('1m 01s');
    setRunningDuration(true);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')).toBeNull();
    setToolsRunning(false);
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('1m 01s');
  });

  it('keeps the normal verb cycle while tools run', () => {
    vi.useFakeTimers();
    startLoading();
    flushSolid();
    const [toolsRunning, setToolsRunning] = createSignal(true);
    const [compacting, setCompacting] = createSignal(false);
    cleanup = render(
      () => <LoadingRow compacting={compacting()} visible toolsRunning={toolsRunning()} />,
      container!
    );
    flushSolid();
    const row = container?.querySelector('.interactive-loading-row');
    const verb = container?.querySelector('.shimmer-progress.loading-verb');
    const dots = verb?.querySelector('.chat-animated-ellipsis');
    expect(dots).not.toBeNull();
    expect(container?.querySelector('.loading-verb')?.textContent).toBe('Thinking');
    vi.advanceTimersByTime(7_000);
    flushSolid();
    expect(container?.querySelector('.loading-verb')?.textContent).toBe('Analyzing');
    setCompacting(true);
    flushSolid();
    expect(container?.querySelector('.loading-verb')?.textContent).toBe('Compacting');
    setCompacting(false);
    flushSolid();
    setToolsRunning(false);
    flushSolid();
    expect(container?.querySelector('.loading-verb')?.textContent).toBe('Analyzing');
    vi.advanceTimersByTime(3_000);
    flushSolid();
    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('10s');
    setToolsRunning(true);
    flushSolid();
    expect(container?.querySelector('.loading-verb')?.textContent).toBe('Analyzing');
    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('10s');
    expect(container?.querySelector('.loading-verb')).toBe(verb);
    expect(container?.querySelector('.chat-animated-ellipsis')).toBe(dots);
    expect(container?.querySelector('.interactive-loading-row')).toBe(row);
    expect(container?.querySelectorAll('.interactive-loading-row')).toHaveLength(1);
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
    flushSolid();

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
    flushSolid();

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
    flushSolid();

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
    flushSolid();

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
      () => (
        <TurnNavigationRail
          turns={turns}
          activeTurnId="msg-2"
          visibleTurnIds={new Set(['msg-1', 'msg-2'])}
          onSelect={onSelect}
        />
      ),
      container!
    );
    flushSolid();

    const markers = container?.querySelectorAll<HTMLButtonElement>('.turn-navigation-marker');
    expect(markers).toHaveLength(2);
    expect(container?.querySelectorAll('.turn-navigation-marker.is-active')).toHaveLength(2);
    expect(
      container
        ?.querySelector<HTMLElement>('.turn-navigation')
        ?.style.getPropertyValue('--turn-count')
    ).toBe('2');
    expect(markers?.[1]?.getAttribute('aria-current')).toBe('step');
    expect(markers?.[0]?.getAttribute('aria-label')).toBe('Go to turn 1: First prompt');

    markers?.[0]?.click();
    flushSolid();
    expect(onSelect).toHaveBeenCalledWith(turns[0]);
  });

  it('shows the turn, prompt, and timestamp to the right of a hovered active dot', async () => {
    vi.useFakeTimers();
    const sentAt = Date.now();
    const onTurnHoverChange = vi.fn();
    cleanup = render(
      () => (
        <TurnNavigationRail
          turns={[
            { id: 'msg-1', index: 0, text: 'Prompt', sentAt, attachmentCount: 0, imageCount: 0 },
          ]}
          activeTurnId="msg-1"
          hoveredTurnId="msg-1"
          onTurnHoverChange={onTurnHoverChange}
          onSelect={() => {}}
        />
      ),
      container!
    );
    flushSolid();
    const dot = container!.querySelector<HTMLButtonElement>('.turn-navigation-marker')!;
    vi.spyOn(dot, 'getBoundingClientRect').mockReturnValue(new DOMRect(8, 100, 12, 11));
    dot.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    await vi.advanceTimersByTimeAsync(150);
    flushSolid();
    const tooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(tooltip.firstElementChild?.textContent).toBe('Turn 1 of 1');
    const prompt = tooltip.querySelector('.turn-navigation-tooltip-prompt');
    expect(prompt?.textContent).toBe('Prompt');
    expect(tooltip.firstElementChild?.nextElementSibling).toBe(prompt);
    expect(prompt?.nextElementSibling?.className).toBe('turn-navigation-tooltip-time');
    expect(tooltip.querySelector('.turn-navigation-tooltip-time')?.textContent).toBe(
      new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(sentAt)
    );
    expect(tooltip.classList).toContain('right');
    expect(parseFloat(tooltip.style.left)).toBe(26);
    expect(dot.classList).toContain('is-active');
    expect(dot.classList).toContain('is-hovered');
    expect(dot.hasAttribute('title')).toBe(false);
    expect(onTurnHoverChange).toHaveBeenCalledWith('msg-1', true);
    dot.dispatchEvent(new MouseEvent('mouseleave'));
    flushSolid();
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(onTurnHoverChange).toHaveBeenLastCalledWith('msg-1', false);
  });

  it('trims multiline tooltip prompts and refreshes compact markup previews without a timestamp', async () => {
    vi.useFakeTimers();
    const text = '  Review\n\t' + 'the failing test output '.repeat(6) + '  ';
    const [turns, setTurns] = createSignal<StickyUserMessagePreview[]>([
      { id: 'msg-1', index: 0, text, attachmentCount: 0, imageCount: 0 },
    ]);
    cleanup = render(
      () => <TurnNavigationRail turns={turns()} activeTurnId="msg-1" onSelect={() => {}} />,
      container!
    );
    flushSolid();
    const dot = container!.querySelector<HTMLButtonElement>('.turn-navigation-marker')!;
    dot.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    await vi.advanceTimersByTimeAsync(150);
    flushSolid();
    const tooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]')!;
    const prompt = tooltip.querySelector('.turn-navigation-tooltip-prompt')!;
    const normalized = text.replaceAll(/\s+/g, ' ').trim();
    flushSolid();
    expect(prompt.textContent).toBe(`${normalized.slice(0, 77)}...`);
    expect(prompt.textContent).toHaveLength(80);
    expect(tooltip.querySelector('.turn-navigation-tooltip-time')).toBeNull();

    setTurns([
      {
        ...turns()[0]!,
        text: '<svg>...</svg>',
        format: { kind: 'svg', byteSize: 18 * 1024 },
        formatPrefix: 'Use this icon',
      },
    ]);
    flushSolid();
    expect(container!.querySelector('.turn-navigation-marker')).toBe(dot);
    expect(prompt.textContent).toBe('Use this icon SVG content');
    expect(prompt.textContent).not.toContain('<svg>');
  });

  it('preserves dot hover across preview refreshes and blur while the pointer stays over it', () => {
    const [turns, setTurns] = createSignal([
      { id: 'msg-1', index: 0, text: 'Original prompt', attachmentCount: 0, imageCount: 0 },
    ]);
    const onTurnHoverChange = vi.fn();
    const onSelect = vi.fn();
    cleanup = render(
      () => (
        <TurnNavigationRail
          turns={turns()}
          activeTurnId="msg-1"
          onTurnHoverChange={onTurnHoverChange}
          onSelect={onSelect}
        />
      ),
      container!
    );
    flushSolid();
    const dot = container!.querySelector<HTMLButtonElement>('.turn-navigation-marker')!;
    dot.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    expect(onTurnHoverChange).toHaveBeenLastCalledWith('msg-1', true);
    setTurns([{ ...turns()[0]!, text: 'Updated prompt', index: 3 }]);
    flushSolid();
    expect(container!.querySelector('.turn-navigation-marker')).toBe(dot);
    expect(dot.getAttribute('aria-label')).toBe('Go to turn 1: Updated prompt');
    expect(onTurnHoverChange).toHaveBeenCalledTimes(1);
    dot.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    flushSolid();
    expect(onTurnHoverChange).toHaveBeenCalledTimes(1);
    dot.click();
    flushSolid();
    expect(onSelect).toHaveBeenCalledWith(turns()[0]);
    dot.dispatchEvent(new MouseEvent('mouseleave'));
    flushSolid();
    expect(onTurnHoverChange).toHaveBeenLastCalledWith('msg-1', false);
  });

  it('pages a long rail without losing absolute turn numbers or selection targets', () => {
    const turns = Array.from({ length: 120 }, (_, index) => ({
      id: `msg-${index + 1}`,
      index,
      text: `Prompt ${index + 1}`,
      attachmentCount: 0,
      imageCount: 0,
    }));
    const onSelect = vi.fn();
    cleanup = render(
      () => <TurnNavigationRail turns={turns} activeTurnId="msg-120" onSelect={onSelect} />,
      container!
    );
    flushSolid();
    const markers = () => [
      ...container!.querySelectorAll<HTMLButtonElement>('.turn-navigation-marker'),
    ];
    expect(markers()).toHaveLength(20);
    flushSolid();
    expect(markers()[0]!.getAttribute('aria-label')).toBe('Go to turn 101: Prompt 101');
    flushSolid();
    expect(markers().at(-1)!.getAttribute('aria-label')).toBe('Go to turn 120: Prompt 120');
    flushSolid();
    const earlier = container!.querySelector<HTMLButtonElement>('[aria-label="Earlier turns"]')!;
    const later = container!.querySelector<HTMLButtonElement>('[aria-label="Later turns"]')!;
    expect(later.disabled).toBe(true);
    earlier.click();
    flushSolid();
    expect(markers()[0]!.getAttribute('aria-label')).toBe('Go to turn 82: Prompt 82');
    flushSolid();
    markers()[0]!.click();
    flushSolid();
    expect(onSelect).toHaveBeenCalledWith(turns[81]);
    later.click();
    flushSolid();
    expect(markers().at(-1)!.getAttribute('aria-label')).toBe('Go to turn 120: Prompt 120');
    flushSolid();
  });

  it('scrolls the dot window with pixel, line, and page wheel input without scrolling the conversation', () => {
    const turns = Array.from({ length: 120 }, (_, index) => ({
      id: `msg-${index + 1}`,
      index,
      text: `Prompt ${index + 1}`,
      attachmentCount: 0,
      imageCount: 0,
    }));
    const onSelect = vi.fn();
    cleanup = render(
      () => <TurnNavigationRail turns={turns} activeTurnId="msg-1" onSelect={onSelect} />,
      container!
    );
    flushSolid();
    const rail = container!.querySelector<HTMLElement>('.turn-navigation')!;
    const firstTitle = () =>
      rail.querySelector<HTMLButtonElement>('.turn-navigation-marker')!.getAttribute('aria-label');
    const bubble = vi.fn();
    container!.addEventListener('wheel', bubble);
    flushSolid();
    const wheel = (deltaY: number, deltaMode = 0, ctrlKey = false) => {
      const event = new WheelEvent('wheel', {
        deltaY,
        deltaMode,
        ctrlKey,
        bubbles: true,
        cancelable: true,
      });
      rail.dispatchEvent(event);
      flushSolid();
      return event;
    };
    expect(wheel(5).defaultPrevented).toBe(true);
    expect(firstTitle()).toBe('Go to turn 1: Prompt 1');
    wheel(6);
    expect(firstTitle()).toBe('Go to turn 2: Prompt 2');
    wheel(3, 1);
    expect(firstTitle()).toBe('Go to turn 5: Prompt 5');
    wheel(1, 2);
    expect(firstTitle()).toBe('Go to turn 25: Prompt 25');
    wheel(-10000);
    expect(firstTitle()).toBe('Go to turn 1: Prompt 1');
    wheel(-100);
    wheel(11);
    expect(firstTitle()).toBe('Go to turn 2: Prompt 2');
    wheel(10000);
    expect(firstTitle()).toBe('Go to turn 101: Prompt 101');
    expect(bubble).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(wheel(-100, 0, true).defaultPrevented).toBe(false);
    expect(firstTitle()).toBe('Go to turn 101: Prompt 101');
    container!.removeEventListener('wheel', bubble);
    flushSolid();
  });

  it('keeps a manually paged destination mounted when previews and equivalent visibility refresh', () => {
    const [turns, setTurns] = createSignal(
      Array.from({ length: 120 }, (_, index) => ({
        id: `msg-${index + 1}`,
        index,
        text: `Prompt ${index + 1}`,
        attachmentCount: 0,
        imageCount: 0,
      }))
    );
    const [visibleIds, setVisibleIds] = createSignal(new Set(['msg-120']));
    const [activeId, setActiveId] = createSignal('msg-120');
    const onSelect = vi.fn();
    cleanup = render(
      () => (
        <TurnNavigationRail
          turns={turns()}
          activeTurnId={activeId()}
          visibleTurnIds={visibleIds()}
          onSelect={onSelect}
        />
      ),
      container!
    );
    flushSolid();
    const earlier = container!.querySelector<HTMLButtonElement>('[aria-label="Earlier turns"]')!;
    earlier.click();
    flushSolid();
    const destination = container!.querySelector<HTMLButtonElement>(
      '[aria-label^="Go to turn 82:"]'
    )!;
    expect(destination).not.toBeNull();
    setTurns(turns().map((turn) => ({ ...turn, text: `${turn.text} refreshed` })));
    flushSolid();
    setVisibleIds(new Set(['msg-120']));
    flushSolid();
    expect(destination.isConnected).toBe(true);
    expect(container!.querySelector('[aria-label^="Go to turn 82:"]')).toBe(destination);
    destination.click();
    flushSolid();
    expect(onSelect).toHaveBeenCalledWith(turns()[81]);
    setActiveId('msg-1');
    flushSolid();
    setVisibleIds(new Set(['msg-1']));
    flushSolid();
    expect(container!.querySelector('[aria-label^="Go to turn 1:"]')).not.toBeNull();
  });

  it('reveals the reserved sticky timestamp without mounting new content', () => {
    vi.useFakeTimers();
    const now = new Date();
    const sentAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 13, 45).getTime();
    const [showSentTimestamp, setShowSentTimestamp] = createSignal(false);
    const onUserMessageHoverChange = vi.fn();
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
          onUserMessageHoverChange={onUserMessageHoverChange}
        />
      ),
      container!
    );
    flushSolid();

    const timestamp = container?.querySelector<HTMLTimeElement>('.latest-user-message-sticky-time');
    expect(timestamp?.classList.contains('is-visible')).toBe(false);
    expect(timestamp?.textContent).toBe(
      new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(sentAt)
    );

    setShowSentTimestamp(true);
    flushSolid();

    expect(container?.querySelector('.latest-user-message-sticky-time')).toBe(timestamp);
    expect(timestamp?.classList.contains('is-visible')).toBe(true);

    const sticky = container?.querySelector('.latest-user-message-sticky');
    sticky?.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    vi.advanceTimersByTime(150);
    flushSolid();
    sticky?.dispatchEvent(new MouseEvent('mouseleave'));
    flushSolid();
    vi.advanceTimersByTime(150);
    flushSolid();
    expect(onUserMessageHoverChange).not.toHaveBeenCalled();

    sticky?.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    expect(onUserMessageHoverChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(299);
    flushSolid();
    expect(onUserMessageHoverChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    flushSolid();
    expect(onUserMessageHoverChange).toHaveBeenLastCalledWith('msg-1', true);
    sticky?.dispatchEvent(new MouseEvent('mouseleave'));
    flushSolid();
    expect(onUserMessageHoverChange).toHaveBeenLastCalledWith('msg-1', false);
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
    flushSolid();

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
    flushSolid();
    expect(clip?.classList.contains('has-more-below')).toBe(true);

    text!.scrollTop = 128;
    text!.dispatchEvent(new Event('scroll'));
    flushSolid();
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
    flushSolid();

    for (let index = 0; index < 20; index += 1) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      resizeCallback?.(
        [
          { target: container!.querySelector('.latest-user-message-sticky-text')! },
        ] as ResizeObserverEntry[],
        {} as ResizeObserver
      );
    }

    expect(onGeometryChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    flushSolid();
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
    flushSolid();

    const card = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(card?.classList.contains('latest-user-message-sticky-clickable')).toBe(true);
    expect(card?.hasAttribute('title')).toBe(false);

    card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    expect(onClick).toHaveBeenCalledWith(preview);
  });

  it.each([
    { linkText: 'http://example.com', loading: false },
    { linkText: 'https://example.com', loading: false },
    { linkText: 'git@github.com:owner/repo.git', loading: false },
    { linkText: 'http://example.com', loading: true },
    { linkText: 'https://example.com', loading: true },
    { linkText: 'git@github.com:owner/repo.git', loading: true },
  ])(
    'routes inner $linkText clicks through the sticky card with loading=$loading',
    ({ linkText, loading }) => {
      const onClick = vi.fn();
      const send = vi.fn();
      vi.stubGlobal('__sendToExtension', send);
      const hostClick = vi.fn();
      const hostContextMenu = vi.fn();
      const preview = {
        id: 'msg-rich',
        index: 3,
        text: `Review ${linkText}`,
        attachmentCount: 0,
        imageCount: 0,
      };
      cleanup = render(
        () => (
          <div onClick={hostClick} onContextMenu={hostContextMenu}>
            <StickyUserMessagePreviewCard
              preview={preview}
              loading={loading}
              parts={[
                {
                  id: 'part-rich',
                  sessionID: 'session-1',
                  messageID: 'msg-rich',
                  type: 'text',
                  text: preview.text,
                },
              ]}
              onClick={onClick}
            />
          </div>
        ),
        container!
      );
      flushSolid();

      const link = container?.querySelector<HTMLAnchorElement>(
        '.latest-user-message-sticky a.external-link'
      );
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      expect(link).not.toBeNull();
      link!.querySelector('.link-leading-label')!.dispatchEvent(click);
      flushSolid();

      expect(click.defaultPrevented).toBe(true);
      if (loading) expect(onClick).not.toHaveBeenCalled();
      else expect(onClick).toHaveBeenCalledExactlyOnceWith(preview);
      expect(send).not.toHaveBeenCalled();
      expect(hostClick).not.toHaveBeenCalled();

      const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      link!.dispatchEvent(contextMenu);
      flushSolid();
      expect(contextMenu.defaultPrevented).toBe(false);
      expect(hostContextMenu).toHaveBeenCalledOnce();
    }
  );

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
    flushSolid();

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
    flushSolid();

    const card = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(card?.classList.contains('is-loading')).toBe(true);
    expect(card?.textContent).not.toContain('Loading…');
    expect(card?.querySelector('.latest-user-message-sticky-spinner')).not.toBeNull();
    card?.click();
    flushSolid();
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
    flushSolid();

    const meta = container?.querySelector('.latest-user-message-sticky-meta');
    expect(meta).not.toBeNull();
    const items = Array.from(
      container?.querySelectorAll('.latest-user-message-sticky-meta-item') || []
    );
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.textContent)).toEqual(['1', '2']);
    expect(
      items.map((item) =>
        item.querySelector<HTMLElement>('.ui-icon')?.style.getPropertyValue('--ui-icon-mask')
      )
    ).toEqual([toCssUrl(mediaImageIcon), toCssUrl(attachmentIcon)]);
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
    flushSolid();

    expect(container?.querySelector('.latest-user-message-sticky-meta')).toBeNull();
  });

  it('renders the chat content bottom fade shell with hidden semantics', () => {
    cleanup = render(() => <ChatContentBottomFade />, container!);
    flushSolid();

    const wrapper = container?.querySelector('.interactive-list-bottom-fade-wrap');

    expect(wrapper?.getAttribute('aria-hidden')).toBe('true');
    expect(container?.querySelector('.interactive-list-bottom-fade-gradient')).not.toBeNull();
    expect(container?.querySelector('.chat-content-fade-solid-gap')).toBeNull();
  });

  it('reuses only the gradient below content without a solid spacer', () => {
    cleanup = render(() => <ChatContentBottomFade belowContent />, container!);
    flushSolid();
    expect(
      container
        ?.querySelector('.interactive-list-bottom-fade-wrap.is-below-content')
        ?.getAttribute('aria-hidden')
    ).toBe('true');
    expect(container?.querySelector('.interactive-list-bottom-fade-gradient')).not.toBeNull();
    expect(container?.querySelector('.chat-content-fade-solid-gap')).toBeNull();
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
    flushSolid();

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
