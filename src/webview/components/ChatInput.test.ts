import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type * as UseOpenCodeModule from '../hooks/useOpenCode';
import type { ProviderLimitStatus } from '../../shared/protocol';
import type { Session } from '../types';
import {
  ChatInput,
  getActiveCompletion,
  getCompletionSelection,
  getMentionInsertionTrailingSpace,
  getLeadingSlashCommand,
  getMentionCompletionItems,
  parseDroppedText,
  getInlineInsertionSuffix,
  shouldRequestMentionFileSearch,
  shouldPadInlineInsertion,
  isToolbarControlCompacted,
  isToolbarControlHidden,
  getSlashCommands,
} from './ChatInput';
import {
  state,
  inputText,
  setIsLoading,
  setProviderLimitPollIntervalSeconds,
  setProviderLimitThresholdPercent,
  setShowModelPicker,
  setState,
  setInputText,
} from '../lib/state';
import { client } from '../lib/client';
import { __resetProviderLimitWindowSelectionsForTests } from '../lib/provider-limit-selection';

const {
  abortSessionMock,
  continueInterruptedSessionMock,
  redoSessionMock,
  undoSessionMock,
  runSlashCommandByNameMock,
  sendMessageMock,
} = vi.hoisted(() => ({
  abortSessionMock: vi.fn(async () => {}),
  continueInterruptedSessionMock: vi.fn(async () => {}),
  redoSessionMock: vi.fn(async () => {}),
  undoSessionMock: vi.fn(async () => {}),
  runSlashCommandByNameMock: vi.fn(async () => true),
  sendMessageMock: vi.fn(async () => {}),
}));

vi.mock('../hooks/useOpenCode', async () => {
  const actual = await vi.importActual<typeof UseOpenCodeModule>('../hooks/useOpenCode');
  return {
    ...actual,
    abortSession: abortSessionMock,
    continueInterruptedSession: continueInterruptedSessionMock,
    redoSession: redoSessionMock,
    undoSession: undoSessionMock,
    runSlashCommandByName: runSlashCommandByNameMock,
    sendMessage: sendMessageMock,
  };
});

vi.mock('../lib/client', () => ({
  client: {
    varro: {
      resolveWorkspacePath: vi.fn(async (path: string) => {
        if (path === 'README.md') {
          return { path: '/repo/README.md', relativePath: 'README.md', type: 'file' as const };
        }
        if (path === 'src/app.ts') {
          return { path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' as const };
        }
        if (path === 'docs') {
          return { path: '/repo/docs', relativePath: 'docs', type: 'directory' as const };
        }
        return null;
      }),
    },
  },
}));

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;

beforeEach(() => {
  __resetProviderLimitWindowSelectionsForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  globalThis.ResizeObserver = originalResizeObserver;
  setInputText('');
  setIsLoading(false);
  setProviderLimitPollIntervalSeconds(120);
  setProviderLimitThresholdPercent(40);
  setShowModelPicker(false);
  setState('activeSessionId', null);
  setState('messages', []);
  setState('sessions', []);
  setState('providers', []);
  setState('allAgents', []);
  setState('providerDefaults', {});
  setState('selectedModel', null);
  setState('providerLimits', {});
  setState('sessionStatus', {});
  setState('sessionUsageLimits', {});
  setState('clipboardImages', []);
  setState('droppedFiles', []);
  setState('terminalSelection', null);
  setState('queuedMessages', []);
  setState('hiddenProviders', []);
  setState('hiddenModels', []);
  __resetProviderLimitWindowSelectionsForTests();
  sendMessageMock.mockReset();
  runSlashCommandByNameMock.mockReset();
  runSlashCommandByNameMock.mockResolvedValue(true);
  abortSessionMock.mockReset();
  continueInterruptedSessionMock.mockReset();
  redoSessionMock.mockReset();
  undoSessionMock.mockReset();
  vi.mocked(client.varro.resolveWorkspacePath).mockClear();
});

function setupModelState() {
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
          limit: { context: 1000 },
        },
      },
    },
  ]);
  setState('providerDefaults', { openai: 'gpt-4o' });
  setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
}

function assistantMessageEntry(tokens: { input: number; output: number }) {
  return {
    info: {
      id: 'assistant-1',
      sessionID: 'session-1',
      role: 'assistant' as const,
      time: { created: 0 },
      parentID: 'user-1',
      modelID: 'gpt-4o',
      providerID: 'openai',
      mode: 'default',
      path: { cwd: '/repo', root: '/repo' },
      cost: 0,
      tokens: {
        input: tokens.input,
        output: tokens.output,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [],
  };
}

function session(id: string, updated: number, overrides: Partial<Session> = {}): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: id,
    version: '1',
    time: { created: updated - 1_000, updated },
    ...overrides,
  };
}

