import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { createStore } from 'solid-js/store';
import { resetDefaultAppState, setShowThinking, setState } from '../lib/state';
import {
  clearReasoningAutoOpened,
  resetToolCallExpansionState,
} from '../lib/tool-call-expansion-state';
import type { AssistantMessage, Part, ReasoningPart } from '../types';
import {
  MessagePart,
  formatReasoningDuration,
  formatReasoningHeader,
  splitReasoningText,
} from './MessagePart';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  resetDefaultAppState();
  resetToolCallExpansionState();
  setShowThinking(true);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  resetDefaultAppState();
});

function renderPart(
  part: Part,
  options: { messageInfo?: AssistantMessage; streamedText?: string | null } = {}
) {
  cleanup = render(
    () =>
      MessagePart({
        part,
        messageInfo: options.messageInfo,
        streamedText: options.streamedText,
      }),
    container!
  );
}

function reasoningPart(text: string, overrides: Partial<ReasoningPart> = {}): ReasoningPart {
  return {
    id: 'reasoning-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'reasoning',
    text,
    time: { start: 0, end: 1 },
    ...overrides,
  };
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function assistantMessage(id: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  const base: AssistantMessage = {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 0, completed: 1 },
    parentID: 'user-1',
    modelID: 'model-1',
    providerID: 'provider-1',
    mode: 'default',
    path: { cwd: '/repo', root: '/repo' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };

  return {
    ...base,
    ...overrides,
    time: overrides.time ?? base.time,
    path: overrides.path ?? base.path,
    tokens: overrides.tokens ?? base.tokens,
  };
}

describe('formatReasoningDuration', () => {
  it('returns null while reasoning is still running', () => {
    expect(formatReasoningDuration({ start: 12 })).toBeNull();
  });

  it('formats completed reasoning time', () => {
    expect(formatReasoningDuration({ start: 0, end: 7000 })).toBe('7s');
  });

  it('hides sub-second reasoning durations', () => {
    expect(formatReasoningDuration({ start: 10, end: 17 })).toBeNull();
  });
});

describe('formatReasoningHeader', () => {
  it('shows the subject without the Thinking prefix when present', () => {
    expect(formatReasoningHeader('Inspecting extension util files')).toBe(
      'Inspecting extension util files'
    );
  });

  it('falls back to Thinking when there is no subject', () => {
    expect(formatReasoningHeader(null)).toBe('Thinking');
  });

  it('appends detail labels after the primary heading', () => {
    expect(formatReasoningHeader('Inspecting extension util files', 'GPT-5 · High Reasoning')).toBe(
      'Inspecting extension util files · GPT-5 · High Reasoning'
    );
  });
});

describe('splitReasoningText', () => {
  it('moves a bold first line into the thinking header', () => {
    expect(
      splitReasoningText(
        '**Considering layout options**\n\nI am weighing warning and error displays.'
      )
    ).toEqual({
      subject: 'Considering layout options',
      body: 'I am weighing warning and error displays.',
    });
  });

  it('ignores reasoning text without a standalone bold subject line', () => {
    expect(splitReasoningText('Thinking through the layout options.')).toEqual({
      subject: null,
      body: 'Thinking through the layout options.',
    });
  });

  it('skips leading blank lines before extracting the subject', () => {
    expect(splitReasoningText('\n\n**Plan the migration**\n\nStep one\nStep two')).toEqual({
      subject: 'Plan the migration',
      body: 'Step one\nStep two',
    });
  });
});

describe('MessagePart', () => {
  it('starts reasoning blocks collapsed', () => {
    renderPart(reasoningPart('**Planning**\n\nStep one'));

    expect(container?.querySelector('.thinking-content')).toBeNull();
    expect(container?.querySelector('.thinking-header')?.getAttribute('aria-expanded')).toBe(
      'false'
    );
    const icon = container?.querySelector('.thinking-topic-icon');
    expect(icon?.getAttribute('width')).toBe('12');
    expect(icon?.getAttribute('height')).toBe('12');
    expect(icon?.getAttribute('viewBox')).toBe('2 2 20 20');
    expect(icon?.getAttribute('stroke-width')).toBe('1.7');
  });

  it('keeps a user-expanded reasoning block open when virtualization remounts it', () => {
    const part = reasoningPart('**Planning**\n\nStep one');
    renderPart(part);

    container?.querySelector<HTMLButtonElement>('.thinking-header')?.click();
    expect(container?.querySelector('.thinking-content')?.textContent).toContain('Step one');

    cleanup?.();
    cleanup = undefined;
    container!.innerHTML = '';
    renderPart({ ...part, text: '**Planning**\n\nStep one\nStep two' });

    expect(container?.querySelector('.thinking-content')?.textContent).toContain('Step two');
    expect(container?.querySelector('.thinking-header')?.getAttribute('aria-expanded')).toBe(
      'true'
    );
  });

  it('settles an auto-opened streaming reasoning block when the row remounts completed', () => {
    const part = reasoningPart('**Planning**\n\nStep one', { time: { start: 0 } });
    renderPart(part);

    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('true');

    // Rows (and thus this block) are recreated when the completed part commits;
    // the new instance must settle the unobserved auto-open.
    cleanup?.();
    container!.innerHTML = '';
    renderPart({ ...part, text: '**Planning**\n\nStep one', time: { start: 0, end: 1000 } });

    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('false');
    expect(container?.querySelector('.thinking-content')).toBeNull();

    // The settled state survives later remounts.
    cleanup?.();
    container!.innerHTML = '';
    renderPart({ ...part, text: '**Planning**\n\nStep one', time: { start: 0, end: 1000 } });

    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('false');
  });

  it('keeps an auto-opened reasoning block expanded until the message settles when its part ends first', () => {
    const part = reasoningPart('**Planning**\n\nStep one', { time: { start: 0 } });
    const runningInfo = assistantMessage('message-1', { time: { created: 0 } });
    renderPart(part, { messageInfo: runningInfo });

    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('true');

    // The part commits its end while the message is still running; the row
    // remount must keep the auto-opened block visible.
    cleanup?.();
    container!.innerHTML = '';
    renderPart({ ...part, time: { start: 0, end: 1000 } }, { messageInfo: runningInfo });

    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('true');
    expect(container?.querySelector('.thinking-content')?.textContent).toContain('Step one');

    // Once the message settles, the pending auto-open collapses the block.
    cleanup?.();
    container!.innerHTML = '';
    renderPart(
      { ...part, time: { start: 0, end: 1000 } },
      { messageInfo: assistantMessage('message-1', { time: { created: 0, completed: 5 } }) }
    );

    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('false');
    expect(container?.querySelector('.thinking-content')).toBeNull();
  });

  it('collapses an auto-opened reasoning block when the message settles without a remount', async () => {
    const [part, setPart] = createStore(
      reasoningPart('**Planning**\n\nStep one', { time: { start: 0 } })
    );
    const [info, setInfo] = createStore(
      assistantMessage('message-1', { time: { created: 0 } })
    );
    cleanup = render(() => MessagePart({ part, messageInfo: info }), container!);

    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('true');

    // The reasoning part finishes while the message keeps running; the block
    // must stay expanded so the thinking stays visible.
    setPart('time', 'end', 1000);
    await nextFrame();
    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('true');
    expect(container?.querySelector('.thinking-content')?.textContent).toContain('Step one');

    setInfo('time', 'completed', 5);
    await nextFrame();
    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('false');
  });

  it('collapses a remounted reasoning block when the message settles after the part ended', async () => {
    const part = reasoningPart('**Planning**\n\nStep one', { time: { start: 0 } });
    const [info, setInfo] = createStore(assistantMessage('message-1', { time: { created: 0 } }));

    renderPart(part, { messageInfo: info });
    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('true');

    // The part commits its end while the message keeps running; the row is
    // recreated and the new instance never observes the streaming run.
    cleanup?.();
    container!.innerHTML = '';
    renderPart({ ...part, time: { start: 0, end: 1000 } }, { messageInfo: info });
    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('true');

    // When the message settles in place, the pending auto-open that survived
    // the recreation must collapse the remounted instance.
    setInfo('time', 'completed', 5);
    await nextFrame();
    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('false');
    expect(container?.querySelector('.thinking-content')).toBeNull();

    // The settled state survives later remounts.
    cleanup?.();
    container!.innerHTML = '';
    renderPart({ ...part, time: { start: 0, end: 1000 } }, { messageInfo: info });
    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('false');
  });

  it('keeps a settled reasoning block whose auto-open marker was lost collapsed', () => {
    const key = 'reasoning\u0000session-1\u0000message-1\u0000reasoning-1';
    const part = reasoningPart('**Planning**\n\nStep one', { time: { start: 0 } });
    renderPart(part);

    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('true');

    // The row is disposed before the message settles and the pending
    // auto-open does not survive (eviction, session rehydration), so the
    // stored expanded state is stale when the settled row is recreated.
    clearReasoningAutoOpened(key);
    cleanup?.();
    container!.innerHTML = '';
    renderPart({ ...part, time: { start: 0, end: 1000 } });

    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('false');
    expect(container?.querySelector('.thinking-content')).toBeNull();
  });

  it('keeps a user-collapsed streaming reasoning block closed across a completed remount', () => {
    const part = reasoningPart('**Planning**\n\nStep one', { time: { start: 0 } });
    renderPart(part);

    // Collapse the auto-opened block; the user choice must survive the remount.
    container?.querySelector<HTMLButtonElement>('.thinking-header')?.click();
    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('false');

    cleanup?.();
    cleanup = undefined;
    container!.innerHTML = '';
    renderPart({ ...part, text: '**Planning**\n\nStep one', time: { start: 0, end: 1000 } });

    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('false');
  });

  it('keeps a re-expanded streaming reasoning block open across a completed remount', () => {
    const part = reasoningPart('**Planning**\n\nStep one', { time: { start: 0 } });
    renderPart(part);

    // Collapse then re-expand: an explicit user expansion must survive the remount.
    container?.querySelector<HTMLButtonElement>('.thinking-header')?.click();
    container?.querySelector<HTMLButtonElement>('.thinking-header')?.click();
    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('true');

    cleanup?.();
    cleanup = undefined;
    container!.innerHTML = '';
    renderPart({ ...part, text: '**Planning**\n\nStep one', time: { start: 0, end: 1000 } });

    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('true');
  });

  it('follows streaming reasoning at the bottom until the user scrolls away', async () => {
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains('thinking-content') && this.textContent?.includes('Step two')) {
          return 600;
        }
        return 500;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 200,
    });

    try {
      const [part, setPart] = createStore(reasoningPart('Step one', { time: { start: 0 } }));
      cleanup = render(() => MessagePart({ part }), container!);

      // Streaming blocks auto-expand and start following from the bottom.
      expect(
        container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
      ).toBe('true');
      const content = container?.querySelector<HTMLDivElement>('.thinking-content');
      expect(content?.scrollTop).toBe(500);

      // The streaming follow scroll is deferred one frame so it measures the height
      // after the newest delta is inserted.
      setPart('text', 'Step one\nStep two');
      await nextFrame();
      expect(content?.scrollTop).toBe(600);

      content!.scrollTop = 100;
      content?.dispatchEvent(new Event('scroll'));
      setPart('text', 'Step one\nStep two\nStep three');
      await nextFrame();
      expect(content?.scrollTop).toBe(100);

      setPart('time', 'end', 1000);
      await nextFrame();
      expect(content?.scrollTop).toBe(100);
      expect(container?.querySelector('.thinking-header')?.getAttribute('aria-expanded')).toBe(
        'false'
      );
    } finally {
      if (scrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeight);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
      if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
    }
  });

  it('returns auto-followed reasoning to the top when streaming completes', () => {
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 500,
    });

    try {
      const [part, setPart] = createStore(reasoningPart('Step one', { time: { start: 0 } }));
      cleanup = render(() => MessagePart({ part }), container!);

      // Streaming blocks auto-expand and start following from the bottom.
      const content = container?.querySelector<HTMLDivElement>('.thinking-content');
      expect(content?.scrollTop).toBe(500);

      setPart('time', 'end', 1000);
      expect(content?.scrollTop).toBe(0);
      // Auto-collapse on completion, but the user can reopen from the top.
      expect(container?.querySelector('.thinking-content')).toBeNull();

      content!.scrollTop = 120;
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.click();
      expect(container?.querySelector<HTMLDivElement>('.thinking-content')?.scrollTop).toBe(0);
    } finally {
      if (scrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeight);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
    }
  });

  it('keeps a reasoning summary but hides an empty HTML-comment body', () => {
    renderPart(reasoningPart('**Designing shared finder cache with TTL**\n\n<!-- -->'));

    expect(container?.querySelector('.thinking-label-text')?.textContent).toBe(
      'Designing shared finder cache with TTL'
    );
    expect(container?.querySelector('.thinking-content')).toBeNull();
    expect(container?.querySelector('.thinking-chevron')).toBeNull();
    expect(container?.textContent).not.toContain('<!-- -->');
  });

  it('renders streamed text for text parts', () => {
    renderPart(
      {
        id: 'text-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'text',
        text: 'stale text',
      },
      { streamedText: 'live streamed text' }
    );

    expect(container?.textContent).toContain('live streamed text');
    expect(container?.textContent).not.toContain('stale text');
  });

  it('renders usage-limit retry notices with the special copy', () => {
    renderPart({
      id: 'retry-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'retry',
      attempt: 2,
      error: { name: 'RateLimitError', data: { message: '429 usage limit reached, retry in 2s' } },
      time: { created: 0 },
    });

    const notice = container?.querySelector('.chat-retry-notice');
    expect(notice?.classList.contains('usage-limit')).toBe(true);
    expect(notice?.textContent).toContain('Retry attempt 2');
    expect(notice?.textContent).toContain('usage limit reached');
  });

  it('hides service-unavailable notices until the fourth retry', () => {
    const part = {
      id: 'retry-service',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'retry' as const,
      attempt: 3,
      error: { name: 'ServiceUnavailable', data: { message: 'Server is overloaded' } },
      time: { created: 0 },
    };

    renderPart(part);
    expect(container?.querySelector('.chat-retry-notice')).toBeNull();

    cleanup?.();
    cleanup = undefined;
    container!.textContent = '';
    renderPart({ ...part, attempt: 4 });
    expect(container?.querySelector('.chat-retry-notice')?.textContent).toContain(
      'Retry attempt 4'
    );
  });

  it('renders non-limit retry messages verbatim', () => {
    renderPart({
      id: 'retry-2',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'retry',
      attempt: 3,
      error: { name: 'NetworkError', data: { message: 'socket disconnected' } },
      time: { created: 0 },
    });

    expect(container?.querySelector('.chat-retry-notice')?.classList.contains('usage-limit')).toBe(
      false
    );
    expect(container?.querySelector('.chat-retry-error')?.textContent).toBe(
      '- socket disconnected'
    );
  });

  it('shows model and variant labels when subagent reasoning changes models', () => {
    setState('providers', [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
          },
          'gpt-5': {
            id: 'gpt-5',
            name: 'GPT-5',
            capabilities: { toolcall: true, reasoning: true },
            cost: { input: 0, output: 0 },
            variants: {
              'high-reasoning': {},
            },
          },
        },
      },
    ]);

    const parent = assistantMessage('parent-1', {
      providerID: 'openai',
      modelID: 'gpt-4o',
    });
    const child = assistantMessage('child-1', {
      parentID: 'parent-1',
      providerID: 'openai',
      modelID: 'gpt-5',
      mode: 'subagent',
      variant: 'high-reasoning',
    });

    setState('messages', [
      { info: parent, parts: [] },
      { info: child, parts: [] },
    ]);

    renderPart(reasoningPart('**Planning**\n\nStep one', { messageID: child.id }), {
      messageInfo: child,
    });

    expect(container?.querySelector('.thinking-label-text')?.textContent).toBe(
      'Planning · GPT-5 · High Reasoning'
    );
  });

  it('shows a No thinking detail when a subagent drops an unsupported variant', () => {
    setState('providers', [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-4o-mini': {
            id: 'gpt-4o-mini',
            name: 'GPT-4o mini',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
          },
        },
      },
    ]);

    const parent = assistantMessage('parent-2', {
      providerID: 'openai',
      modelID: 'gpt-4o-mini',
      variant: 'high-reasoning',
    });
    const child = assistantMessage('child-2', {
      parentID: 'parent-2',
      providerID: 'openai',
      modelID: 'gpt-4o-mini',
      mode: 'subagent',
    });

    setState('messages', [
      { info: parent, parts: [] },
      { info: child, parts: [] },
    ]);

    renderPart(reasoningPart('**Routing**\n\nStep one', { messageID: child.id }), {
      messageInfo: child,
    });

    expect(container?.querySelector('.thinking-label-text')?.textContent).toBe(
      'Routing · No thinking'
    );
  });

  it('renders agent chips and compaction notices', () => {
    renderPart({
      id: 'agent-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'agent',
      name: 'explore',
    });

    const chip = container?.querySelector('.message-attachment-chip');
    expect(chip?.textContent).toBe('Explore');
    expect(chip?.getAttribute('data-copy-marker')).toBe('@explore');
    expect(chip?.getAttribute('title')).toBe('Agent: Explore');

    cleanup?.();
    cleanup = undefined;

    renderPart({
      id: 'compaction-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'compaction',
      auto: true,
      overflow: true,
    });

    expect(container?.textContent).toContain('context compacted (auto)');
    expect(container?.textContent).toContain('after overflow');
  });

  it('hides empty subtask agent metadata', () => {
    renderPart({
      id: 'subtask-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'subtask',
      prompt: 'Inspect failures',
      description: 'Inspect failing tests',
      agent: '',
    });

    expect(container?.textContent).toContain('Inspect failing tests');
    expect(container?.querySelector('.subtask-meta')).toBeNull();
  });

  it('renders workspace-relative file chips for non-image attachments', () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    renderPart({
      id: 'file-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'file',
      mime: 'application/pdf',
      filename: '/repo/docs/spec.pdf',
      url: 'https://example.test/spec.pdf',
    });

    expect(container?.querySelector('.chip-label')?.textContent).toBe('docs/spec.pdf');
    expect(container?.querySelector('.file-type-icon')).toBeInstanceOf(HTMLImageElement);
  });

  it('opens and closes image previews for image attachments', () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    renderPart({
      id: 'file-2',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'file',
      mime: 'image/png',
      url: 'blob:image-1',
      source: {
        type: 'file',
        path: '/repo/images/chart.png',
        text: { value: '', start: 0, end: 0 },
      },
    });

    const trigger = container?.querySelector<HTMLButtonElement>('.chat-image-preview-trigger');
    expect(trigger?.getAttribute('aria-label')).toBe('Open image preview: images/chart.png');
    expect(trigger?.hasAttribute('title')).toBe(false);

    trigger?.click();

    expect(document.body.classList.contains('chat-image-preview-open')).toBe(true);
    expect(
      document.body.querySelector('.chat-image-preview-overlay')?.getAttribute('aria-label')
    ).toBe('Image preview: images/chart.png');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.body.classList.contains('chat-image-preview-open')).toBe(false);
    expect(document.body.querySelector('.chat-image-preview-overlay')).toBeNull();
  });
});
