import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import {
  replaceMessages,
  setSessions,
  setShowThinkingPreference,
  setState,
  skipPlanSession,
  startLoading,
  stopLoading,
} from '../lib/state';
import type {
  AssistantMessage,
  FilePart,
  Message,
  Part,
  Permission,
  QuestionRequest,
  UserMessage,
} from '../types';
import {
  buildPlanDocumentContent,
  buildPlanImplementationPrompt,
  getStickyUserMessagePreview,
  getStandalonePermissionPrompts,
  getStandaloneQuestionPrompts,
  getLatestPlanImplementationMessageId,
  pruneMeasuredHeights,
  shouldShowStickyUserMessagePreview,
  MessageList,
  calculateVirtualRange,
  shouldShowPlanImplementationAction,
} from './MessageList';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;

function textPart(
  id: string,
  text: string,
  options?: { ignored?: boolean; synthetic?: boolean }
): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'text',
    text,
    ...options,
  };
}

function filePart(id: string, filename: string): FilePart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'file',
    mime: 'image/png',
    filename,
    url: `https://example.test/${id}.png`,
  };
}

function userMessage(id: string): UserMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-5.4' },
  };
}

function assistantMessage(
  id: string,
  options?: {
    agent?: string;
    error?: AssistantMessage['error'];
  }
): AssistantMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: 'parent-1',
    modelID: 'gpt-5.4',
    providerID: 'openai',
    mode: 'default',
    agent: options?.agent,
    error: options?.error,
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function entry(info: Message) {
  return { info, parts: [] as Part[] };
}

function toolPart(id: string, messageID = 'message-1', callID = 'call-1'): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID,
    type: 'tool',
    callID,
    tool: 'bash',
    state: {
      status: 'running',
      input: { command: 'pwd' },
      time: { start: 1 },
    },
  };
}

function reasoningPart(id: string, text: string): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'reasoning',
    text,
    time: { start: 1 },
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  originalResizeObserver = globalThis.ResizeObserver;
  originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
  globalThis.requestAnimationFrame = vi.fn().mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  globalThis.cancelAnimationFrame = vi.fn();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  setState('messages', []);
  setState('sessions', []);
  setState('permissions', []);
  setState('questions', []);
  setState('activeSessionId', null);
  setState('providers', []);
  setState('agents', []);
  setState('allAgents', []);
  setState('queuedMessages', []);
  setState('pendingAttentionSessionIds', []);
  setState('streamingPartId', null);
  setState('streamingText', '');
  setState('sessionStatus', reconcile({}));
  setState('skippedPlanSessions', reconcile({}));
  setShowThinkingPreference(true);
  stopLoading();
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  vi.restoreAllMocks();
});

describe('buildPlanImplementationPrompt', () => {
  it('uses a stable handoff prompt without copying visible plan text', () => {
    expect(
      buildPlanImplementationPrompt([
        textPart('ignored', 'draft', { ignored: true }),
        textPart('plan-1', '1. Update the API route.'),
        textPart('plan-2', '2. Add the missing UI state.'),
      ])
    ).toBe(
      'Implement the plan from your last response in the current workspace. Make the code changes instead of revising the plan.'
    );
  });

  it('uses the same stable handoff prompt when the plan has no visible text', () => {
    expect(
      buildPlanImplementationPrompt([textPart('synthetic', 'placeholder', { synthetic: true })])
    ).toBe(
      'Implement the plan from your last response in the current workspace. Make the code changes instead of revising the plan.'
    );
  });
});

describe('buildPlanDocumentContent', () => {
  it('joins non-synthetic text parts into markdown content', () => {
    expect(
      buildPlanDocumentContent([
        textPart('text-1', '# Plan'),
        textPart('text-2', '1. First'),
        textPart('text-3', 'ignore me', { synthetic: true }),
      ])
    ).toBe('# Plan\n\n1. First');
  });

  it('returns an empty string when no real text parts exist', () => {
    expect(
      buildPlanDocumentContent([textPart('synthetic', 'placeholder', { synthetic: true })])
    ).toBe('');
  });
});