async function flushAsyncWork(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function setCollapsedSelection(target: Node, offset: number) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(target, offset);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function availableProviderLimit(
  overrides?: Partial<ProviderLimitStatus & { status: 'available' }>
) {
  return {
    providerID: 'openai',
    modelID: 'gpt-4o',
    status: 'available' as const,
    source: 'provider' as const,
    checkedAt: 1,
    windows: [
      {
        id: 'five_hour',
        label: '5-Hour Limit',
        unit: 'requests' as const,
        remaining: 39,
        limit: 100,
        resetAt: null,
      },
    ],
    ...overrides,
  };
}

describe('ChatInput', () => {
  it('renders while loading before the current model memo is initialized', () => {
    setInputText('Ask the sub-agent');
    setIsLoading(true);

    expect(() => {
      cleanup = render(() => ChatInput(), container!);
    }).not.toThrow();
  });

  it('hides provider-limit UI when polling is disabled', () => {
    setProviderLimitPollIntervalSeconds(-1);
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
        },
      },
    ]);
    setState('providerDefaults', { openai: 'gpt-4o' });
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    setState('providerLimits', {
      'openai:gpt-4o': {
        providerID: 'openai',
        modelID: 'gpt-4o',
        status: 'available',
        source: 'provider',
        checkedAt: 1,
        windows: [
          {
            id: 'daily',
            label: 'Daily',
            unit: 'requests',
            remaining: 12,
            limit: 50,
            resetAt: null,
          },
        ],
      },
    });

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.toolbar-limit-chip')).toBeNull();
  });

  it('hides provider-limit UI when no window crosses the threshold', () => {
    setProviderLimitThresholdPercent(40);
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
        },
      },
    ]);
    setState('providerDefaults', { openai: 'gpt-4o' });
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    setState('providerLimits', {
      'openai:gpt-4o': {
        providerID: 'openai',
        modelID: 'gpt-4o',
        status: 'available',
        source: 'provider',
        checkedAt: 1,
        windows: [
          {
            id: 'five_hour',
            label: '5-Hour Limit',
            unit: 'requests',
            remaining: 41,
            limit: 100,
            resetAt: null,
          },
          {
            id: 'month',
            label: 'Monthly Limit',
            unit: 'requests',
            remaining: 80,
            limit: 100,
            resetAt: null,
          },
        ],
      },
    });

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.toolbar-limit-chip')).toBeNull();
  });

  it('shows provider-limit UI when any window crosses the threshold', () => {
    setProviderLimitThresholdPercent(40);
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
        },
      },
    ]);
    setState('providerDefaults', { openai: 'gpt-4o' });
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    setState('providerLimits', {
      'openai:gpt-4o': {
        providerID: 'openai',
        modelID: 'gpt-4o',
        status: 'available',
        source: 'provider',
        checkedAt: 1,
        windows: [
          {
            id: 'five_hour',
            label: '5-Hour Limit',
            unit: 'requests',
            remaining: 39,
            limit: 100,
            resetAt: null,
          },
          {
            id: 'month',
            label: 'Monthly Limit',
            unit: 'requests',
            remaining: 80,
            limit: 100,
            resetAt: null,
          },
        ],
      },
    });

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.toolbar-limit-chip')).not.toBeNull();
  });

  it('shows provider-limit UI for a monthly-only Copilot-style limit', () => {
    setProviderLimitThresholdPercent(60);
    setState('providers', [
      {
        id: 'github-copilot',
        name: 'GitHub Copilot',
        source: 'api',
        models: {
          'gpt-5-mini': {
            id: 'gpt-5-mini',
            name: 'GPT-5 mini',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
          },
        },
      },
    ]);
    setState('providerDefaults', { 'github-copilot': 'gpt-5-mini' });
    setState('selectedModel', { providerID: 'github-copilot', modelID: 'gpt-5-mini' });
    setState('providerLimits', {
      'github-copilot:gpt-5-mini': {
        providerID: 'github-copilot',
        modelID: 'gpt-5-mini',
        status: 'available',
        source: 'provider',
        checkedAt: 1,
        windows: [
          {
            id: 'chat',
            label: 'Monthly Chat',
            unit: 'messages',
            remaining: 12,
            limit: 20,
            resetAt: null,
          },
        ],
      },
    });

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.toolbar-limit-chip')).not.toBeNull();
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('Limits:');
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('60%');
  });

  it('keeps the selected provider-limit window after limit refreshes', async () => {
    setProviderLimitThresholdPercent(40);
    setupModelState();
    setState('providerLimits', {
      'openai:gpt-4o': availableProviderLimit({
        checkedAt: 1,
        windows: [
          {
            id: 'five_hour',
            label: '5-Hour Limit',
            unit: 'requests',
            remaining: 39,
            limit: 100,
            resetAt: null,
          },
          {
            id: 'seven_day',
            label: 'Weekly All-Model',
            unit: 'requests',
            remaining: 30,
            limit: 100,
            resetAt: null,
          },
          {
            id: 'monthly_limit',
            label: 'Monthly Limit',
            unit: 'requests',
            remaining: 80,
            limit: 100,
            resetAt: null,
          },
        ],
      }),
    });

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('39%');
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('30%');
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('80%');

    setState('providerLimits', {
      'openai:gpt-4o': availableProviderLimit({
        checkedAt: 2,
        windows: [
          {
            id: 'five_hour',
            label: '5-Hour Limit',
            unit: 'requests',
            remaining: 39,
            limit: 100,
            resetAt: null,
          },
          {
            id: 'seven_day',
            label: 'Weekly All-Model',
            unit: 'requests',
            remaining: 30,
            limit: 100,
            resetAt: null,
          },
          {
            id: 'monthly_limit',
            label: 'Monthly Limit',
            unit: 'requests',
            remaining: 1,
            limit: 100,
            resetAt: null,
          },
        ],
      }),
    });
    await Promise.resolve();

    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('39%');
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('30%');
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('1%');
  });

  it('removes the context button title while the popup is open', async () => {
    setupModelState();
    setState('messages', [assistantMessageEntry({ input: 400, output: 100 })]);

    cleanup = render(() => ChatInput(), container!);

    const button = container?.querySelector<HTMLButtonElement>('.chat-context-usage');
    expect(button?.getAttribute('title')).toBe('Context usage (50%)');

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(container?.querySelector('.context-popup')).not.toBeNull();
    expect(button?.hasAttribute('title')).toBe(false);
    expect(button?.getAttribute('aria-label')).toBe('Context usage (50%)');
  });

  it('removes the provider limit title while the popup is open', async () => {
    setProviderLimitThresholdPercent(40);
    setupModelState();
    setState('providerLimits', {
      'openai:gpt-4o': availableProviderLimit(),
    });

    cleanup = render(() => ChatInput(), container!);

    const button = container?.querySelector<HTMLButtonElement>('.toolbar-limit-chip');
    expect(button?.getAttribute('title')).toContain('5-Hour Limit: 39 / 100 left');

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(container?.querySelector('.provider-limit-popup')).not.toBeNull();
    expect(button?.hasAttribute('title')).toBe(false);
    expect(button?.getAttribute('aria-label')).toContain('5-Hour Limit: 39 / 100 left');
  });

  it('renders permission, context usage, and provider limits in the lower metadata row', () => {
    setupModelState();
    setState('messages', [assistantMessageEntry({ input: 400, output: 100 })]);
    setState('providerLimits', {
      'openai:gpt-4o': availableProviderLimit(),
    });

    cleanup = render(() => ChatInput(), container!);

    const shell = container?.querySelector('.chat-input-shell');
    const frame = container?.querySelector('.chat-input-container');
    const mainRow = container?.querySelector('.toolbar-main');
    const metaRow = container?.querySelector('.toolbar-meta');

    expect(frame?.contains(mainRow ?? null)).toBe(true);
    expect(frame?.contains(metaRow ?? null)).toBe(false);
    expect(shell?.contains(metaRow ?? null)).toBe(true);
    expect(mainRow?.querySelector('.chat-context-usage')).toBeNull();
    expect(mainRow?.querySelector('.toolbar-limit-chip')).toBeNull();
    expect(
      mainRow?.querySelector<HTMLButtonElement>('.permission-mode-button')?.textContent
    ).toBeFalsy();
    expect(metaRow?.querySelector('.chat-context-usage')).not.toBeNull();
    expect(metaRow?.querySelector('.toolbar-limit-chip')).not.toBeNull();
    expect(
      metaRow?.querySelector<HTMLButtonElement>('.permission-mode-button')?.textContent
    ).toContain('Default');
    expect(metaRow?.querySelector('.context-anchor')).not.toBeNull();
    expect(metaRow?.querySelector('.provider-limit-anchor')).not.toBeNull();
  });

  it('right-aligns the provider limit popup when no context is shown', async () => {
    setProviderLimitThresholdPercent(40);
    setupModelState();
    setState('providerLimits', {
      'openai:gpt-4o': availableProviderLimit(),
    });

    cleanup = render(() => ChatInput(), container!);

    const button = container?.querySelector<HTMLButtonElement>('.toolbar-limit-chip');

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    const popup = container?.querySelector<HTMLElement>('.provider-limit-popup');

    expect(container?.querySelector('.context-anchor')).toBeNull();
    expect(popup).not.toBeNull();
    expect(popup?.style.right).toBe('0px');
  });

  it('right-aligns the provider limit popup when context is shown', async () => {
    setProviderLimitThresholdPercent(40);
    setupModelState();
    setState('messages', [assistantMessageEntry({ input: 400, output: 100 })]);
    setState('providerLimits', {
      'openai:gpt-4o': availableProviderLimit(),
    });

    cleanup = render(() => ChatInput(), container!);

    const button = container?.querySelector<HTMLButtonElement>('.toolbar-limit-chip');

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    const popup = container?.querySelector<HTMLElement>('.provider-limit-popup');

    expect(container?.querySelector('.context-anchor')).not.toBeNull();
    expect(popup).not.toBeNull();
    expect(popup?.style.right).toBe('0px');
  });

  it('aligns the permission popup to the input frame left edge', async () => {
    setupModelState();

    cleanup = render(() => ChatInput(), container!);

    const frame = container?.querySelector<HTMLElement>('.chat-input-container');
    const button = container?.querySelector<HTMLButtonElement>('.permission-mode-button');

    expect(frame).not.toBeNull();
    expect(button).not.toBeNull();
    expect(button?.style.position).toBe('');

    const frameLeft = 24;
    const buttonLeft = 60;
    vi.spyOn(frame!, 'getBoundingClientRect').mockReturnValue({
      x: frameLeft,
      y: 0,
      top: 0,
      left: frameLeft,
      right: 320,
      bottom: 100,
      width: 296,
      height: 100,
      toJSON: () => ({}),
    });
    vi.spyOn(button!, 'getBoundingClientRect').mockReturnValue({
      x: buttonLeft,
      y: 0,
      top: 0,
      left: buttonLeft,
      right: 120,
      bottom: 24,
      width: 60,
      height: 24,
      toJSON: () => ({}),
    });

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    const popup = container?.querySelector<HTMLElement>('.toolbar-popover');
    expect(popup?.style.left).toBe('24px');
  });

  it('raises the input shell above sticky overlays while the model picker is open', () => {
    setupModelState();
    setShowModelPicker(true);

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.chat-input-shell')?.className).toContain(
      'showing-floating-popover'
    );
    expect(container?.querySelector('.dropdown-menu')).not.toBeNull();
  });

  it('queues busy composer attachments and clears them from the input', () => {
    setInputText('Follow up with context');
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('droppedFiles', [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }]);
    setState('clipboardImages', [
      { id: 'img-1', url: 'blob:1', mime: 'image/png', filename: 'img-1.png', size: 10 },
    ]);
    setState('terminalSelection', { text: 'npm test', terminalName: 'zsh' });

    cleanup = render(() => ChatInput(), container!);

    const queueButton = container?.querySelector<HTMLButtonElement>(
      '[title="Add to queue (Enter)"]'
    );
    queueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(inputText()).toBe('');
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(container?.querySelector('.chat-queue-item')).not.toBeNull();
    expect(state.droppedFiles).toEqual([]);
    expect(state.clipboardImages).toEqual([]);
    expect(state.terminalSelection).toBeNull();
    expect(state.queuedMessages).toHaveLength(1);
    expect(state.queuedMessages[0]).toMatchObject({
      text: 'Follow up with context',
      droppedFiles: [
        {
          path: '/repo/src/a.ts',
          relativePath: 'src/a.ts',
          type: 'file',
          attachmentSequence: undefined,
        },
      ],
      clipboardImages: [
        {
          id: 'img-1',
          url: 'blob:1',
          mime: 'image/png',
          filename: 'img-1.png',
          size: 10,
          attachmentSequence: undefined,
        },
      ],
      terminalSelection: { text: 'npm test', terminalName: 'zsh' },
    });
  });

  it('shows an attachment badge in queued rows', () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      {
        id: 'q1',
        sessionId: 'session-1',
        text: 'Queued follow-up',
        droppedFiles: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }],
        clipboardImages: [
          { id: 'img-1', url: 'blob:1', mime: 'image/png', filename: 'img-1.png', size: 10 },
        ],
      },
    ]);

    cleanup = render(() => ChatInput(), container!);

    const meta = container?.querySelector('.chat-queue-meta');
    expect(meta?.textContent).toContain('2');
    expect(container?.querySelector('.chat-queue-attachment-icon')).not.toBeNull();
  });

  it('shows only the stop button while loading with nothing sendable', () => {
    setIsLoading(true);

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('[title="Stop"]')).not.toBeNull();
    expect(container?.querySelector('.stop-button .toolbar-picker-label')).toBeNull();
    expect(container?.textContent).not.toContain('Stop');
    expect(container?.querySelector('[title="Send (Enter)"]')).toBeNull();
    expect(container?.querySelector('[title="Add to queue (Enter)"]')).toBeNull();
  });

  it('shows send controls instead of stop while loading with sendable content', () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setInputText('Follow up');

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('[title="Stop"]')).toBeNull();
    expect(container?.querySelector('[title="Add to queue (Enter)"]')).not.toBeNull();
  });

  it('stops the active response before sending from the busy send menu', async () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setInputText('Follow up after stopping');

    cleanup = render(() => ChatInput(), container!);

    const menuButton = container?.querySelector<HTMLButtonElement>('[title="More send options"]');
    menuButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    const stopAndSendButton = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Stop and Send')
    );
    stopAndSendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith('Follow up after stopping', { noReply: false });
    expect(state.queuedMessages).toEqual([]);
  });

  it('runs a typed slash command with args on Enter', async () => {
    setState('commands', [
      {
        name: 'test',
        description: 'Run tests',
        template: 'Run tests',
      },
    ]);
    setInputText('/test --watch');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushAsyncWork();

    expect(runSlashCommandByNameMock).toHaveBeenCalledWith('test', '--watch');
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('runs a typed slash command with args from the send button', async () => {
    setState('commands', [
      {
        name: 'test',
        description: 'Run tests',
        template: 'Run tests',
      },
    ]);
    setInputText('/test --watch');

    cleanup = render(() => ChatInput(), container!);

    const sendButton = container?.querySelector<HTMLButtonElement>('[title="Send (Enter)"]');
    sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(runSlashCommandByNameMock).toHaveBeenCalledWith('test', '--watch');
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('runs the built-in undo slash command on Enter', async () => {
    setState('activeSessionId', 'session-1');
    setState('messages', [
      {
        info: {
          id: 'assistant-1',
          sessionID: 'session-1',
          role: 'assistant',
          time: { created: 0 },
          parentID: 'user-1',
          modelID: 'gpt-4o',
          providerID: 'openai',
          mode: 'default',
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [],
      },
    ]);
    setInputText('/undo');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushAsyncWork();

    expect(undoSessionMock).toHaveBeenCalledTimes(1);
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('sends slash-prefixed text on Enter when it is not a known slash command', async () => {
    setInputText("/not-a-real-command and /redo commands doesn't work");
    runSlashCommandByNameMock.mockResolvedValue(false);

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith(
      "/not-a-real-command and /redo commands doesn't work",
      {
        noReply: false,
      }
    );
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
  });

  it('runs the built-in undo slash command from the send button', async () => {
    setState('activeSessionId', 'session-1');
    setState('messages', [
      {
        info: {
          id: 'assistant-1',
          sessionID: 'session-1',
          role: 'assistant',
          time: { created: 0 },
          parentID: 'user-1',
          modelID: 'gpt-4o',
          providerID: 'openai',
          mode: 'default',
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [],
      },
    ]);
    setInputText('/undo');

    cleanup = render(() => ChatInput(), container!);

    const sendButton = container?.querySelector<HTMLButtonElement>('[title="Send (Enter)"]');
    sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(undoSessionMock).toHaveBeenCalledTimes(1);
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('runs undo from the send button even when the suggestion list omits it', async () => {
    setState('activeSessionId', 'session-1');
    setInputText('/undo');

    cleanup = render(() => ChatInput(), container!);

    const sendButton = container?.querySelector<HTMLButtonElement>('[title="Send (Enter)"]');
    sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(undoSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('runs redo from the send button even when the suggestion list omits it', async () => {
    setState('activeSessionId', 'session-1');
    setInputText('/redo');

    cleanup = render(() => ChatInput(), container!);

    const sendButton = container?.querySelector<HTMLButtonElement>('[title="Send (Enter)"]');
    sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(redoSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('uses a contenteditable rich composer instead of textarea', async () => {
    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    expect(editor).not.toBeNull();
    expect(editor?.getAttribute('contenteditable')).toBe('true');
    expect(editor?.getAttribute('role')).toBe('textbox');
  });

  it('rehydrates pasted file mentions into context files', async () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    expect(editor).not.toBeNull();

    editor?.focus();
    if (editor) setCollapsedSelection(editor, 0);

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) => (type === 'text/plain' ? 'Review @README.md and @docs/' : ''),
        items: [],
      },
    });

    editor?.dispatchEvent(event);
    await flushAsyncWork();

    expect(state.droppedFiles).toEqual([
      {
        path: '/repo/README.md',
        relativePath: 'README.md',
        type: 'file',
        attachmentSequence: expect.any(Number),
      },
      {
        path: '/repo/docs',
        relativePath: 'docs',
        type: 'directory',
        attachmentSequence: expect.any(Number),
      },
    ]);
    expect(inputText()).toBe('Review @README.md and @docs/');
    expect(client.varro.resolveWorkspacePath).toHaveBeenCalledWith('README.md');
    expect(client.varro.resolveWorkspacePath).toHaveBeenCalledWith('docs');
  });

  it('keeps unresolved scoped package names as plain pasted text', async () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    expect(editor).not.toBeNull();

    editor?.focus();
    if (editor) setCollapsedSelection(editor, 0);

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) => (type === 'text/plain' ? 'Use npx @scope/package init' : ''),
        items: [],
      },
    });

    editor?.dispatchEvent(event);
    await flushAsyncWork();

    expect(state.droppedFiles).toEqual([]);
    expect(inputText()).toBe('Use npx @scope/package init');
    expect(client.varro.resolveWorkspacePath).toHaveBeenCalledWith('scope/package');
  });

  it('strips pasted context reference lines while restoring them as attachments', async () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    expect(editor).not.toBeNull();

    editor?.focus();
    if (editor) setCollapsedSelection(editor, 0);

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) =>
          type === 'text/plain'
            ? 'Please review this\n\n[Selection from src/app.ts lines 3-5]\n[Active file: README.md]'
            : '',
        items: [],
      },
    });

    editor?.dispatchEvent(event);
    await flushAsyncWork();

    expect(state.droppedFiles).toEqual([
      {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        type: 'file',
        attachmentSequence: expect.any(Number),
        lineRanges: [{ startLine: 3, endLine: 5 }],
      },
      {
        path: '/repo/README.md',
        relativePath: 'README.md',
        type: 'file',
        attachmentSequence: expect.any(Number),
      },
    ]);
    expect(inputText()).toBe('Please review this');
  });

  it('renders inline image chips without a remove button', async () => {
    setState('clipboardImages', [
      {
        id: 'img-1',
        url: 'data:image/png;base64,abc',
        mime: 'image/png',
        filename: 'Image',
        size: 12,
      },
    ]);
    setInputText('[Image]');

    cleanup = render(() => ChatInput(), container!);
    await flushAsyncWork();

    expect(container?.querySelector('.rich-composer .inline-chip')).not.toBeNull();
    expect(container?.querySelector('.rich-composer .inline-chip-remove')).toBeNull();
  });

  it('updates the active Ralph run model and interrupts a usage-limit retry when switching models', async () => {
    const { ralphStore } = await import('../lib/stores/ralph-store');

    setState('activeSessionId', 'child-1');
    setState('sessions', [
      session('manager-1', 2_000),
      session('child-1', 2_100, { parentID: 'manager-1' }),
    ]);
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
            limit: { context: 1000 },
          },
        },
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'api',
        models: {
          claude: {
            id: 'claude',
            name: 'Claude',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
            limit: { context: 1000 },
          },
        },
      },
    ]);
    setState('providerDefaults', { openai: 'gpt-4o', anthropic: 'claude' });
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    setState('sessionStatus', {
      'child-1': { type: 'retry', attempt: 5, message: 'messages exhausted', next: 28 },
    });
    setState('sessionUsageLimits', {
      'child-1': {
        source: 'status',
        statusCode: 429,
        message: 'messages exhausted · retry in 28s · attempt #5',
        unit: 'messages',
        retryAt: 28_000,
        attempt: 5,
        sessionID: 'child-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
      },
    });
    ralphStore.startRun({
      managerSessionId: 'manager-1',
      planDocPath: 'RALPH.md',
      iterations: 5,
      promptTemplate: 'Prompt',
      permissionMode: 'full',
      model: { providerID: 'openai', modelID: 'gpt-4o' },
      agent: null,
      createdAt: 1,
    });
    ralphStore.upsertIteration('manager-1', {
      index: 1,
      childSessionId: 'child-1',
      status: 'running',
      startedAt: 1,
      endedAt: null,
      filesChanged: [],
      verification: {},
    });

    cleanup = render(() => ChatInput(), container!);

    const modelButton = container?.querySelector<HTMLButtonElement>('.model-picker-btn');
    modelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const claudeOption = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('.dropdown-item') || []
    ).find((button) => button.textContent?.includes('Claude'));
    claudeOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(state.selectedModel).toEqual({
      providerID: 'anthropic',
      modelID: 'claude',
      variant: undefined,
    });
    expect(ralphStore.getRun('manager-1')?.config.model).toEqual({
      providerID: 'anthropic',
      modelID: 'claude',
      variant: undefined,
    });
    expect(ralphStore.getRun('manager-1')?.status).toBe('paused');
    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(continueInterruptedSessionMock).toHaveBeenCalledWith('child-1');
    expect(state.sessionStatus['child-1']).toEqual({ type: 'idle' });
    expect(container?.textContent).not.toContain('Usage limit reached');
  });

  it('clears the active usage-limit banner when switching away from the limited provider', async () => {
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_100, { parentID: 'session-1' }),
    ]);
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
            limit: { context: 1000 },
          },
        },
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'api',
        models: {
          claude: {
            id: 'claude',
            name: 'Claude',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
            limit: { context: 1000 },
          },
        },
      },
    ]);
    setState('providerDefaults', { openai: 'gpt-4o', anthropic: 'claude' });
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    setState('sessionStatus', {
      'child-1': { type: 'retry', attempt: 9, message: 'messages exhausted', next: 408 },
    });
    setState('sessionUsageLimits', {
      'child-1': {
        source: 'status',
        statusCode: 429,
        message: 'messages exhausted · retry in 408s · attempt #9',
        unit: 'messages',
        retryAt: 408_000,
        attempt: 9,
        sessionID: 'child-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
      },
    });

    cleanup = render(() => ChatInput(), container!);

    expect(container?.textContent).toContain('Usage limit reached');

    const modelButton = container?.querySelector<HTMLButtonElement>('.model-picker-btn');
    modelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const claudeOption = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('.dropdown-item') || []
    ).find((button) => button.textContent?.includes('Claude'));
    claudeOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(state.selectedModel).toEqual({
      providerID: 'anthropic',
      modelID: 'claude',
      variant: undefined,
    });
    expect(container?.textContent).not.toContain('Usage limit reached');
    expect(abortSessionMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the usage-limit banner visible when a retry notice predates active-session model hydration', () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('sessions', [session('session-1', 2_000)]);
    setState('providers', [
      {
        id: 'copilot',
        name: 'GitHub Copilot',
        source: 'api',
        models: {
          'gpt-5-mini': {
            id: 'gpt-5-mini',
            name: 'GPT-5 mini',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
            limit: { context: 1000 },
          },
        },
      },
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-4.1': {
            id: 'gpt-4.1',
            name: 'GPT-4.1',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
            limit: { context: 1000 },
          },
        },
      },
    ]);
    setState('providerDefaults', { copilot: 'gpt-5-mini' });
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4.1' });
    setState('sessionStatus', {
      'session-1': {
        type: 'retry',
        attempt: 2,
        message: '429 usage limit reached. retry in 45s attempt #2',
        next: 45,
      },
    });
    setState('sessionUsageLimits', {
      'session-1': {
        source: 'status',
        statusCode: 429,
        message: '429 usage limit reached. retry in 45s attempt #2',
        unit: 'messages',
        retryAt: 45_000,
        attempt: 2,
        sessionID: 'session-1',
        providerID: 'copilot',
        modelID: 'gpt-5-mini',
      },
    });
    setState('messages', [
      {
        info: {
          id: 'assistant-usage-limit',
          sessionID: 'session-1',
          role: 'assistant',
          time: { created: 0, completed: 1 },
          parentID: 'user-1',
          modelID: 'gpt-4.1',
          providerID: 'openai',
          mode: 'default',
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          error: {
            name: 'rate_limit_exceeded',
            data: { message: '429 usage limit reached. retry in 45s attempt #2' },
          },
        },
        parts: [],
      },
    ]);

    cleanup = render(() => ChatInput(), container!);

    expect(container?.textContent).toContain('Usage limit reached');
    expect(container?.textContent).toContain('Stop retrying');
    expect(container?.textContent).toContain('Switch provider');
  });
});

