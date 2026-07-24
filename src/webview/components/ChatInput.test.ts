import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import type * as UseOpenCodeModule from '../hooks/useOpenCode';
import type { ProviderLimitStatus, WebviewMessage } from '../../shared/protocol';
import type { Session, TextPart, UserMessage } from '../types';
import { ChatInput, sendDroppedContent } from './ChatInput';
import {
  state,
  inputText,
  setConnectionInitialized,
  setIsLoading,
  setProviderLimitPollIntervalSeconds,
  setProviderLimitThresholdPercent,
  setShowModelPicker,
  setState,
  setInputText,
  addContextFile,
  removeContextFile,
} from '../lib/state';
import { client } from '../lib/client';
import { resetMessageEditState, startEditingMessage } from '../lib/message-edit-state';
import { setSessionHistoryPrompts } from '../lib/message-window';

const {
  abortSessionMock,
  continueInterruptedSessionMock,
  forkSessionMock,
  loadOlderSessionPromptsMock,
  redoSessionMock,
  undoSessionMock,
  runSlashCommandByNameMock,
  sendMessageMock,
  serverEventHandlers,
  serverEventsOnMock,
} = vi.hoisted(() => ({
  abortSessionMock: vi.fn(async () => {}),
  continueInterruptedSessionMock: vi.fn(async () => {}),
  forkSessionMock: vi.fn(async () => 'forked-session'),
  loadOlderSessionPromptsMock: vi.fn(async () => false),
  redoSessionMock: vi.fn(async () => {}),
  undoSessionMock: vi.fn(async () => {}),
  runSlashCommandByNameMock: vi.fn(async () => true),
  sendMessageMock: vi.fn(async () => true),
  serverEventHandlers: new Map<
    string,
    Set<(event: { type: string; properties?: Record<string, unknown> }) => void>
  >(),
  serverEventsOnMock: vi.fn(
    (
      type: string,
      handler: (event: { type: string; properties?: Record<string, unknown> }) => void
    ) => {
      if (!serverEventHandlers.has(type)) serverEventHandlers.set(type, new Set());
      serverEventHandlers.get(type)!.add(handler);
      return () => serverEventHandlers.get(type)?.delete(handler);
    }
  ),
}));

vi.mock('../hooks/useOpenCode', async () => {
  const actual = await vi.importActual<typeof UseOpenCodeModule>('../hooks/useOpenCode');
  return {
    ...actual,
    abortSession: abortSessionMock,
    continueInterruptedSession: continueInterruptedSessionMock,
    forkSession: forkSessionMock,
    loadOlderSessionPrompts: loadOlderSessionPromptsMock,
    redoSession: redoSessionMock,
    undoSession: undoSessionMock,
    runSlashCommandByName: runSlashCommandByNameMock,
    sendMessage: sendMessageMock,
  };
});