describe('calculateVirtualRange', () => {
  it('uses measured heights to calculate visible rows and padding', () => {
    const measuredHeights = new Map([
      ['a', 50],
      ['b', 100],
      ['c', 150],
      ['d', 200],
    ]);

    expect(
      calculateVirtualRange({
        itemIds: ['a', 'b', 'c', 'd'],
        measuredHeights,
        scrollTop: 120,
        viewportHeight: 120,
        defaultItemHeight: 100,
        overscan: 0,
      })
    ).toEqual({ start: 1, end: 3, topPad: 50, bottomPad: 200 });
  });

  it('falls back to default item heights for unmeasured rows', () => {
    expect(
      calculateVirtualRange({
        itemIds: ['a', 'b', 'c'],
        measuredHeights: new Map(),
        scrollTop: 90,
        viewportHeight: 40,
        defaultItemHeight: 50,
        overscan: 0,
      })
    ).toEqual({ start: 1, end: 3, topPad: 50, bottomPad: 0 });
  });

  it('prunes measured heights for removed messages', () => {
    const measuredHeights = new Map([
      ['a', 50],
      ['stale', 90],
    ]);

    expect(pruneMeasuredHeights(measuredHeights, ['a', 'b'])).toBe(true);
    expect(Array.from(measuredHeights.entries())).toEqual([['a', 50]]);
    expect(pruneMeasuredHeights(measuredHeights, ['a'])).toBe(false);
  });
});

describe('getStickyUserMessagePreview', () => {
  it('returns the preceding user prompt for the first visible assistant message', () => {
    expect(
      getStickyUserMessagePreview(
        [
          { info: userMessage('user-1'), parts: [textPart('text-1', 'Old prompt')] },
          { info: assistantMessage('assistant-1'), parts: [] },
          { info: userMessage('user-2'), parts: [textPart('text-2', 'Newest prompt')] },
          { info: assistantMessage('assistant-2'), parts: [] },
        ],
        3
      )
    ).toEqual({
      id: 'user-2',
      index: 2,
      text: 'Newest prompt',
    });
  });

  it('uses fallback preview text for attachment-only user messages', () => {
    expect(
      getStickyUserMessagePreview(
        [
          { info: userMessage('user-1'), parts: [filePart('file-1', 'diagram.png')] },
          { info: assistantMessage('assistant-1'), parts: [] },
        ],
        1
      )
    ).toEqual({
      id: 'user-1',
      index: 0,
      text: 'Attachment: diagram.png',
    });
  });

  it('skips empty user prompts when picking a sticky preview', () => {
    expect(
      getStickyUserMessagePreview(
        [
          {
            info: userMessage('user-1'),
            parts: [textPart('text-1', '(no content)', { ignored: true })],
          },
          { info: assistantMessage('assistant-1'), parts: [] },
        ],
        1
      )
    ).toBeNull();
  });

  it('returns null when the first visible message is already a user prompt', () => {
    expect(
      getStickyUserMessagePreview(
        [{ info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt')] }],
        0
      )
    ).toBeNull();
  });
});

describe('shouldShowStickyUserMessagePreview', () => {
  it('returns false on vertically narrow screens', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -120,
        rowBottom: -20,
        viewportHeight: 320,
      })
    ).toBe(false);
  });

  it('returns true when virtualization places the prompt above the visible range', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
        shouldVirtualize: true,
        visibleRange: { start: 5, end: 10 },
        rowTop: null,
        rowBottom: null,
        viewportHeight: 500,
      })
    ).toBe(true);
  });

  it('returns true when the prompt row sits above the viewport', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -120,
        rowBottom: -20,
        viewportHeight: 500,
      })
    ).toBe(true);
  });

  it('returns false when the prompt row is visible', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: 120,
        rowBottom: 180,
        viewportHeight: 500,
      })
    ).toBe(false);
  });

  it('hides the current sticky preview while any part of the prompt is visible', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: 12,
        rowBottom: 40,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(false);
  });

  it('hides the current sticky preview once the prompt peeks above it', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -5,
        rowBottom: 40,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(false);
  });

  it('hides the current sticky preview once the prompt extends below it', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: 10,
        rowBottom: 61,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(false);
  });

  it('hides the current sticky preview once the next user message rises into it', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: 10,
        rowBottom: 60,
        nextUserMessageTop: 58,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(false);
  });

  it('keeps the previous sticky preview only until the next user message reaches it', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -120,
        rowBottom: -20,
        nextUserMessageTop: 62,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(true);

    expect(
      shouldShowStickyUserMessagePreview({
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -120,
        rowBottom: -20,
        nextUserMessageTop: 59,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(false);
  });

  it('does not show a new sticky preview until the prompt is clearly above the viewport', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -10,
        rowBottom: 8,
        viewportHeight: 500,
        previousPreviewId: 'user-2',
      })
    ).toBe(false);
  });
});