describe('isToolbarControlCompacted', () => {
  it('removes the stop label before compacting other toolbar controls', () => {
    expect(isToolbarControlCompacted('full', 'agent')).toBe(false);
    expect(isToolbarControlCompacted('full', 'reasoning')).toBe(false);
    expect(isToolbarControlCompacted('full', 'stop')).toBe(false);

    expect(isToolbarControlCompacted('compact-provider-limit', 'agent')).toBe(false);
    expect(isToolbarControlCompacted('compact-provider-limit', 'reasoning')).toBe(false);
    expect(isToolbarControlCompacted('compact-provider-limit', 'stop')).toBe(true);

    expect(isToolbarControlCompacted('compact-stop', 'stop')).toBe(true);
    expect(isToolbarControlCompacted('compact-stop', 'agent')).toBe(false);
    expect(isToolbarControlCompacted('compact-stop', 'reasoning')).toBe(false);

    expect(isToolbarControlCompacted('compact-agent', 'agent')).toBe(true);
    expect(isToolbarControlCompacted('compact-agent', 'reasoning')).toBe(false);
    expect(isToolbarControlCompacted('compact-agent', 'stop')).toBe(true);

    expect(isToolbarControlCompacted('compact-reasoning', 'agent')).toBe(true);
    expect(isToolbarControlCompacted('compact-reasoning', 'reasoning')).toBe(true);
    expect(isToolbarControlCompacted('compact-reasoning', 'stop')).toBe(true);

    expect(isToolbarControlCompacted('truncate-model', 'agent')).toBe(true);
    expect(isToolbarControlCompacted('truncate-model', 'reasoning')).toBe(true);
    expect(isToolbarControlCompacted('truncate-model', 'stop')).toBe(true);
  });
});