vi.mock('../lib/client', () => ({
  client: {
    varro: {
      session: {
        diffSummary: vi.fn(async () => ({
          files: 0,
          additions: 0,
          deletions: 0,
          tokens: 0,
          durationMs: 0,
          activeStartedAt: null,
        })),
      },
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
  serverEvents: {
    on: serverEventsOnMock,
  },
}));

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
  setConnectionInitialized(true);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  globalThis.ResizeObserver = originalResizeObserver;
  setInputText('');
  setConnectionInitialized(false);
  setIsLoading(false);
  setProviderLimitPollIntervalSeconds(120);
  setProviderLimitThresholdPercent(40);
  setShowModelPicker(false);
  setState('activeSessionId', null);
  setState('messages', []);
  setState('sessions', []);
  setState('providers', []);
  setState('agents', []);
  setState('allAgents', []);
  setState('providerDefaults', {});
  setState('selectedModel', null);
  setState('modelVariantSelections', {});
  setState('providerLimits', {});
  setState('mcpStatus', {});
  setState('sessionStatus', reconcile({}));
  setState('sessionUsageLimits', {});
  setState('clipboardImages', []);
  setState('droppedFiles', []);
  setState('terminalSelection', null);
  setState('editorContext', {
    workspacePath: null,
    activeFile: null,
    selection: null,
    diagnostics: [],
  });
  setState('queuedMessages', []);
  setState('queuedMessageDispatchingId', null);
  setState('failedQueuedMessageIds', []);
  setState('queuedMessageEdit', null);
  setState('hiddenProviders', []);
  setState('hiddenModels', []);
  setSessionHistoryPrompts('session-1', []);
  resetMessageEditState();
  sendMessageMock.mockReset();
  loadOlderSessionPromptsMock.mockReset();
  loadOlderSessionPromptsMock.mockResolvedValue(false);
  serverEventHandlers.clear();
  serverEventsOnMock.mockClear();
  runSlashCommandByNameMock.mockReset();
  runSlashCommandByNameMock.mockResolvedValue(true);
  abortSessionMock.mockReset();
  continueInterruptedSessionMock.mockReset();
  forkSessionMock.mockReset();
  forkSessionMock.mockResolvedValue('forked-session');
  redoSessionMock.mockReset();
  undoSessionMock.mockReset();
  vi.mocked(client.varro.session.diffSummary).mockReset();
  vi.mocked(client.varro.session.diffSummary).mockResolvedValue({
    files: 0,
    additions: 0,
    deletions: 0,
    tokens: 0,
    durationMs: 0,
    activeStartedAt: null,
  });
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

function readContextRows(section: Element | undefined) {
  return Object.fromEntries(
    [...(section?.nextElementSibling?.querySelectorAll('.context-popup-row') || [])].map((row) => [
      row.querySelector('.context-popup-row-label')?.textContent,
      row.querySelector('.context-popup-row-value')?.textContent,
    ])
  );
}

async function flushAsyncWork(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function createDragDataTransfer() {
  const values = new Map<string, string>();
  const types: string[] = [];
  return {
    types,
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    setData(type: string, value: string) {
      values.set(type, value);
      if (!types.includes(type)) types.push(type);
    },
    getData(type: string) {
      return values.get(type) ?? '';
    },
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
}

function dispatchDragEvent(target: Element, type: string, dataTransfer: DataTransfer) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  target.dispatchEvent(event);
  return event;
}

function emitServerEvent(type: string, properties: Record<string, unknown>) {
  for (const handler of serverEventHandlers.get(type) ?? []) {
    handler({ type, properties });
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
  it('sends at most 20 dropped content files in individual messages', async () => {
    const originalFileReader = globalThis.FileReader;
    const bridgeWindow = window as typeof window & {
      __sendToExtension?: (message: WebviewMessage) => void;
    };
    const originalSend = bridgeWindow.__sendToExtension;
    const readFiles: File[] = [];
    const sent: WebviewMessage[] = [];

    class MockFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      private loadListener: (() => void) | undefined;

      addEventListener(type: string, listener: () => void) {
        if (type === 'load') this.loadListener = listener;
      }

      readAsDataURL(file: File) {
        readFiles.push(file);
        this.result = 'data:application/octet-stream;base64,';
        this.loadListener?.();
      }
    }

    globalThis.FileReader = MockFileReader as unknown as typeof FileReader;
    bridgeWindow.__sendToExtension = (message) => sent.push(message);
    try {
      const files = Array.from({ length: 21 }, (_, index) => ({
        name: `file-${index}.txt`,
        size: 0,
      })) as File[];

      await sendDroppedContent(files);

      expect(readFiles).toHaveLength(20);
      expect(sent).toHaveLength(20);
      expect(
        sent.every(
          (message) => message.type === 'files/drop-content' && message.payload.files.length === 1
        )
      ).toBe(true);
    } finally {
      globalThis.FileReader = originalFileReader;
      if (originalSend) bridgeWindow.__sendToExtension = originalSend;
      else delete bridgeWindow.__sendToExtension;
    }
  });

  it('rejects per-file and aggregate dropped content limits before FileReader work', async () => {
    const originalFileReader = globalThis.FileReader;
    const bridgeWindow = window as typeof window & {
      __sendToExtension?: (message: WebviewMessage) => void;
    };
    const originalSend = bridgeWindow.__sendToExtension;
    const readFiles: File[] = [];
    const sent: WebviewMessage[] = [];

    class MockFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      private loadListener: (() => void) | undefined;

      addEventListener(type: string, listener: () => void) {
        if (type === 'load') this.loadListener = listener;
      }

      readAsDataURL(file: File) {
        readFiles.push(file);
        this.result = 'data:application/octet-stream;base64,QQ==';
        this.loadListener?.();
      }
    }

    globalThis.FileReader = MockFileReader as unknown as typeof FileReader;
    bridgeWindow.__sendToExtension = (message) => sent.push(message);
    try {
      const tenMiB = 10 * 1024 * 1024;
      const files = [
        { name: 'oversized.bin', size: tenMiB + 1 },
        ...Array.from({ length: 6 }, (_, index) => ({
          name: `part-${index}.bin`,
          size: tenMiB,
        })),
      ] as File[];

      await sendDroppedContent(files);

      expect(readFiles.map((file) => file.name)).toEqual([
        'part-0.bin',
        'part-1.bin',
        'part-2.bin',
        'part-3.bin',
        'part-4.bin',
      ]);
      expect(sent).toHaveLength(5);
    } finally {
      globalThis.FileReader = originalFileReader;
      if (originalSend) bridgeWindow.__sendToExtension = originalSend;
      else delete bridgeWindow.__sendToExtension;
    }
  });

  it('renders while loading before the current model memo is initialized', () => {
    setInputText('Ask the sub-agent');
    setIsLoading(true);

    expect(() => {
      cleanup = render(() => ChatInput(), container!);
    }).not.toThrow();
  });

  it('uses the busy placeholder while a child session is still working', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Root session',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Research child',
        version: '1',
        parentID: 'session-1',
        time: { created: 1, updated: 11 },
      },
    ] satisfies Session[]);
    setState('sessionStatus', {
      'session-1': { type: 'idle' },
      'child-1': { type: 'busy' },
    });

    cleanup = render(() => ChatInput(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.rich-composer')?.getAttribute('data-placeholder')).toBe(
      'Queue a follow-up or steer'
    );

    setState('sessionStatus', {
      'session-1': { type: 'idle' },
      'child-1': { type: 'idle' },
    });
    await Promise.resolve();

    expect(container?.querySelector('.rich-composer')?.getAttribute('data-placeholder')).toBe(
      'Queue a follow-up or steer'
    );

    await vi.advanceTimersByTimeAsync(700);
    await Promise.resolve();

    expect(container?.querySelector('.rich-composer')?.getAttribute('data-placeholder')).toBe(
      'Describe what to build'
    );
  });

  it('shows the connected MCP count and toggles the MCP picker or closes it outside', () => {
    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.toolbar-mcp-count')).toBeNull();

    setState('mcpStatus', {
      alpha: { status: 'connected' },
      beta: { status: 'disabled' },
      gamma: { status: 'connected' },
      delta: { status: 'failed' },
    });

    const mcpCount = container?.querySelector<HTMLButtonElement>('.toolbar-mcp-count');
    expect(mcpCount?.textContent).toContain('MCPs:');
    expect(mcpCount?.textContent).toContain('2');

    mcpCount?.click();

    expect(container?.querySelector('.dropdown-menu')?.textContent).toContain('alpha');
    expect(container?.querySelector('.dropdown-menu')?.textContent).toContain('gamma');

    mcpCount?.click();
    expect(container?.querySelector('.dropdown-menu')).toBeNull();

    mcpCount?.click();
    expect(container?.querySelector('.dropdown-menu')).not.toBeNull();

    document.body.click();
    expect(container?.querySelector('.dropdown-menu')).toBeNull();
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
    setState('activeSessionId', 'session-1');
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

  it('includes descendant session snapshots in the session token total', async () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_000, {
        parentID: 'session-1',
        tokens: {
          input: 500,
          output: 100,
          reasoning: 0,
          cache: { read: 50, write: 0 },
        },
      }),
    ]);
    setState('messages', [assistantMessageEntry({ input: 400, output: 100 })]);

    cleanup = render(() => ChatInput(), container!);
    container
      ?.querySelector<HTMLButtonElement>('.chat-context-usage')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const sections = [...(container?.querySelectorAll('.context-popup-section') || [])];
    expect(sections.map((section) => section.textContent)).toEqual([
      'Session Tokens',
      'Agents (1)650',
    ]);
    expect(readContextRows(sections[0])).toMatchObject({
      Input: '400',
      Output: '100',
      Total: '500',
    });
    const subagentToggle = sections[1] as HTMLButtonElement;
    expect(subagentToggle.getAttribute('aria-expanded')).toBe('false');
    expect(subagentToggle.children[1]?.classList.contains('context-popup-section-chevron')).toBe(
      true
    );
    expect(container?.querySelector('.context-popup-subagent-rows')).toBeNull();

    subagentToggle.click();
    await Promise.resolve();

    expect(subagentToggle.getAttribute('aria-expanded')).toBe('true');
    expect(subagentToggle.querySelector('.context-popup-section-summary')).toBeNull();
    expect(readContextRows(sections[1])).toMatchObject({
      Input: '500',
      Output: '100',
      'Cache read': '50',
      Total: '650',
    });
    expect(container?.querySelector('.context-popup-overall-total')?.textContent).toContain(
      'Overall1,150'
    );
  });

  it('uses the root session snapshot when older messages are not loaded', async () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session('session-1', 2_000, {
        tokens: {
          input: 1_000,
          output: 200,
          reasoning: 50,
          cache: { read: 100, write: 25 },
        },
      }),
    ]);
    setState('messages', [assistantMessageEntry({ input: 400, output: 100 })]);

    cleanup = render(() => ChatInput(), container!);
    container
      ?.querySelector<HTMLButtonElement>('.chat-context-usage')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const sessionSection = container?.querySelector('.context-popup-section');
    expect(readContextRows(sessionSection ?? undefined)).toEqual({
      Input: '1,000',
      Output: '200',
      Reasoning: '50',
      'Cache read': '100',
      'Cache write': '25',
      Total: '1,375',
    });
  });

  it('loads tokens for subagent sessions whose messages and snapshots are not loaded', async () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_000, { parentID: 'session-1' }),
    ]);
    setState('messages', [assistantMessageEntry({ input: 400, output: 100 })]);
    vi.mocked(client.varro.session.diffSummary).mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 1_400,
      tokenBreakdown: {
        session: {
          total: 500,
          input: 400,
          output: 100,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        subagents: {
          total: 900,
          input: 700,
          output: 100,
          reasoning: 50,
          cacheRead: 50,
          cacheWrite: 0,
        },
        subagentCount: 1,
      },
      durationMs: 0,
      activeStartedAt: null,
    });

    cleanup = render(() => ChatInput(), container!);
    container
      ?.querySelector<HTMLButtonElement>('.chat-context-usage')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => {
      expect(container?.querySelector('.context-popup-section-toggle')?.textContent).toContain(
        'Agents (1)900'
      );
    });
    expect(client.varro.session.diffSummary).toHaveBeenCalledWith('session-1');
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

    const popup = container?.querySelector('.provider-limit-popup');

    expect(popup).not.toBeNull();
    expect(popup?.textContent).toContain('OpenAI');
    expect(popup?.textContent).not.toContain('GPT-4o');
    expect(button?.hasAttribute('title')).toBe(false);
    expect(button?.getAttribute('aria-label')).toContain('5-Hour Limit: 39 / 100 left');
  });

  it('renders permission, context usage, and provider limits in the lower metadata row', () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
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

  it('uses the full composer controls and starts a new session only when sending', async () => {
    setupModelState();
    setState('activeSessionId', 'existing-session');
    setState('sessionStatus', { 'existing-session': { type: 'busy' } });
    setInputText('Build a fresh feature');
    setState('droppedFiles', [
      { path: '/repo/src/new.ts', relativePath: 'src/new.ts', type: 'file' },
    ]);
    const onBeforeSend = vi.fn(() => {
      setState('activeSessionId', null);
      setState('droppedFiles', []);
    });

    cleanup = render(() => ChatInput({ newSession: true, onBeforeSend }), container!);

    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    editor?.focus();

    expect(container?.querySelector('.model-picker-btn')).not.toBeNull();
    expect(container?.querySelector('.permission-mode-button')).not.toBeNull();
    expect(container?.querySelector('[title="Send (Enter)"]')).not.toBeNull();
    expect(onBeforeSend).not.toHaveBeenCalled();

    container
      ?.querySelector<HTMLButtonElement>('[title="Send (Enter)"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(onBeforeSend).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith('Build a fresh feature', {
      noReply: false,
      queuedAttachments: {
        droppedFiles: [
          {
            path: '/repo/src/new.ts',
            relativePath: 'src/new.ts',
            type: 'file',
            lineRanges: undefined,
            attachmentSequence: undefined,
          },
        ],
        clipboardImages: [],
        terminalSelection: null,
      },
    });
  });

  it('preserves text entered while a normal send is pending', async () => {
    setState('activeSessionId', 'session-1');
    setInputText('original prompt');
    let resolveSend: ((sent: boolean) => void) | undefined;
    sendMessageMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        })
    );
    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelector<HTMLButtonElement>('[title="Send (Enter)"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();
    expect(inputText()).toBe('');

    setInputText('new draft while sending');
    resolveSend?.(false);
    await flushAsyncWork();

    expect(inputText()).toBe('new draft while sending');
  });

  it('does not restore a failed snapshot after the user edits the pending draft back to empty', async () => {
    setState('activeSessionId', 'session-1');
    setInputText('original prompt');
    let resolveSend: ((sent: boolean) => void) | undefined;
    sendMessageMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        })
    );
    cleanup = render(() => ChatInput(), container!);
    const editor = container?.querySelector<HTMLElement>('.rich-composer');

    container
      ?.querySelector<HTMLButtonElement>('[title="Send (Enter)"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    editor!.textContent = 'temporary draft';
    editor?.dispatchEvent(new InputEvent('input', { bubbles: true }));
    editor!.textContent = '';
    editor?.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(inputText()).toBe('');

    resolveSend?.(false);
    await flushAsyncWork();

    expect(inputText()).toBe('');
  });

  it('restores a failed draft even when consecutive errors have identical text', async () => {
    setState('activeSessionId', 'session-1');
    setInputText('retry this prompt');
    sendMessageMock.mockResolvedValue(false);
    cleanup = render(() => ChatInput(), container!);

    const send = () =>
      container
        ?.querySelector<HTMLButtonElement>('[title="Send (Enter)"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    send();
    await flushAsyncWork();
    expect(inputText()).toBe('retry this prompt');

    send();
    await flushAsyncWork();
    expect(inputText()).toBe('retry this prompt');
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
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
    setState('activeSessionId', 'session-1');
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

  it('reorders queued rows by dragging the left handle without showing the file-drop overlay', () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'first' },
      { id: 'q2', sessionId: 'session-1', text: 'second' },
      { id: 'q3', sessionId: 'session-1', text: 'third' },
    ]);

    cleanup = render(() => ChatInput(), container!);

    const handles = container!.querySelectorAll<HTMLButtonElement>(
      '[aria-label^="Reorder queued message:"]'
    );
    const rows = container!.querySelectorAll<HTMLElement>('.chat-queue-item');
    const dataTransfer = createDragDataTransfer();

    expect(handles[0]?.draggable).toBe(true);
    dispatchDragEvent(handles[0]!, 'dragstart', dataTransfer);
    dispatchDragEvent(rows[1]!, 'dragover', dataTransfer);

    expect(rows[0]?.classList.contains('is-dragging')).toBe(true);
    expect(rows[1]?.classList.contains('is-drag-over')).toBe(true);
    expect(document.querySelector('.chat-drop-overlay')).toBeNull();

    dispatchDragEvent(rows[1]!, 'drop', dataTransfer);
    dispatchDragEvent(handles[0]!, 'dragend', dataTransfer);

    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q2', 'q1', 'q3']);
    expect(
      [...container!.querySelectorAll('.chat-queue-label')].map((item) => item.textContent)
    ).toEqual(['second', 'first', 'third']);
  });

  it('keeps an edited queue row visible and cancels editing from the row', () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      {
        id: 'q1',
        sessionId: 'session-1',
        text: 'Revise this follow-up',
        droppedFiles: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }],
        clipboardImages: [
          {
            id: 'img-1',
            url: 'data:image/png;base64,AA==',
            mime: 'image/png',
            filename: 'img.png',
            size: 1,
          },
        ],
        terminalSelection: { text: 'npm test', terminalName: 'zsh' },
      },
    ]);

    cleanup = render(() => ChatInput(), container!);

    const editButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Edit queued message"]'
    );
    expect(editButton?.disabled).toBe(false);
    editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(inputText()).toBe('Revise this follow-up');
    expect(state.droppedFiles).toEqual([
      { path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' },
    ]);
    expect(state.clipboardImages).toEqual([
      {
        id: 'img-1',
        url: 'data:image/png;base64,AA==',
        mime: 'image/png',
        filename: 'img.png',
        size: 1,
      },
    ]);
    expect(state.terminalSelection).toEqual({ text: 'npm test', terminalName: 'zsh' });
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1']);
    expect(container?.querySelector('.chat-queue-item.is-editing')).not.toBeNull();
    expect(container?.querySelector('.chat-queue-editing-label')?.textContent).toBe('Editing');
    const cancelButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Cancel queued message edit"]'
    );
    expect(cancelButton?.disabled).toBe(false);

    cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(inputText()).toBe('');
    expect(state.droppedFiles).toEqual([]);
    expect(state.clipboardImages).toEqual([]);
    expect(state.terminalSelection).toBeNull();
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1']);
    expect(container?.querySelector('.chat-queue-item.is-editing')).toBeNull();
    expect(container?.querySelector('[aria-label="Edit queued message"]')).not.toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('requeues an edited message at its original position', async () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'first' },
      { id: 'q2', sessionId: 'session-1', text: 'second' },
      { id: 'q3', sessionId: 'session-1', text: 'third' },
    ]);

    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelectorAll<HTMLButtonElement>('[aria-label="Edit queued message"]')[1]
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    setInputText('second edited');
    await flushAsyncWork();
    const queueButton = container?.querySelector<HTMLButtonElement>(
      '[title="Add to queue (Enter)"]'
    );
    expect(queueButton).not.toBeNull();
    expect(inputText()).toBe('second edited');
    expect(queueButton?.disabled).toBe(false);
    queueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(state.queuedMessages.map((item) => item.text)).toEqual([
      'first',
      'second edited',
      'third',
    ]);
    expect(state.queuedMessages[0]?.id).toBe('q1');
    expect(state.queuedMessages[2]?.id).toBe('q3');
  });

  it('pauses automatic queue dispatch while a queued message is being edited', async () => {
    vi.useFakeTimers();
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'first' },
      { id: 'q2', sessionId: 'session-1', text: 'second' },
    ]);

    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    setIsLoading(false);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);

    expect(sendMessageMock).not.toHaveBeenCalled();

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Cancel queued message edit"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('first', {
      queuedAttachments: {
        droppedFiles: undefined,
        clipboardImages: undefined,
        terminalSelection: undefined,
      },
      preserveComposer: true,
    });
  });

  it('does not overwrite existing composer content when editing a queued message', () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setInputText('Keep this draft');
    setState('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'Queued follow-up' }]);

    cleanup = render(() => ChatInput(), container!);

    const editButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Edit queued message"]'
    );
    expect(editButton?.disabled).toBe(true);
    editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(inputText()).toBe('Keep this draft');
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1']);
  });

  it('waits for connection initialization before dispatching a restored queue', async () => {
    vi.useFakeTimers();
    setConnectionInitialized(false);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'restored follow-up' }]);

    cleanup = render(() => ChatInput(), container!);

    await vi.advanceTimersByTimeAsync(500);
    expect(sendMessageMock).not.toHaveBeenCalled();

    setConnectionInitialized(true);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('restored follow-up', {
      queuedAttachments: {
        droppedFiles: undefined,
        clipboardImages: undefined,
        terminalSelection: undefined,
      },
      preserveComposer: true,
    });
  });

  it('retains a failed automatic queue item and its attachments until an explicit retry', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      {
        id: 'q1',
        sessionId: 'session-1',
        text: 'test 1',
        droppedFiles: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }],
        clipboardImages: [
          { id: 'img-1', url: 'blob:1', mime: 'image/png', filename: 'img-1.png', size: 10 },
        ],
        terminalSelection: { text: 'npm test', terminalName: 'zsh' },
      },
      { id: 'q2', sessionId: 'session-1', text: 'test 2' },
    ]);
    sendMessageMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    cleanup = render(() => ChatInput(), container!);

    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith('test 1', {
      queuedAttachments: {
        droppedFiles: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }],
        clipboardImages: [
          { id: 'img-1', url: 'blob:1', mime: 'image/png', filename: 'img-1.png', size: 10 },
        ],
        terminalSelection: { text: 'npm test', terminalName: 'zsh' },
      },
      preserveComposer: true,
    });
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1', 'q2']);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    const retry = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Retry queued message"]'
    );
    expect(retry?.disabled).toBe(false);
    retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock.mock.calls[1]).toEqual(sendMessageMock.mock.calls[0]);
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q2']);
  });

  it('retains a rejected automatic queue item without repeatedly retrying it', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'test 1' },
      { id: 'q2', sessionId: 'session-1', text: 'test 2' },
    ]);
    sendMessageMock.mockRejectedValueOnce(new Error('send failed'));

    cleanup = render(() => ChatInput(), container!);

    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[0]).toBe('test 1');
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1', 'q2']);
    expect(
      container?.querySelector<HTMLButtonElement>('[aria-label="Retry queued message"]')?.disabled
    ).toBe(false);
  });

  it('does not duplicate an in-flight queued dispatch after remounting', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'pending follow-up' }]);
    let resolveSend: ((sent: boolean) => void) | undefined;
    sendMessageMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        })
    );

    cleanup = render(() => ChatInput(), container!);
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(state.queuedMessageDispatchingId).toBe('q1');

    cleanup();
    cleanup = render(() => ChatInput(), container!);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsyncWork();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    resolveSend?.(true);
    await flushAsyncWork();
    expect(state.queuedMessages).toEqual([]);
    expect(state.queuedMessageDispatchingId).toBeNull();
  });

  it('preserves a failed queued dispatch and allows retry after remounting', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'retry me' }]);
    sendMessageMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    cleanup = render(() => ChatInput(), container!);
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();
    expect(state.failedQueuedMessageIds).toEqual(['q1']);

    cleanup();
    cleanup = render(() => ChatInput(), container!);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsyncWork();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Retry queued message"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(state.queuedMessages).toEqual([]);
    expect(state.failedQueuedMessageIds).toEqual([]);
  });

  it('preserves queued-message editing after remounting', async () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'edit this follow-up' }]);

    cleanup = render(() => ChatInput(), container!);
    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(state.queuedMessageEdit).toEqual({ id: 'q1', sessionId: 'session-1' });
    expect(inputText()).toBe('edit this follow-up');

    cleanup();
    cleanup = render(() => ChatInput(), container!);
    await flushAsyncWork();

    expect(state.queuedMessageEdit).toEqual({ id: 'q1', sessionId: 'session-1' });
    expect(container?.querySelector('.chat-queue-item.is-editing')).not.toBeNull();
    expect(inputText()).toBe('edit this follow-up');
  });

  it('sends queued rows as steers and removes them on success', async () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      {
        id: 'q1',
        sessionId: 'session-1',
        text: 'test 2',
        droppedFiles: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }],
        clipboardImages: [
          { id: 'img-1', url: 'blob:1', mime: 'image/png', filename: 'img-1.png', size: 10 },
        ],
        terminalSelection: { text: 'npm test', terminalName: 'zsh' },
      },
      { id: 'q2', sessionId: 'session-1', text: 'test 3' },
    ]);

    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('test 2', {
      delivery: 'steer',
      queuedAttachments: {
        droppedFiles: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }],
        clipboardImages: [
          { id: 'img-1', url: 'blob:1', mime: 'image/png', filename: 'img-1.png', size: 10 },
        ],
        terminalSelection: { text: 'npm test', terminalName: 'zsh' },
      },
      preserveComposer: true,
    });
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q2']);
  });

  it('keeps a queued steer visible and blocks later queue dispatch while pending', async () => {
    vi.useFakeTimers();
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'test 1' },
      { id: 'q2', sessionId: 'session-1', text: 'test 2' },
    ]);
    let resolveSteer: ((value: boolean) => void) | undefined;
    sendMessageMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSteer = resolve;
        })
    );

    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    const queueLabels = () =>
      [...container!.querySelectorAll('.chat-queue-label')].map((item) => item.textContent);
    expect(sendMessageMock).toHaveBeenCalledWith('test 1', {
      delivery: 'steer',
      queuedAttachments: {
        droppedFiles: undefined,
        clipboardImages: undefined,
        terminalSelection: undefined,
      },
      preserveComposer: true,
    });
    expect(queueLabels()).toEqual(['test 1', 'test 2']);
    expect(
      container?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')?.disabled
    ).toBe(true);

    setIsLoading(false);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1', 'q2']);

    expect(resolveSteer).toBeDefined();
    resolveSteer?.(true);
    await flushAsyncWork();

    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q2']);

    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock.mock.calls[1]).toEqual([
      'test 2',
      {
        queuedAttachments: {
          droppedFiles: undefined,
          clipboardImages: undefined,
          terminalSelection: undefined,
        },
        preserveComposer: true,
      },
    ]);
  });

  it('removes a pending queued steer when the backend admits it', async () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'test 1' },
      { id: 'q2', sessionId: 'session-1', text: 'test 2' },
    ]);
    let resolveSteer: ((value: boolean) => void) | undefined;
    sendMessageMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSteer = resolve;
        })
    );

    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1', 'q2']);

    emitServerEvent('session.next.prompt.admitted', {
      sessionID: 'session-1',
      delivery: 'steer',
      prompt: { text: 'test 1\n[Working directory: /repo]' },
    });
    await flushAsyncWork();

    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q2']);
    expect(container?.textContent).not.toContain('Steering...');

    expect(resolveSteer).toBeDefined();
    resolveSteer?.(false);
    await flushAsyncWork();

    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q2']);
    expect(container?.textContent).not.toContain('Retry Steer');
  });

  it('restores a queued row when steering it reports a send error', async () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'test 2' },
      { id: 'q2', sessionId: 'session-1', text: 'test 3' },
    ]);
    sendMessageMock.mockResolvedValueOnce(false);

    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('test 2', {
      delivery: 'steer',
      queuedAttachments: {
        droppedFiles: undefined,
        clipboardImages: undefined,
        terminalSelection: undefined,
      },
      preserveComposer: true,
    });
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1', 'q2']);
  });

  it('restores edited message context and restores draft context on cancel', async () => {
    setState('activeSessionId', 'session-1');
    setInputText('draft prompt');
    setState('droppedFiles', [{ path: '/repo/draft.ts', relativePath: 'draft.ts', type: 'file' }]);
    setState('clipboardImages', [
      { id: 'draft-img', url: 'blob:draft', mime: 'image/png', filename: 'draft.png', size: 10 },
    ]);
    setState('terminalSelection', { text: 'pwd', terminalName: 'draft-terminal' });

    cleanup = render(() => ChatInput(), container!);

    startEditingMessage('message-1', 'session-1', 'edited prompt', {
      files: [{ path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' }],
      images: [
        { id: 'edit-img', url: 'blob:edit', mime: 'image/png', filename: 'edit.png', size: 0 },
      ],
      terminalSelection: { text: 'npm test', terminalName: 'zsh' },
    });
    await Promise.resolve();

    expect(inputText()).toBe('edited prompt');
    expect(state.droppedFiles).toEqual([
      { path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' },
    ]);
    expect(state.clipboardImages).toEqual([
      { id: 'edit-img', url: 'blob:edit', mime: 'image/png', filename: 'edit.png', size: 0 },
    ]);
    expect(state.terminalSelection).toEqual({ text: 'npm test', terminalName: 'zsh' });

    container
      ?.querySelector<HTMLButtonElement>('[title="Cancel editing (Esc)"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(inputText()).toBe('draft prompt');
    expect(state.droppedFiles).toEqual([
      { path: '/repo/draft.ts', relativePath: 'draft.ts', type: 'file' },
    ]);
    expect(state.clipboardImages).toEqual([
      { id: 'draft-img', url: 'blob:draft', mime: 'image/png', filename: 'draft.png', size: 10 },
    ]);
    expect(state.terminalSelection).toEqual({ text: 'pwd', terminalName: 'draft-terminal' });
  });

  it('merges an edited whole-file attachment into the active document context', async () => {
    setState('activeSessionId', 'session-1');
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        language: 'typescript',
      },
      selection: null,
      diagnostics: [],
    });

    cleanup = render(() => ChatInput(), container!);

    startEditingMessage('message-1', 'session-1', 'edited prompt', {
      files: [{ path: 'app.ts', relativePath: 'app.ts', type: 'file' }],
      images: [],
      terminalSelection: null,
    });
    await Promise.resolve();

    expect(state.droppedFiles).toEqual([]);
    const chips = container?.querySelectorAll('.chat-attachments-container .chat-attachment-chip');
    expect(chips).toHaveLength(1);
    expect(chips?.[0]?.textContent).toContain('app.ts');
    expect(chips?.[0]?.querySelector('.chip-remove')).toBeNull();
  });

  it('does not keep edited message text in the composer after remounting into another session', async () => {
    setState('activeSessionId', 'session-1');
    setInputText('draft prompt');

    cleanup = render(() => ChatInput(), container!);

    startEditingMessage('message-1', 'session-1', 'edited prompt');
    await Promise.resolve();

    expect(inputText()).toBe('edited prompt');

    cleanup?.();
    cleanup = undefined;
    setState('activeSessionId', 'session-2');
    cleanup = render(() => ChatInput(), container!);
    await Promise.resolve();

    expect(inputText()).toBe('draft prompt');
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

  it('keeps the stop button through a short idle gap', async () => {
    vi.useFakeTimers();
    setIsLoading(true);

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('[title="Stop"]')).not.toBeNull();

    setIsLoading(false);
    await Promise.resolve();

    expect(container?.querySelector('[title="Stop"]')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(700);
    await Promise.resolve();

    expect(container?.querySelector('[title="Stop"]')).toBeNull();
  });

  it('shows send controls instead of stop while loading with sendable content', () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setInputText('Follow up');

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('[title="Stop"]')).toBeNull();
    expect(container?.querySelector('[title="Add to queue (Enter)"]')).not.toBeNull();
  });

  it('sends busy composer input as a steer on modifier enter', async () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setInputText('Change direction');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })
    );
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('Change direction', { delivery: 'steer' });
    expect(state.queuedMessages).toEqual([]);
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

  it('runs the built-in fork slash command on Enter', async () => {
    setState('activeSessionId', 'session-1');
    setInputText('/fork');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushAsyncWork();

    expect(forkSessionMock).toHaveBeenCalledWith('session-1');
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
      workspaceDirectory: '/workspace',
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

  it('continues a regular retry after switching away from the limited provider', async () => {
    abortSessionMock.mockResolvedValue(undefined);
    continueInterruptedSessionMock.mockResolvedValue(undefined);
    setState('activeSessionId', 'session-1');
    setState('sessions', [session('session-1', 2_000)]);
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
      'session-1': { type: 'retry', attempt: 9, message: 'messages exhausted', next: 408 },
    });
    setState('sessionUsageLimits', {
      'session-1': {
        source: 'status',
        statusCode: 429,
        message: 'messages exhausted · retry in 408s · attempt #9',
        unit: 'messages',
        retryAt: 408_000,
        attempt: 9,
        sessionID: 'session-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
      },
    });

    cleanup = render(() => ChatInput(), container!);

    const switchProviderButton = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'Switch provider');
    switchProviderButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(continueInterruptedSessionMock).toHaveBeenCalledWith('session-1');
    expect(state.sessionStatus['session-1']).toEqual({ type: 'idle' });
    expect(state.sessionUsageLimits['session-1']).toBeUndefined();
    expect(container?.textContent).not.toContain('Usage limit reached');
  });

  it('clears usage-limit notices across the active tree before sending a prompt', async () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_100, { parentID: 'session-1' }),
    ]);
    setState('sessionUsageLimits', {
      'child-1': {
        source: 'status',
        statusCode: 429,
        message: 'messages exhausted',
        unit: 'messages',
        retryAt: null,
        attempt: 2,
        sessionID: 'child-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
      },
    });
    setInputText('continue');

    cleanup = render(() => ChatInput(), container!);

    expect(container?.textContent).toContain('Usage limit reached');

    const sendButton = container?.querySelector<HTMLButtonElement>('[title="Send (Enter)"]');
    sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('continue', { noReply: false });
    expect(state.sessionUsageLimits['child-1']).toBeUndefined();
    expect(container?.textContent).not.toContain('Usage limit reached');
  });

  it('continues from the usage-limit banner and closes the notice', async () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('sessions', [session('session-1', 2_000)]);
    setState('sessionUsageLimits', {
      'session-1': {
        source: 'message',
        statusCode: 429,
        message: '429 usage limit reached',
        unit: 'messages',
        retryAt: null,
        attempt: null,
        sessionID: 'session-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
      },
    });

    cleanup = render(() => ChatInput(), container!);

    const continueButton = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'Continue');
    continueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('Continue', { noReply: false });
    expect(state.sessionUsageLimits['session-1']).toBeUndefined();
    expect(container?.textContent).not.toContain('Usage limit reached');
  });

  it('restores reasoning selections per model instead of carrying them across models', async () => {
    setState('providers', [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-5.4': {
            id: 'gpt-5.4',
            name: 'GPT-5.4',
            capabilities: { toolcall: true, reasoning: true },
            cost: { input: 0, output: 0 },
            variants: { low: {}, medium: {}, high: {} },
          },
          'gpt-5.5': {
            id: 'gpt-5.5',
            name: 'GPT-5.5',
            capabilities: { toolcall: true, reasoning: true },
            cost: { input: 0, output: 0 },
            variants: { low: {}, medium: {}, high: {} },
          },
        },
      },
    ]);
    setState('providerDefaults', { openai: 'gpt-5.4' });
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-5.4', variant: 'medium' });
    setState('modelVariantSelections', { 'openai:gpt-5.4': 'medium' });

    cleanup = render(() => ChatInput(), container!);

    const modelButton = container?.querySelector<HTMLButtonElement>('.model-picker-btn');
    modelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const gpt55Option = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('.dropdown-item') || []
    ).find((button) => button.textContent?.includes('GPT-5.5'));
    gpt55Option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(state.selectedModel).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.5',
      variant: 'low',
    });

    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' });
    setState('modelVariantSelections', {
      'openai:gpt-5.4': 'medium',
      'openai:gpt-5.5': 'high',
    });

    modelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const gpt54Option = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('.dropdown-item') || []
    ).find((button) => button.textContent?.includes('GPT-5.4'));
    gpt54Option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(state.selectedModel).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      variant: 'medium',
    });
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

