import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import {
  resetDefaultAppState,
  setExpandThinkingByDefaultPreference,
  setShowThinking,
  setState,
} from '../lib/state';
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
  setExpandThinkingByDefaultPreference(false);
  setShowThinking(true);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  setExpandThinkingByDefaultPreference(false);
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
    expect(formatReasoningDuration({ start: 10, end: 17 })).toBe('7ms');
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
  it('expands reasoning blocks by default when the setting is enabled', () => {
    setExpandThinkingByDefaultPreference(true);

    renderPart(reasoningPart('**Planning**\n\nStep one'));

    expect(container?.querySelector('.thinking-content')?.textContent).toContain('Step one');
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
    setExpandThinkingByDefaultPreference(true);
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
    setExpandThinkingByDefaultPreference(true);
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

  it('renders agent handoff and compaction notices', () => {
    renderPart({
      id: 'agent-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'agent',
      name: 'explore',
    });

    expect(container?.textContent).toContain('Handing off to Explore');

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

    trigger?.click();

    expect(document.body.classList.contains('chat-image-preview-open')).toBe(true);
    expect(
      container?.querySelector('.chat-image-preview-overlay')?.getAttribute('aria-label')
    ).toBe('Image preview: images/chart.png');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.body.classList.contains('chat-image-preview-open')).toBe(false);
    expect(container?.querySelector('.chat-image-preview-overlay')).toBeNull();
  });
});