describe('isToolbarControlHidden', () => {
  it('does not hide controls during label compaction or model truncation', () => {
    expect(isToolbarControlHidden('compact-provider-limit', 'permission')).toBe(false);
    expect(isToolbarControlHidden('compact-agent', 'permission')).toBe(false);
    expect(isToolbarControlHidden('compact-reasoning', 'permission')).toBe(false);
    expect(isToolbarControlHidden('truncate-model', 'permission')).toBe(false);
    expect(isToolbarControlHidden('compact-provider-limit', 'send')).toBe(false);
    expect(isToolbarControlHidden('compact-stop', 'permission')).toBe(false);
    expect(isToolbarControlHidden('compact-stop', 'send')).toBe(false);
  });

  it('hides controls in the requested order as the toolbar gets tighter', () => {
    expect(isToolbarControlHidden('full', 'permission')).toBe(false);

    expect(isToolbarControlHidden('hide-permission', 'permission')).toBe(true);
    expect(isToolbarControlHidden('hide-permission', 'attachments')).toBe(false);

    expect(isToolbarControlHidden('hide-attachments', 'attachments')).toBe(true);
    expect(isToolbarControlHidden('hide-attachments', 'send')).toBe(false);

    expect(isToolbarControlHidden('compact-stop', 'send')).toBe(false);
    expect(isToolbarControlHidden('compact-stop', 'stop')).toBe(false);

    expect(isToolbarControlHidden('hide-send', 'send')).toBe(true);
    expect(isToolbarControlHidden('hide-send', 'reasoning')).toBe(false);

    expect(isToolbarControlHidden('hide-reasoning', 'reasoning')).toBe(true);
    expect(isToolbarControlHidden('hide-reasoning', 'agent')).toBe(false);

    expect(isToolbarControlHidden('hide-agent', 'agent')).toBe(true);
    expect(isToolbarControlHidden('hide-agent', 'stop')).toBe(false);

    expect(isToolbarControlHidden('hide-stop', 'stop')).toBe(true);
    expect(isToolbarControlHidden('hide-stop', 'context')).toBe(false);

    expect(isToolbarControlHidden('hide-context', 'context')).toBe(true);
  });

  it('keeps the full hide set in tight mode', () => {
    expect(isToolbarControlHidden('tight', 'permission')).toBe(true);
    expect(isToolbarControlHidden('tight', 'attachments')).toBe(true);
    expect(isToolbarControlHidden('tight', 'send')).toBe(true);
    expect(isToolbarControlHidden('tight', 'reasoning')).toBe(true);
    expect(isToolbarControlHidden('tight', 'agent')).toBe(true);
    expect(isToolbarControlHidden('tight', 'stop')).toBe(true);
    expect(isToolbarControlHidden('tight', 'context')).toBe(true);
  });
});