describe('getLatestPlanImplementationMessageId', () => {
  it('returns the last plan response when it is the latest message', () => {
    expect(
      getLatestPlanImplementationMessageId([
        entry(userMessage('user-1')),
        entry(assistantMessage('assistant-1', { agent: 'plan' })),
      ])
    ).toBe('assistant-1');
  });

  it('returns null when a user prompt appears after the plan response', () => {
    expect(
      getLatestPlanImplementationMessageId([
        entry(userMessage('user-1')),
        entry(assistantMessage('assistant-1', { agent: 'plan' })),
        entry(userMessage('user-2')),
      ])
    ).toBeNull();
  });

  it('returns null when the latest assistant response is not a plan response', () => {
    expect(
      getLatestPlanImplementationMessageId([
        entry(userMessage('user-1')),
        entry(assistantMessage('assistant-1', { agent: 'plan' })),
        entry(assistantMessage('assistant-2', { agent: 'build' })),
      ])
    ).toBeNull();
  });
});

describe('shouldShowPlanImplementationAction', () => {
  it('hides the action for aborted plan responses', () => {
    const message = assistantMessage('assistant-1', {
      agent: 'plan',
      error: { name: 'aborted', data: { message: 'Aborted' } },
    });

    expect(
      shouldShowPlanImplementationAction({
        hasBuildAgent: true,
        info: message,
        latestPlanImplementationMessageId: 'assistant-1',
      })
    ).toBe(false);
  });

  it('hides the action after the plan session is skipped', () => {
    const message = assistantMessage('assistant-1', { agent: 'plan' });
    setState('skippedPlanSessions', reconcile({}));
    setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'session-1',
        version: '1',
        time: { created: 100, updated: 200 },
      },
    ]);
    skipPlanSession('session-1', 200);

    expect(
      shouldShowPlanImplementationAction({
        hasBuildAgent: true,
        info: message,
        latestPlanImplementationMessageId: 'assistant-1',
      })
    ).toBe(false);
  });

  it('shows the action for the latest unskipped plan response', () => {
    const message = assistantMessage('assistant-1', { agent: 'plan' });
    setState('skippedPlanSessions', reconcile({}));
    setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'session-1',
        version: '1',
        time: { created: 100, updated: 200 },
      },
    ]);

    expect(
      shouldShowPlanImplementationAction({
        hasBuildAgent: true,
        info: message,
        latestPlanImplementationMessageId: 'assistant-1',
      })
    ).toBe(true);
  });
});

