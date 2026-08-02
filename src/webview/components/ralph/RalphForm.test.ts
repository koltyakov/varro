import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { RalphForm, shouldDeletePreviousBlankSession } from './RalphForm';
import { ralphStore } from '../../lib/stores/ralph-store';
import { ralphRunner } from './ralph-runner';
import type { Agent, MessageEntry, Provider } from '../../types';
import type { EditorContext } from '../../../shared/protocol';
import type { RalphSelectedModel } from '../../../shared/ralph';

const openCodeMocks = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  selectSession: vi.fn(),
}));

type RalphFormStateMock = {
  activeSessionId: string | null;
  selectedModel: RalphSelectedModel | null;
  selectedAgent: string | null;
  providers: Provider[];
  providerDefaults: Record<string, string>;
  allAgents: Agent[];
  messages: MessageEntry[];
  queuedMessages: Array<{ sessionId: string }>;
  sessionStatus: Record<string, { type?: string }>;
  desktopSessionPaneSide: 'left' | 'right';
  editorContext: Pick<EditorContext, 'workspacePath' | 'activeFile'>;
};

const stateMock = vi.hoisted(
  (): RalphFormStateMock => ({
    activeSessionId: null,
    selectedModel: null,
    selectedAgent: null,
    providers: [],
    providerDefaults: {},
    allAgents: [],
    messages: [],
    queuedMessages: [],
    sessionStatus: {},
    desktopSessionPaneSide: 'left',
    editorContext: {
      workspacePath: null,
      activeFile: null,
    },
  })
);

const clientMocks = vi.hoisted(() => ({
  create: vi.fn(),
  sendAsync: vi.fn(),
  pickWorkspaceFile: vi.fn(),
  readWorkspaceFile: vi.fn(),
}));

vi.mock('../../lib/client', () => ({
  client: {
    session: {
      create: clientMocks.create,
      sendAsync: clientMocks.sendAsync,
    },
    varro: {
      pickWorkspaceFile: clientMocks.pickWorkspaceFile,
      readWorkspaceFile: clientMocks.readWorkspaceFile,
    },
  },
}));

vi.mock('../../lib/state', () => ({
  desktopSessionPaneSide: () => stateMock.desktopSessionPaneSide,
  getStoredVariantForModel: vi.fn(() => null),
  getVisibleProviders: vi.fn((providers: Provider[]) => providers),
  isSessionAwaitingInput: vi.fn(() => false),
  state: stateMock,
}));

vi.mock('../../hooks/useOpenCode', () => ({
  deleteSession: openCodeMocks.deleteSession,
  selectSession: openCodeMocks.selectSession,
}));

vi.mock('../../hooks/permission-rules', () => ({
  getSessionPermissionRulesForMode: vi.fn(() => []),
}));

vi.mock('./ralph-runner', () => ({
  ralphRunner: {
    start: vi.fn(),
  },
}));

vi.mock('../../../shared/ralph-prompts', () => ({
  buildAnchorMessage: vi.fn(() => 'anchor'),
  getDefaultPromptTemplate: vi.fn(() => 'template'),
}));

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

async function flushMicrotasks(count = 4) {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.mocked(ralphRunner.start).mockReset();
  clientMocks.create.mockReset();
  clientMocks.sendAsync.mockReset();
  clientMocks.pickWorkspaceFile.mockReset();
  clientMocks.readWorkspaceFile.mockReset();
  openCodeMocks.deleteSession.mockReset();
  openCodeMocks.selectSession.mockReset();
  stateMock.activeSessionId = null;
  stateMock.selectedModel = null;
  stateMock.selectedAgent = null;
  stateMock.providers = [];
  stateMock.providerDefaults = {};
  stateMock.allAgents = [];
  stateMock.messages = [];
  stateMock.queuedMessages = [];
  stateMock.sessionStatus = {};
  stateMock.desktopSessionPaneSide = 'left';
  stateMock.editorContext.workspacePath = null;
  stateMock.editorContext.activeFile = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  ralphStore.setShowRalphForm(true);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  ralphStore.setShowRalphForm(false);
  container?.remove();
  container = null;
  window.localStorage.clear();
});

