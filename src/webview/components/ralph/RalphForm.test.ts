import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { RalphForm, shouldDeletePreviousBlankSession } from './RalphForm';
import { ralphStore } from '../../lib/stores/ralph-store';
import { ralphRunner } from './ralph-runner';

const openCodeMocks = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  selectSession: vi.fn(),
}));

const stateMock = vi.hoisted(() => ({
  activeSessionId: null,
  selectedModel: null,
  selectedAgent: null,
  providers: [],
  allAgents: [],
  messages: [],
  queuedMessages: [],
  sessionStatus: {},
  editorContext: {
    workspacePath: null,
    activeFile: null,
  },
}));

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

vi.mock('./ralph-prompts', () => ({
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
  stateMock.allAgents = [];
  stateMock.messages = [];
  stateMock.queuedMessages = [];
  stateMock.sessionStatus = {};
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
  it('does not close when the backdrop is clicked', () => {
    cleanup = render(() => RalphForm(), container!);

    const overlay = document.body.querySelector('.ralph-form-overlay');
    expect(overlay).toBeInstanceOf(HTMLDivElement);

    overlay?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(document.body.querySelector('.ralph-form-overlay')).toBeInstanceOf(HTMLDivElement);
    expect(ralphStore.showRalphForm()).toBe(true);
  });

  it('does not close when Escape is pressed', () => {
    cleanup = render(() => RalphForm(), container!);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(document.body.querySelector('.ralph-form-overlay')).toBeInstanceOf(HTMLDivElement);
    expect(ralphStore.showRalphForm()).toBe(true);
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
    clientMocks.pickWorkspaceFile.mockResolvedValue('docs/RALPH.md');
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
        models: {
          'gpt-5.5': {
            id: 'gpt-5.5',
            name: 'GPT 5.5',
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
        model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'low' },
      })
    );
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