describe('getMentionCompletionItems', () => {
  const agents = [
    {
      name: 'helper',
      description: 'Helpful agent',
      mode: 'all',
      permission: {
        edit: 'allow',
        bash: { '*': 'allow' },
      },
    },
  ];

  const files = [
    {
      path: '/workspace/README.md',
      relativePath: 'README.md',
      type: 'file' as const,
    },
  ];

  it('shows file results for bare filename queries', () => {
    const completions = getMentionCompletionItems({
      rawQuery: 'readme',
      agents,
      files,
    });

    expect(completions.some((item) => item.type === 'file' && item.label === '@README.md')).toBe(
      true
    );
  });

  it('terminates file mentions after selection', () => {
    const completions = getMentionCompletionItems({
      rawQuery: 'readme',
      agents,
      files,
    });

    const fileItem = completions.find(
      (item): item is Extract<(typeof completions)[number], { type: 'file' }> =>
        item.type === 'file'
    );

    expect(fileItem?.value).toBe('@README.md ');
  });

  it('shows file results for empty @ queries', () => {
    const completions = getMentionCompletionItems({
      rawQuery: '',
      agents,
      files,
      meta: { showFileSearchHint: true },
    });

    expect(completions.some((item) => item.type === 'agent' && item.label === '@helper')).toBe(
      true
    );
    expect(completions.some((item) => item.type === 'file')).toBe(false);
  });

  it('suppresses suggestions for exact agent and file matches', () => {
    expect(
      getMentionCompletionItems({
        rawQuery: 'helper',
        agents,
        files,
      })
    ).toEqual([]);

    expect(
      getMentionCompletionItems({
        rawQuery: 'README.md',
        agents,
        files,
      })
    ).toEqual([]);
  });

  it('formats directory mentions with a trailing slash', () => {
    const completions = getMentionCompletionItems({
      rawQuery: 'do',
      agents,
      files: [
        {
          path: '/workspace/docs',
          relativePath: 'docs',
          type: 'directory' as const,
        },
      ],
    });

    expect(completions).toContainEqual(
      expect.objectContaining({
        type: 'file',
        label: '@docs',
        detail: 'Folder',
        value: '@docs/',
      })
    );
  });
});