describe('standalone action prompts', () => {
  it('keeps unmatched permissions visible as standalone prompts', () => {
    const permissions: Permission[] = [
      {
        id: 'perm-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: '',
        title: 'Allow bash',
        metadata: {},
        time: { created: 1 },
      },
    ];

    expect(getStandalonePermissionPrompts([], permissions, 'session-1')).toEqual(permissions);
  });

  it('keeps one standalone permission prompt for duplicate requests', () => {
    const permissions: Permission[] = [
      {
        id: 'perm-1',
        type: 'external_directory',
        sessionID: 'session-1',
        messageID: '',
        title: 'external_directory /tmp/*',
        metadata: { filepath: '/tmp/file-a', parentDir: '/tmp' },
        time: { created: 1 },
        duplicateIDs: ['perm-1', 'perm-2'],
      },
    ];

    expect(getStandalonePermissionPrompts([], permissions, 'session-1')).toEqual(permissions);
  });

  it('does not duplicate permissions already linked to a tool call', () => {
    const permissions: Permission[] = [
      {
        id: 'perm-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: 'message-1',
        callID: 'call-1',
        title: 'Allow bash',
        metadata: {},
        time: { created: 1 },
      },
    ];

    expect(
      getStandalonePermissionPrompts(
        [{ info: assistantMessage('message-1'), parts: [toolPart('tool-1')] }],
        permissions,
        'session-1'
      )
    ).toEqual([]);
  });

  it('keeps unmatched questions visible as standalone prompts', () => {
    const questions: QuestionRequest[] = [
      {
        id: 'question-1',
        sessionID: 'session-1',
        questions: [{ question: 'Choose one', header: 'Question', options: [] }],
      },
    ];

    expect(getStandaloneQuestionPrompts([], questions, 'session-1')).toEqual(questions);
  });

  it('does not duplicate questions already linked to a tool call', () => {
    const questions: QuestionRequest[] = [
      {
        id: 'question-1',
        sessionID: 'session-1',
        questions: [{ question: 'Choose one', header: 'Question', options: [] }],
        tool: { messageID: 'message-1', callID: 'call-1' },
      },
    ];

    expect(
      getStandaloneQuestionPrompts(
        [{ info: assistantMessage('message-1'), parts: [toolPart('tool-1')] }],
        questions,
        'session-1'
      )
    ).toEqual([]);
  });

  it('keeps child-session permissions visible for the active root session', () => {
    setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Session 1',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Child 1',
        version: '1',
        parentID: 'session-1',
        time: { created: 0, updated: 20 },
      },
    ]);

    const permissions: Permission[] = [
      {
        id: 'perm-1',
        type: 'bash',
        sessionID: 'child-1',
        messageID: '',
        title: 'Allow bash',
        metadata: {},
        time: { created: 1 },
      },
    ];

    expect(getStandalonePermissionPrompts([], permissions, 'session-1')).toEqual(permissions);
  });

  it('keeps child-session questions visible for the active root session', () => {
    setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Session 1',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Child 1',
        version: '1',
        parentID: 'session-1',
        time: { created: 0, updated: 20 },
      },
    ]);

    const questions: QuestionRequest[] = [
      {
        id: 'question-1',
        sessionID: 'child-1',
        questions: [{ question: 'Choose one', header: 'Question', options: [] }],
      },
    ];

    expect(getStandaloneQuestionPrompts([], questions, 'session-1')).toEqual(questions);
  });
});