describe('RalphForm', () => {
  it('is a labelled modal and moves focus to its first control', async () => {
    cleanup = render(() => RalphForm(), container!);
    await flushMicrotasks();

    const dialog = document.body.querySelector<HTMLElement>('.ralph-form-card');
    const title = document.body.querySelector<HTMLElement>('.ralph-form-title');
    const closeButton = document.body.querySelector<HTMLButtonElement>('.ralph-form-close');

    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(title?.id).not.toBe('');
    expect(dialog?.getAttribute('aria-labelledby')).toBe(title?.id);
    expect(document.activeElement).toBe(closeButton);
  });

  it('keeps Tab inside the modal and restores focus when it closes', async () => {
    container!.tabIndex = -1;
    container!.focus();
    cleanup = render(() => RalphForm(), container!);
    await flushMicrotasks();

    const dialog = document.body.querySelector<HTMLElement>('.ralph-form-card');
    const closeButton = document.body.querySelector<HTMLButtonElement>('.ralph-form-close');
    const startButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Start loop');
    expect(dialog).toBeInstanceOf(HTMLElement);
    expect(startButton).toBeInstanceOf(HTMLButtonElement);

    startButton?.focus();
    startButton?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    );

    expect(document.activeElement).toBe(closeButton);

    closeButton?.click();

    expect(document.body.querySelector('.ralph-form-overlay')).toBeNull();
    expect(document.activeElement).toBe(container);
  });

  it('makes the session UI inert until the modal closes', () => {
    container!.className = 'interactive-session';
    cleanup = render(() => RalphForm(), container!);

    expect(container?.hasAttribute('inert')).toBe(true);

    document.body.querySelector<HTMLButtonElement>('.ralph-form-close')?.click();

    expect(container?.hasAttribute('inert')).toBe(false);
  });

  it('does not close when the backdrop is clicked', () => {
    cleanup = render(() => RalphForm(), container!);

    const overlay = document.body.querySelector('.ralph-form-overlay');
    expect(overlay).toBeInstanceOf(HTMLDivElement);

    overlay?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(document.body.querySelector('.ralph-form-overlay')).toBeInstanceOf(HTMLDivElement);
    expect(ralphStore.showRalphForm()).toBe(true);
  });

  it('closes on Escape and restores focus to the opener', async () => {
    container!.tabIndex = -1;
    container!.focus();
    cleanup = render(() => RalphForm(), container!);
    await flushMicrotasks();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));

    expect(document.body.querySelector('.ralph-form-overlay')).toBeNull();
    expect(ralphStore.showRalphForm()).toBe(false);
    expect(document.activeElement).toBe(container);
  });

  it('closes a nested picker before closing the modal and resets it for the next open', async () => {
    cleanup = render(() => RalphForm(), container!);
    await flushMicrotasks();

    document.body
      .querySelector<HTMLButtonElement>('.ralph-form-card .model-picker-btn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.body.querySelector('.ralph-form-card .dropdown-menu')).not.toBeNull();
    });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));

    expect(document.body.querySelector('.ralph-form-overlay')).not.toBeNull();
    expect(document.body.querySelector('.ralph-form-card .dropdown-menu')).toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(document.body.querySelector('.ralph-form-overlay')).toBeNull();

    ralphStore.setShowRalphForm(true);
    await flushMicrotasks();
    expect(document.body.querySelector('.ralph-form-overlay')).not.toBeNull();
    expect(document.body.querySelector('.ralph-form-card .dropdown-menu')).toBeNull();
  });

  it('still closes from the explicit cancel button', () => {
    cleanup = render(() => RalphForm(), container!);

    const cancelButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Cancel'
    );
    expect(cancelButton).toBeInstanceOf(HTMLButtonElement);

    cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(document.body.querySelector('.ralph-form-overlay')).toBeNull();
    expect(ralphStore.showRalphForm()).toBe(false);
  });

  it('fills the plan path from the picker button', async () => {
    clientMocks.pickWorkspaceFile.mockResolvedValue({
      path: 'docs/RALPH.md',
      workspaceDirectory: '/repo-b',
    });
    cleanup = render(() => RalphForm(), container!);

    const pickButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Pick file'
    );
    expect(pickButton).toBeInstanceOf(HTMLButtonElement);

    pickButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicrotasks();

    const input = document.body.querySelector('input[type="text"]');
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect((input as HTMLInputElement | null)?.value).toBe('docs/RALPH.md');
    expect(clientMocks.pickWorkspaceFile).toHaveBeenCalledTimes(1);
  });

  it('starts in the workspace root returned with a multi-root plan selection', async () => {
    stateMock.editorContext.workspacePath = '/repo-a';
    clientMocks.pickWorkspaceFile.mockResolvedValue({
      path: 'docs/RALPH.md',
      workspaceDirectory: '/repo-b/',
    });
    clientMocks.create.mockResolvedValue({ id: 'ralph-session' });
    clientMocks.sendAsync.mockResolvedValue(undefined);
    cleanup = render(() => RalphForm(), container!);

    const pickButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Pick file'
    );
    pickButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicrotasks();

    stateMock.editorContext.workspacePath = '/repo-a-changed';
    const startButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Start loop'
    );
    startButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicrotasks();

    expect(ralphRunner.start).toHaveBeenCalledWith(
      expect.objectContaining({
        planDocPath: 'docs/RALPH.md',
        workspaceDirectory: '/repo-b',
      })
    );
    expect(clientMocks.create).toHaveBeenCalledWith(expect.anything(), {
      directory: '/repo-b',
    });
  });

  it('preselects the current context document when the form opens', () => {
    stateMock.editorContext.activeFile = {
      path: '/repo/RALPH.md',
      relativePath: 'RALPH.md',
      language: 'markdown',
    };

    cleanup = render(() => RalphForm(), container!);

    const input = document.body.querySelector('input[type="text"]');
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect((input as HTMLInputElement | null)?.value).toBe('RALPH.md');
  });

  it('starts the loop with the effective reasoning level', async () => {
    stateMock.selectedModel = { providerID: 'openai', modelID: 'gpt-5.5' };
    stateMock.providers = [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-5.5': {
            id: 'gpt-5.5',
            name: 'GPT 5.5',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
            variants: { low: {}, medium: {}, high: {} },
          },
        },
      },
    ];
    stateMock.editorContext.activeFile = {
      path: '/repo/docs/RALPH.md',
      relativePath: 'docs/RALPH.md',
      language: 'markdown',
    };
    stateMock.editorContext.workspacePath = '/repo/';
    clientMocks.create.mockResolvedValue({ id: 'ralph-session' });
    clientMocks.sendAsync.mockResolvedValue(undefined);
    cleanup = render(() => RalphForm(), container!);

    const startButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Start loop'
    );
    expect(startButton).toBeInstanceOf(HTMLButtonElement);

    startButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicrotasks();

    expect(ralphRunner.start).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDirectory: '/repo',
        model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'low' },
      })
    );
    expect(clientMocks.create).toHaveBeenCalledWith(expect.anything(), { directory: '/repo' });
    expect(clientMocks.sendAsync).toHaveBeenCalledWith('ralph-session', expect.anything(), {
      directory: '/repo',
    });
  });

  it('does not start without an originating workspace directory', async () => {
    stateMock.editorContext.activeFile = {
      path: '/tmp/RALPH.md',
      relativePath: '/tmp/RALPH.md',
      language: 'markdown',
    };
    cleanup = render(() => RalphForm(), container!);

    const startButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Start loop'
    );
    startButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicrotasks();

    expect(document.body.textContent).toContain(
      'Open the plan from a workspace folder before starting Ralph'
    );
    expect(clientMocks.create).not.toHaveBeenCalled();
    expect(ralphRunner.start).not.toHaveBeenCalled();
  });

  it('prefills the provider default model when no model is selected', () => {
    stateMock.providers = [
      {
        id: 'github-copilot',
        name: 'GitHub Copilot',
        source: 'api',
        models: {
          'gpt-5.4': {
            id: 'gpt-5.4',
            name: 'GPT-5.4',
            capabilities: { toolcall: true },
            cost: { input: 1, output: 1 },
          },
          'gpt-5.4-mini': {
            id: 'gpt-5.4-mini',
            name: 'GPT-5.4 Mini',
            capabilities: { toolcall: true },
            cost: { input: 1, output: 1 },
          },
        },
      },
    ];
    stateMock.providerDefaults = { 'github-copilot': 'gpt-5.4-mini' };

    cleanup = render(() => RalphForm(), container!);

    const modelButton = document.body.querySelector<HTMLButtonElement>('.model-picker-btn');
    expect(modelButton?.textContent).toContain('GPT-5.4 Mini');
  });

  it('uses a selection-only model popup in the Ralph form', async () => {
    stateMock.providers = [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-5.4': {
            id: 'gpt-5.4',
            name: 'GPT-5.4',
            capabilities: { toolcall: true },
            cost: { input: 1, output: 1 },
          },
        },
      },
    ];
    stateMock.selectedModel = { providerID: 'openai', modelID: 'gpt-5.4' };

    cleanup = render(() => RalphForm(), container!);

    const modelButton = document.body.querySelector<HTMLButtonElement>('.model-picker-btn');
    modelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicrotasks();

    expect(document.body.textContent).not.toContain('Manage Models');
  });

  it('identifies a previously active blank session for cleanup', () => {
    expect(
      shouldDeletePreviousBlankSession(
        'draft-session',
        {
          messages: [],
          queuedMessages: [],
          sessionStatus: {},
        },
        false
      )
    ).toBe(true);
  });

  it('does not clean up the previous session when it has queued work', () => {
    expect(
      shouldDeletePreviousBlankSession(
        'draft-session',
        {
          messages: [],
          queuedMessages: [{ sessionId: 'draft-session' }],
          sessionStatus: {},
        },
        false
      )
    ).toBe(false);
  });
});