describe('shouldRequestMentionFileSearch', () => {
  it('skips duplicate mention file searches when the query text is unchanged', () => {
    expect(shouldRequestMentionFileSearch('readme', 'readme')).toBe(false);
    expect(shouldRequestMentionFileSearch('readme', 'read')).toBe(true);
    expect(shouldRequestMentionFileSearch('', 'readme')).toBe(true);
  });
});

describe('getActiveCompletion', () => {
  it('detects slash commands only at the start of the input', () => {
    expect(getActiveCompletion('/rev', 4)).toEqual({
      type: 'slash',
      query: 'rev',
      start: 0,
      end: 4,
    });
    expect(getActiveCompletion('/skills ', 8)).toEqual({
      type: 'slash',
      query: 'skills ',
      start: 0,
      end: 8,
    });
    expect(getActiveCompletion('/skills browser', 15)).toEqual({
      type: 'slash',
      query: 'skills browser',
      start: 0,
      end: 15,
    });
    expect(getActiveCompletion('prefix /rev', 11)).toBeNull();
  });

  it('detects mention completions for the active token', () => {
    expect(getActiveCompletion('review @hel', 11)).toEqual({
      type: 'mention',
      query: 'hel',
      start: 7,
      end: 11,
    });
    expect(getActiveCompletion('review test', 11)).toBeNull();
  });

  it('rejects cursor positions outside the input bounds', () => {
    expect(getActiveCompletion('abc', -1)).toBeNull();
    expect(getActiveCompletion('abc', 4)).toBeNull();
  });
});