function pressKey(editor: HTMLDivElement | null | undefined, init: KeyboardEventInit) {
  editor?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

function historyEntry(id: string, text: string) {
  const info: UserMessage = {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-5' },
  };
  const part: TextPart = {
    id: `${id}-text`,
    sessionID: 'session-1',
    messageID: id,
    type: 'text',
    text,
  };
  return { info, parts: [part] };
}

describe('ChatInput composer history hotkeys', () => {
  it('paginates through sent prompts with Up and returns with Down', async () => {
    setState('activeSessionId', 'session-1');
    setSessionHistoryPrompts('session-1', [
      historyEntry('user-1', 'Earlier loaded prompt'),
      historyEntry('user-2', 'Most recent loaded prompt'),
    ]);
    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    pressKey(editor, { key: 'ArrowUp' });
    expect(inputText()).toBe('Most recent loaded prompt');

    pressKey(editor, { key: 'ArrowUp' });
    expect(inputText()).toBe('Earlier loaded prompt');

    loadOlderSessionPromptsMock.mockImplementationOnce(async () => {
      setSessionHistoryPrompts('session-1', [
        historyEntry('user-0', 'Oldest fetched prompt'),
        historyEntry('user-1', 'Earlier loaded prompt'),
        historyEntry('user-2', 'Most recent loaded prompt'),
      ]);
      return true;
    });
    pressKey(editor, { key: 'ArrowUp' });
    await flushAsyncWork();
    expect(inputText()).toBe('Oldest fetched prompt');

    pressKey(editor, { key: 'ArrowDown' });
    expect(inputText()).toBe('Earlier loaded prompt');

    pressKey(editor, { key: 'ArrowDown' });
    expect(inputText()).toBe('Most recent loaded prompt');

    pressKey(editor, { key: 'ArrowDown' });
    expect(inputText()).toBe('');
  });

  it('undoes and redoes composer text edits with the keyboard', async () => {
    cleanup = render(() => ChatInput(), container!);
    setInputText('hello');
    setInputText('hello world');

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    pressKey(editor, { key: 'z', metaKey: true });
    expect(inputText()).toBe('hello');

    pressKey(editor, { key: 'z', ctrlKey: true });
    expect(inputText()).toBe('');

    pressKey(editor, { key: 'z', metaKey: true, shiftKey: true });
    expect(inputText()).toBe('hello');

    pressKey(editor, { key: 'y', ctrlKey: true });
    expect(inputText()).toBe('hello world');
  });

  it('restores composer text after pasted content is undone', async () => {
    cleanup = render(() => ChatInput(), container!);
    setInputText('draft');
    setInputText('draft pasted block of text');

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    pressKey(editor, { key: 'z', metaKey: true });
    expect(inputText()).toBe('draft');

    pressKey(editor, { key: 'z', metaKey: true, shiftKey: true });
    expect(inputText()).toBe('draft pasted block of text');
  });

  it('undoes and redoes attachment changes', async () => {
    cleanup = render(() => ChatInput(), container!);

    addContextFile({ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' });
    expect(state.droppedFiles.map((file) => file.path)).toEqual(['/repo/src/a.ts']);

    removeContextFile('/repo/src/a.ts');
    expect(state.droppedFiles).toEqual([]);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    pressKey(editor, { key: 'z', metaKey: true });
    expect(state.droppedFiles.map((file) => file.path)).toEqual(['/repo/src/a.ts']);

    pressKey(editor, { key: 'z', metaKey: true });
    expect(state.droppedFiles).toEqual([]);

    pressKey(editor, { key: 'z', metaKey: true, shiftKey: true });
    expect(state.droppedFiles.map((file) => file.path)).toEqual(['/repo/src/a.ts']);
  });

  it('does not stop the running session on Escape', async () => {
    setState('activeSessionId', 'session-1');
    setIsLoading(true);
    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    await flushAsyncWork();

    expect(abortSessionMock).not.toHaveBeenCalled();
  });

  it('closes a toolbar popup on Escape without leaking the shortcut', () => {
    setState('agents', [
      {
        name: 'plan',
        description: 'Draft implementation plans',
        mode: 'primary',
        builtIn: true,
        permission: [],
      },
    ]);
    cleanup = render(() => ChatInput(), container!);

    const agentButton = container?.querySelector<HTMLButtonElement>('[title="Select agent"]');
    agentButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(container?.querySelector('.agent-popover')).toBeInstanceOf(HTMLDivElement);

    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(container?.querySelector('.agent-popover')).toBeNull();
  });

  it('does not stop anything on Escape while idle', async () => {
    setState('activeSessionId', 'session-1');
    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    await flushAsyncWork();

    expect(abortSessionMock).not.toHaveBeenCalled();
  });
});