describe('MessageList sticky prompt preview', () => {
  it('shows the prompt that belongs to the response currently in view', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
      { info: userMessage('user-3'), parts: [textPart('text-5', 'Prompt 3')] },
      { info: assistantMessage('assistant-3'), parts: [textPart('text-6', 'Response 3')] },
    ]);

    const rectMap = new Map<Element, DOMRect>();
    const defaultRect = new DOMRect(0, -600, 500, 40);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return rectMap.get(this) || defaultRect;
    });

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    const user2Row = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement | null;
    const user3Row = container?.querySelector('[data-msg-id="user-3"]') as HTMLDivElement | null;
    const assistant2Row = container?.querySelector(
      '[data-msg-id="assistant-2"]'
    ) as HTMLDivElement | null;
    const assistant3Row = container?.querySelector(
      '[data-msg-id="assistant-3"]'
    ) as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(user2Row).toBeInstanceOf(HTMLDivElement);
    expect(user3Row).toBeInstanceOf(HTMLDivElement);
    expect(assistant2Row).toBeInstanceOf(HTMLDivElement);
    expect(assistant3Row).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));

    rectMap.set(user2Row!, new DOMRect(0, -220, 500, 52));
    rectMap.set(assistant2Row!, new DOMRect(0, -340, 500, 300));
    rectMap.set(user3Row!, new DOMRect(0, -90, 500, 52));
    rectMap.set(assistant3Row!, new DOMRect(0, 40, 500, 320));

    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1200 });
    list?.dispatchEvent(new Event('scroll'));
    await Promise.resolve();

    let sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky).toBeInstanceOf(HTMLDivElement);
    expect(sticky?.textContent).toContain('Prompt 3');

    rectMap.set(assistant2Row!, new DOMRect(0, 40, 500, 320));
    rectMap.set(user3Row!, new DOMRect(0, -80, 500, 52));
    rectMap.set(assistant3Row!, new DOMRect(0, 20, 500, 320));

    list!.scrollTop = 1400;
    list?.dispatchEvent(new Event('scroll'));
    await Promise.resolve();

    sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky).toBeInstanceOf(HTMLDivElement);
    expect(sticky?.textContent).toContain('Prompt 2');
    expect(container?.querySelector('.interactive-list-track .latest-user-message-sticky')).toBe(
      sticky
    );
    expect(container?.querySelector('.latest-user-message-sticky [data-msg-id]')).toBeNull();
  });

  it('hides the sticky preview as soon as any part of the prompt is visible outside it', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    const rectMap = new Map<Element, DOMRect>();
    const defaultRect = new DOMRect(0, -600, 500, 40);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return rectMap.get(this) || defaultRect;
    });

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    const user2Row = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement | null;
    const user2Card = container?.querySelector(
      '[data-msg-id="user-2"] .user-message-card'
    ) as HTMLDivElement | null;
    const assistant2Row = container?.querySelector(
      '[data-msg-id="assistant-2"]'
    ) as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(user2Row).toBeInstanceOf(HTMLDivElement);
    expect(user2Card).toBeInstanceOf(HTMLDivElement);
    expect(assistant2Row).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1200 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));
    rectMap.set(user2Row!, new DOMRect(0, -90, 500, 52));
    rectMap.set(user2Card!, new DOMRect(120, -90, 320, 52));
    rectMap.set(assistant2Row!, new DOMRect(0, 40, 500, 320));

    list?.dispatchEvent(new Event('scroll'));
    await Promise.resolve();

    let sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky?.textContent).toContain('Prompt 2');
    expect(sticky).toBeInstanceOf(HTMLDivElement);

    rectMap.set(sticky!, new DOMRect(0, 10, 500, 50));

    rectMap.set(user2Card!, new DOMRect(120, 30, 320, 40));
    list!.scrollTop = 1210;
    list?.dispatchEvent(new Event('scroll'));
    await Promise.resolve();

    sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky).toBeNull();
  });
});

describe('MessageList loading row', () => {
  it('marks the loading row as stale after prolonged inactivity', async () => {
    vi.setSystemTime(0);
    setState('activeSessionId', 'session-1');
    startLoading(0);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeInstanceOf(HTMLDivElement);
    expect(container?.textContent).not.toContain('Session may be stale');

    vi.advanceTimersByTime(91_000);
    await Promise.resolve();

    expect(container?.textContent).toContain('Session may be stale');
    expect(container?.querySelector('.loading-action')).toBeInstanceOf(HTMLButtonElement);
  });

  it('shows the loading row while visible reasoning is streaming', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: assistantMessage('message-1'), parts: [reasoningPart('reason-1', 'Analyzing')] },
    ]);
    setState('streamingPartId', 'reason-1');
    setState('streamingText', 'Analyzing');
    startLoading(1);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeInstanceOf(HTMLDivElement);
  });

  it('shows the loading row while hidden reasoning is streaming', async () => {
    setState('activeSessionId', 'session-1');
    setShowThinkingPreference(false);
    replaceMessages([
      { info: assistantMessage('message-1'), parts: [reasoningPart('reason-1', 'Analyzing')] },
    ]);
    setState('streamingPartId', 'reason-1');
    setState('streamingText', 'Analyzing');
    startLoading(1);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeInstanceOf(HTMLDivElement);
  });

  it('hides the loading row while visible text is streaming', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: assistantMessage('message-1'), parts: [textPart('text-1', 'Drafting')] },
    ]);
    setState('streamingPartId', 'text-1');
    setState('streamingText', 'Drafting');
    startLoading(1);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeNull();
  });
});

describe('MessageList auto-scroll', () => {
  it('keeps the latest message fully visible when the last response grows', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, get: () => 1200 });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    Object.defineProperty(list!, 'scrollHeight', { configurable: true, get: () => 1700 });
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('text-2', 'Expanded response'), textPart('text-3', 'More content')],
      },
    ]);

    await Promise.resolve();
    await Promise.resolve();

    expect(scrollTopValue).toBe(1300);
  });
});