describe('getLeadingSlashCommand', () => {
  it('parses a leading slash command with optional arguments', () => {
    expect(getLeadingSlashCommand('/test')).toEqual({ name: 'test', args: '' });
    expect(getLeadingSlashCommand('/test --watch')).toEqual({ name: 'test', args: '--watch' });
    expect(getLeadingSlashCommand('  /review branch  ')).toEqual({
      name: 'review',
      args: 'branch',
    });
  });

  it('rejects slash commands that are not the whole trimmed input', () => {
    expect(getLeadingSlashCommand('prefix /test')).toBeNull();
    expect(getLeadingSlashCommand('')).toBeNull();
  });
});

describe('getCompletionSelection', () => {
  it('confirms slash selections by invoking the command path', () => {
    expect(
      getCompletionSelection(
        { type: 'slash', query: 'in', start: 0, end: 3 },
        {
          key: 'slash:init',
          type: 'slash',
          name: 'init',
          aliases: [],
          description: 'Analyze the project and create AGENTS.md',
          action: () => {},
        },
        true
      )
    ).toEqual({ type: 'run-slash', value: '/init' });
  });

  it('keeps tab-style slash selections as composer text updates', () => {
    expect(
      getCompletionSelection(
        { type: 'slash', query: 'in', start: 0, end: 3 },
        {
          key: 'slash:init',
          type: 'slash',
          name: 'init',
          aliases: [],
          description: 'Analyze the project and create AGENTS.md',
          action: () => {},
        }
      )
    ).toEqual({ type: 'set-slash', value: '/init' });
  });

  it('keeps selecting /skills as a composer text update', () => {
    expect(
      getCompletionSelection(
        { type: 'slash', query: 'sk', start: 0, end: 3 },
        {
          key: 'slash:skills',
          type: 'slash',
          name: 'skills',
          aliases: [],
          description: 'Browse available skills',
          action: () => {},
        },
        true
      )
    ).toEqual({ type: 'set-slash', value: '/skills ' });
  });

  it('keeps selecting a skill entry as a composer text update', () => {
    expect(
      getCompletionSelection(
        { type: 'slash', query: 'skills bro', start: 0, end: 11 },
        {
          key: 'skill:browser-bridge',
          type: 'slash',
          name: 'browser-bridge',
          aliases: [],
          description: 'Token-efficient Chrome tab inspection',
          action: () => {},
        },
        true
      )
    ).toEqual({ type: 'set-slash', value: '/browser-bridge' });
  });

  it('returns mention selections with attached file metadata', () => {
    const file = {
      path: '/workspace/README.md',
      relativePath: 'README.md',
      type: 'file' as const,
    };

    expect(
      getCompletionSelection(
        { type: 'mention', query: 'read', start: 0, end: 5 },
        {
          key: 'file:/workspace/README.md',
          type: 'file',
          label: '@README.md',
          detail: 'File',
          value: '@README.md ',
          file,
        },
        true
      )
    ).toEqual({ type: 'apply-mention', value: '@README.md ', file });
  });
});

describe('getSlashCommands', () => {
  it('includes init for blank sessions alongside built-ins and custom commands', () => {
    const commands = getSlashCommands({
      isBusy: false,
      canUndo: true,
      canRedo: true,
      canInit: true,
      onConnectProvider: () => {},
      onOpenSessions: () => {},
      onOpenModels: () => {},
      onOpenMcps: () => {},
      onOpenFiles: () => {},
      onOpenSettings: () => {},
      onExportSession: () => {},
      customCommands: [
        {
          name: 'test',
          description: 'Run tests',
          template: 'Run tests',
        },
        {
          name: 'settings',
          description: 'Override built-in',
          template: 'ignored',
        },
      ],
    });

    expect(commands.map((command) => command.name)).toEqual([
      'attach',
      'compact',
      'connect',
      'export',
      'init',
      'mcps',
      'models',
      'new',
      'ralph',
      'review',
      'sessions',
      'settings',
      'skills',
      'test',
      'thinking',
    ]);
    expect(commands.some((command) => command.name === 'init')).toBe(true);
    expect(commands.some((command) => command.name === 'export')).toBe(true);
    expect(commands.some((command) => command.name === 'redo')).toBe(false);
    expect(commands.some((command) => command.name === 'skills')).toBe(true);
    expect(commands.some((command) => command.name === 'test')).toBe(true);
    expect(commands.some((command) => command.name === 'undo')).toBe(false);
    expect(commands.filter((command) => command.name === 'settings')).toHaveLength(1);
  });

  it('hides init outside blank sessions', () => {
    const commands = getSlashCommands({
      isBusy: false,
      canUndo: false,
      canRedo: false,
      canInit: false,
      onConnectProvider: () => {},
      onOpenSessions: () => {},
      onOpenModels: () => {},
      onOpenMcps: () => {},
      onOpenFiles: () => {},
      onOpenSettings: () => {},
      onExportSession: () => {},
      customCommands: [],
    });

    expect(commands.some((command) => command.name === 'init')).toBe(false);
  });

  it('keeps reserved built-ins hidden when a custom command reuses the name', () => {
    const commands = getSlashCommands({
      isBusy: false,
      canUndo: false,
      canRedo: false,
      canInit: false,
      onConnectProvider: () => {},
      onOpenSessions: () => {},
      onOpenModels: () => {},
      onOpenMcps: () => {},
      onOpenFiles: () => {},
      onOpenSettings: () => {},
      onExportSession: () => {},
      customCommands: [
        {
          name: 'init',
          description: 'Should stay hidden',
          template: 'ignored',
        },
      ],
    });

    expect(commands.some((command) => command.name === 'init')).toBe(false);
  });
});

describe('parseDroppedText', () => {
  it('parses absolute, relative, and uri-list entries while dropping comments and duplicates', () => {
    expect(
      parseDroppedText(
        [
          '# comment',
          'file:///tmp/demo.ts',
          './src/app.ts',
          './src/app.ts',
          '/Users/andrew/Projects/GitHub/varro/README.md',
        ].join('\n')
      )
    ).toEqual(['/tmp/demo.ts', 'src/app.ts', '/Users/andrew/Projects/GitHub/varro/README.md']);
  });

  it('extracts paths from structured vscode drag payloads', () => {
    expect(
      parseDroppedText(
        JSON.stringify({
          resource: 'file:///tmp/from-resource.ts',
          nested: ['src/test.ts', { path: '../docs/guide.md' }],
          ignored: 'not a plain sentence with spaces',
        })
      )
    ).toEqual(['/tmp/from-resource.ts', 'src/test.ts', '../docs/guide.md']);
  });
});

describe('shouldPadInlineInsertion', () => {
  it('pads only when adjacent content is non-whitespace', () => {
    expect(shouldPadInlineInsertion('a')).toBe(true);
    expect(shouldPadInlineInsertion('/')).toBe(true);
    expect(shouldPadInlineInsertion(' ')).toBe(false);
    expect(shouldPadInlineInsertion('\n')).toBe(false);
    expect(shouldPadInlineInsertion(undefined)).toBe(false);
  });

  it('treats end-of-input as requiring a trailing separator for inline insertions', () => {
    expect(getInlineInsertionSuffix('Look at this', 'Look at this'.length)).toBe(' ');
    expect(getInlineInsertionSuffix('Look at this?', 12)).toBe(' ');
    expect(getInlineInsertionSuffix('Look at this ', 'Look at this'.length)).toBe('');
  });
});

describe('getMentionInsertionTrailingSpace', () => {
  it('does not add a second trailing space when the mention value already has one', () => {
    expect(getMentionInsertionTrailingSpace('@helper ', undefined)).toBe('');
    expect(getMentionInsertionTrailingSpace('@README.md ', 'x')).toBe('');
  });

  it('adds a trailing space only when the mention is adjacent to non-whitespace', () => {
    expect(getMentionInsertionTrailingSpace('@helper', undefined)).toBe(' ');
    expect(getMentionInsertionTrailingSpace('@helper', 'x')).toBe(' ');
    expect(getMentionInsertionTrailingSpace('@helper', ' ')).toBe('');
    expect(getMentionInsertionTrailingSpace('@helper', '\n')).toBe('');
  });
});
