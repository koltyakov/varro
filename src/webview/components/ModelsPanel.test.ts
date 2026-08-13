import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import type { Session } from '../types';
import {
  markProviderAuthFailure,
  resetProviderConnectionState,
} from '../lib/provider-connection-state';
import { setState } from '../lib/state';
import { STORAGE_KEYS } from '../lib/state-storage';
import { ModelsPanel } from './ModelsPanel';

declare global {
  interface Window {
    __sendToExtension?: (message: unknown) => void;
  }
}

const clientMocks = vi.hoisted(() => ({
  openCodeConfig: vi.fn(),
  saveModelRouting: vi.fn(),
  providerAuth: vi.fn(),
  providerCatalog: vi.fn(),
  authorizeProvider: vi.fn(),
  completeProviderAuth: vi.fn(),
  connectApiProvider: vi.fn(),
  disconnectProvider: vi.fn(),
  workspaceStatus: vi.fn(),
}));

const refreshRoutingStateMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const providerSetupMocks = vi.hoisted(() => ({
  openProviderLogout: vi.fn(),
  openProviderSetup: vi.fn(),
}));

vi.mock('../lib/client', () => ({
  client: {
    varro: {
      openCodeConfig: clientMocks.openCodeConfig,
      saveModelRouting: clientMocks.saveModelRouting,
    },
    config: {
      providerAuth: clientMocks.providerAuth,
      providerCatalog: clientMocks.providerCatalog,
      authorizeProvider: clientMocks.authorizeProvider,
      completeProviderAuth: clientMocks.completeProviderAuth,
      connectApiProvider: clientMocks.connectApiProvider,
      disconnectProvider: clientMocks.disconnectProvider,
      workspaceStatus: clientMocks.workspaceStatus,
    },
  },
}));

vi.mock('../lib/provider-setup', () => ({
  ...providerSetupMocks,
}));

vi.mock('../hooks/useOpenCode', () => ({
  refreshRoutingState: refreshRoutingStateMock,
}));

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;

function session(id: string, parentID?: string): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: id,
    version: '1',
    time: { created: 1, updated: 1 },
    ...(parentID ? { parentID } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  delete window.__sendToExtension;
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
  clientMocks.openCodeConfig.mockResolvedValue({
    smallModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
    agentModels: { build: { providerID: 'openai', modelID: 'gpt-5' } },
    commitMessageModel: { providerID: 'openai', modelID: 'gpt-5' },
    autoApproveModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
  });
  clientMocks.saveModelRouting.mockResolvedValue({
    small_model: 'openai/gpt-5',
    agent: { build: { model: 'openai/gpt-5' } },
  });
  clientMocks.providerAuth.mockResolvedValue({
    openai: [{ type: 'api', label: 'API key' }],
  });
  clientMocks.providerCatalog.mockResolvedValue({
    all: [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {},
      },
    ],
    default: {},
    connected: ['openai'],
  });
  clientMocks.connectApiProvider.mockResolvedValue(true);
  clientMocks.disconnectProvider.mockResolvedValue(true);
  clientMocks.workspaceStatus.mockResolvedValue([{ workspaceID: 'ws-1', status: 'connected' }]);
  refreshRoutingStateMock.mockImplementation(async () => {
    setState('providerAuthMethods', {
      openai: [{ type: 'api', label: 'API key' }],
    });
    setState('workspaceStatuses', [{ workspaceID: 'ws-1', status: 'connected' }]);
  });
  setState('providers', [
    {
      id: 'openai',
      name: 'OpenAI',
      source: 'api',
      models: {
        'gpt-5': {
          id: 'gpt-5',
          name: 'GPT-5',
          capabilities: { toolcall: true },
          cost: { input: 1, output: 1 },
          limit: { context: 400000, output: 32000 },
          release_date: '2026-01-01',
        },
        'gpt-5-mini': {
          id: 'gpt-5-mini',
          name: 'GPT-5 mini',
          capabilities: { toolcall: true },
          cost: { input: 1, output: 1 },
          limit: { context: 128000, output: 16000 },
        },
      },
    },
  ]);
  setState('providerDefaults', { openai: 'gpt-5' });
  setState('providersLoaded', true);
  setState('providerRefreshPending', false);
  setState('sessions', []);
  setState('sessionStatus', {});
  setState('agents', [
    {
      name: 'build',
      mode: 'primary',
      builtIn: true,
      permission: { edit: 'allow', bash: { '*': 'allow' } },
      tools: {},
      model: { providerID: 'openai', modelID: 'gpt-5' },
    },
  ]);
  setState('allAgents', [
    {
      name: 'build',
      mode: 'primary',
      builtIn: true,
      permission: { edit: 'allow', bash: { '*': 'allow' } },
      tools: {},
      model: { providerID: 'openai', modelID: 'gpt-5' },
    },
    {
      name: 'review',
      mode: 'subagent',
      builtIn: true,
      permission: { edit: 'allow', bash: { '*': 'allow' } },
      tools: {},
      model: { providerID: 'openai', modelID: 'gpt-5-mini' },
    },
  ]);
  setState('hiddenProviders', []);
  setState('hiddenModels', []);
  setState('pinnedModels', []);
  window.localStorage.removeItem(STORAGE_KEYS.pinnedModels);
  setState('providerAuthMethods', reconcile({}));
  resetProviderConnectionState();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  delete window.__sendToExtension;
  setState('providers', []);
  setState('providerDefaults', {});
  setState('providersLoaded', false);
  setState('providerRefreshPending', false);
  setState('sessions', []);
  setState('sessionStatus', {});
  setState('agents', []);
  setState('allAgents', []);
  setState('providerAuthMethods', {});
  setState('workspaceStatuses', []);
  setState('hiddenProviders', []);
  setState('hiddenModels', []);
  setState('pinnedModels', []);
  window.localStorage.removeItem(STORAGE_KEYS.pinnedModels);
  setState('providerAuthMethods', reconcile({}));
  resetProviderConnectionState();
  if (originalResizeObserver) {
    globalThis.ResizeObserver = originalResizeObserver;
  }
  vi.restoreAllMocks();
});

describe('ModelsPanel', () => {
  it('labels the GPT Fast lightning symbol on hover', async () => {
    setState('providers', 0, 'models', 'gpt-5', 'name', 'GPT-5 Fast');
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const fastSymbol = container?.querySelector(
      '.settings-model-name [title="Fast (more expensive)"]'
    );
    expect(fastSymbol?.textContent).toBe('⚡');
  });

  it('requests a provider reload from the extension', () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    cleanup = render(() => ModelsPanel(), container!);

    const reloadButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Reload providers"]'
    );
    reloadButton?.click();

    expect(reloadButton).toBeInstanceOf(HTMLButtonElement);
    expect(send).toHaveBeenCalledWith({ type: 'providers/refresh' });
  });

  it('opens the embedded disconnect dialog from the minus button', async () => {
    cleanup = render(() => ModelsPanel(), container!);

    const logoutButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Remove provider"]'
    );
    logoutButton?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(logoutButton).toBeInstanceOf(HTMLButtonElement);
    expect(document.body.textContent).toContain('Disconnect provider');
    expect(providerSetupMocks.openProviderLogout).not.toHaveBeenCalled();
  });

  it('uses terminal provider actions on Option-click', () => {
    cleanup = render(() => ModelsPanel(), container!);

    const addButton = container?.querySelector<HTMLButtonElement>('[aria-label="Add provider"]');
    const removeButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Remove provider"]'
    );
    addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));

    expect(addButton).toBeInstanceOf(HTMLButtonElement);
    expect(providerSetupMocks.openProviderSetup).toHaveBeenCalledOnce();
    expect(providerSetupMocks.openProviderLogout).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('disconnects the selected provider credential and refreshes providers', async () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    clientMocks.providerCatalog.mockResolvedValue({
      all: [
        { id: 'openai', name: 'OpenAI', source: 'api', models: {} },
        { id: 'anthropic', name: 'Anthropic', source: 'api', models: {} },
        { id: 'opencode', name: 'OpenCode Zen', source: 'api', models: {} },
      ],
      default: {},
      connected: ['anthropic', 'opencode'],
    });
    cleanup = render(() => ModelsPanel(), container!);

    container?.querySelector<HTMLButtonElement>('[aria-label="Remove provider"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('Anthropic');
    expect(dialog?.textContent).not.toContain('OpenAI');
    expect(dialog?.textContent).not.toContain('OpenCode Zen');
    dialog?.querySelector<HTMLButtonElement>('.provider-connect-option')?.click();
    expect(dialog?.textContent).toContain('Remove the saved credential');
    findButton(dialog, 'Disconnect')?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(clientMocks.disconnectProvider).toHaveBeenCalledWith('anthropic');
    expect(send).toHaveBeenCalledWith({ type: 'providers/refresh' });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('opens immediately with a skeleton and shows providers only after loading', async () => {
    let resolveCatalog!: (value: {
      all: Array<{ id: string; name: string; source: 'api'; models: Record<string, never> }>;
      default: Record<string, string>;
      connected: string[];
    }) => void;
    clientMocks.providerCatalog.mockReturnValue(
      new Promise((resolve) => {
        resolveCatalog = resolve;
      })
    );
    cleanup = render(() => ModelsPanel(), container!);

    const button = container?.querySelector<HTMLButtonElement>('[aria-label="Add provider"]');
    button?.click();

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).toBeInstanceOf(HTMLElement);
    expect(dialog?.querySelector('.provider-connect-skeleton')).toBeInstanceOf(HTMLElement);
    expect(dialog?.querySelector('.provider-connect-option')).toBeNull();
    expect(dialog?.querySelector('[aria-label="Search providers"]')).toBeNull();

    resolveCatalog({
      all: [{ id: 'openai', name: 'OpenAI', source: 'api', models: {} }],
      default: {},
      connected: [],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(dialog?.querySelector('.provider-connect-skeleton')).toBeNull();
    expect(dialog?.querySelector('.provider-connect-option')?.textContent).toContain('OpenAI');
    expect(dialog?.querySelector('[aria-label="Search providers"]')).toBeInstanceOf(
      HTMLInputElement
    );
  });

  it('hides fallback models while a provider requires re-authentication', async () => {
    markProviderAuthFailure('openai', 'failed-message');
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    expect(container?.textContent).toContain(
      'Authentication is required to load available models.'
    );
    expect(container?.querySelector('.settings-model-row')).toBeNull();
    expect(container?.querySelector('.settings-provider-count')?.textContent).toBe('Reconnect');
  });

  it('connects an API provider from the embedded dialog', async () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    cleanup = render(() => ModelsPanel(), container!);

    container?.querySelector<HTMLButtonElement>('[aria-label="Add provider"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    dialog?.querySelector<HTMLButtonElement>('.provider-connect-option')?.click();
    dialog?.querySelector<HTMLButtonElement>('.provider-connect-method')?.click();
    const keyInput = dialog?.querySelector<HTMLInputElement>('input[type="password"]');
    if (keyInput) {
      keyInput.value = 'sk-test';
      keyInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    findButton(dialog, 'Connect')?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(clientMocks.connectApiProvider).toHaveBeenCalledWith(
      {
        providerID: 'openai',
        key: 'sk-test',
        metadata: {},
      },
      { signal: expect.any(AbortSignal) }
    );
    expect(send).toHaveBeenCalledWith({ type: 'providers/refresh' });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('returns to auth methods when credential entry is cancelled', async () => {
    cleanup = render(() => ModelsPanel(), container!);

    container?.querySelector<HTMLButtonElement>('[aria-label="Add provider"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    dialog?.querySelector<HTMLButtonElement>('.provider-connect-option')?.click();
    dialog?.querySelector<HTMLButtonElement>('.provider-connect-method')?.click();
    expect(dialog?.querySelector('input[type="password"]')).toBeInstanceOf(HTMLInputElement);

    findButton(dialog, 'Cancel')?.click();

    expect(document.body.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog?.querySelector('input[type="password"]')).toBeNull();
    expect(dialog?.querySelector('.provider-connect-method')).toBeInstanceOf(HTMLButtonElement);
    expect(dialog?.textContent).toContain('Choose how you want to authenticate.');
  });

  it('searches every provider returned by OpenCode, including unconfigured providers', async () => {
    clientMocks.providerCatalog.mockResolvedValue({
      all: [
        { id: 'openai', name: 'OpenAI', source: 'api', models: {} },
        { id: 'anthropic', name: 'Anthropic', source: 'api', models: {} },
        { id: 'custom-cloud', name: 'Custom Cloud', source: 'api', models: {} },
      ],
      default: {},
      connected: [],
    });
    setState('providerAuthMethods', {
      anthropic: [{ type: 'oauth', label: 'Claude subscription' }],
    });
    cleanup = render(() => ModelsPanel(), container!);

    container?.querySelector<HTMLButtonElement>('[aria-label="Add provider"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const options = () =>
      Array.from(dialog?.querySelectorAll<HTMLElement>('.provider-connect-option') ?? []);
    expect(options().map((option) => option.textContent)).toEqual([
      expect.stringContaining('Anthropic'),
      expect.stringContaining('Custom Cloud'),
      expect.stringContaining('OpenAI'),
    ]);

    const search = dialog?.querySelector<HTMLInputElement>('[aria-label="Search providers"]');
    if (search) {
      search.value = 'custom';
      search.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }

    expect(options()).toHaveLength(1);
    expect(options()[0]?.textContent).toContain('Custom Cloud');
    options()[0]?.click();
    expect(dialog?.textContent).toContain('API key');
  });

  it('renders the provider scrollbar as an overlay above the rows', async () => {
    clientMocks.providerCatalog.mockResolvedValue({
      all: Array.from({ length: 20 }, (_, index) => ({
        id: `provider-${index}`,
        name: `Provider ${index}`,
        source: 'api' as const,
        models: {},
      })),
      default: {},
      connected: [],
    });
    cleanup = render(() => ModelsPanel(), container!);

    container?.querySelector<HTMLButtonElement>('[aria-label="Add provider"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const options = dialog?.querySelector<HTMLElement>('.provider-connect-options');
    Object.defineProperties(options!, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    options?.dispatchEvent(new Event('scroll'));

    const thumb = dialog?.querySelector<HTMLElement>('.provider-connect-scrollbar-thumb');
    expect(thumb).toBeInstanceOf(HTMLElement);
    expect(thumb?.style.height).toBe('25px');
    expect(thumb?.style.transform).toBe('translateY(25px)');
  });

  it('uses a styled listbox for provider authentication prompts', async () => {
    refreshRoutingStateMock.mockImplementationOnce(() => Promise.resolve());
    clientMocks.providerCatalog.mockResolvedValue({
      all: [{ id: 'gitlab', name: 'GitLab', source: 'api', models: {} }],
      default: {},
      connected: [],
    });
    setState('providerAuthMethods', {
      gitlab: [
        {
          type: 'oauth',
          label: 'GitLab Copilot',
          prompts: [
            {
              type: 'select',
              key: 'deployment',
              message: 'Select GitLab deployment type',
              options: [
                { label: 'GitLab.com', value: 'cloud', hint: 'Hosted by GitLab' },
                { label: 'Self-managed', value: 'self-managed' },
              ],
            },
          ],
        },
      ],
    });
    cleanup = render(() => ModelsPanel(), container!);

    container?.querySelector<HTMLButtonElement>('[aria-label="Add provider"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
    const dialog = Array.from(document.body.querySelectorAll<HTMLElement>('[role="dialog"]')).at(
      -1
    );
    const providerOption = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('.provider-connect-option') ?? []
    ).find((option) => option.textContent?.includes('GitLab'));
    expect(providerOption?.textContent).toContain('GitLab');
    providerOption?.click();
    const methodOption = dialog?.querySelector<HTMLButtonElement>('.provider-connect-method');
    expect(methodOption?.textContent).toContain('GitLab Copilot');
    methodOption?.click();

    expect(dialog?.querySelector('select')).toBeNull();
    const trigger = dialog?.querySelector<HTMLButtonElement>('.provider-connect-select-trigger');
    expect(trigger).toBeInstanceOf(HTMLButtonElement);
    trigger?.click();
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(dialog?.querySelector('.provider-connect-body')?.classList).toContain('has-open-select');
    expect(dialog?.querySelector('[role="listbox"]')).toBeInstanceOf(HTMLElement);
    expect(dialog?.textContent).toContain('Hosted by GitLab');

    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(trigger?.textContent).toContain('Self-managed');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(dialog?.querySelector('.provider-connect-body')?.classList).not.toContain(
      'has-open-select'
    );
  });

  it('can copy an auto-authorization code and close while waiting', async () => {
    clientMocks.providerCatalog.mockResolvedValue({
      all: [{ id: 'github-copilot', name: 'GitHub Copilot', source: 'api', models: {} }],
      default: {},
      connected: [],
    });
    setState('providerAuthMethods', {
      'github-copilot': [{ type: 'oauth', label: 'GitHub Copilot' }],
    });
    clientMocks.authorizeProvider.mockResolvedValue({
      url: 'https://github.com/login/device',
      method: 'auto',
      instructions: 'Enter code: 69FA-4C72',
    });
    let callbackSignal: AbortSignal | undefined;
    clientMocks.completeProviderAuth.mockImplementation(
      (_body: unknown, options?: { signal?: AbortSignal }) => {
        callbackSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason));
        });
      }
    );
    cleanup = render(() => ModelsPanel(), container!);

    container?.querySelector<HTMLButtonElement>('[aria-label="Add provider"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    dialog?.querySelector<HTMLButtonElement>('.provider-connect-option')?.click();
    dialog?.querySelector<HTMLButtonElement>('.provider-connect-method')?.click();
    findButton(dialog, 'Continue in browser')?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(dialog?.textContent).toContain('Enter code: 69FA-4C72');
    expect(dialog?.querySelector('[aria-label*="Copy authorization code"]')).toBeInstanceOf(
      HTMLButtonElement
    );
    expect(callbackSignal?.aborted).toBe(false);
    dialog?.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click();

    expect(callbackSignal?.aborted).toBe(true);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows a loading indicator long enough to be perceptible', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    window.__sendToExtension = send;
    cleanup = render(() => ModelsPanel(), container!);

    const reloadButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Reload providers"]'
    );
    reloadButton?.click();

    expect(reloadButton?.disabled).toBe(true);
    expect(reloadButton?.classList.contains('is-loading')).toBe(true);
    expect(reloadButton?.getAttribute('aria-label')).toBe('Reloading providers');

    await vi.advanceTimersByTimeAsync(499);
    expect(reloadButton?.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(reloadButton?.disabled).toBe(false);
    expect(reloadButton?.classList.contains('is-loading')).toBe(false);
  });

  it('re-enables provider reload for retry when the refresh remains incomplete', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    window.__sendToExtension = send;
    cleanup = render(() => ModelsPanel(), container!);

    const reloadButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Reload providers"]'
    );
    reloadButton?.click();
    setState('providersLoaded', false);

    await vi.advanceTimersByTimeAsync(500);

    expect(reloadButton?.disabled).toBe(false);
    expect(reloadButton?.getAttribute('aria-label')).toBe('Reload providers');
    reloadButton?.click();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not show a queued notice without running sessions', () => {
    setState('providerRefreshPending', true);
    cleanup = render(() => ModelsPanel(), container!);

    expect(container?.querySelector('.settings-provider-refresh-notice')).toBeNull();
  });

  it('counts only running parent sessions in the queued provider notice', () => {
    setState('providerRefreshPending', true);
    setState('sessions', [
      session('session-1'),
      session('session-2'),
      session('session-3'),
      session('child-1', 'session-1'),
    ]);
    setState('sessionStatus', {
      'session-1': { type: 'busy' },
      'session-2': { type: 'retry', attempt: 1, message: 'Retrying', next: Date.now() },
      'session-3': { type: 'idle' },
      'child-1': { type: 'busy' },
    });
    cleanup = render(() => ModelsPanel(), container!);

    const notice = container?.querySelector<HTMLElement>('.settings-provider-refresh-notice');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain('Configuration update queued.');
    expect(notice?.textContent).toContain('when 2 running agents finish.');

    setState('sessionStatus', 'session-2', { type: 'idle' });
    expect(notice?.textContent).toContain('when 1 running agent finishes.');
  });

  it('labels old and new queued small-model assignments in the model list', async () => {
    setState('sessions', [session('session-1')]);
    setState('sessionStatus', { 'session-1': { type: 'busy' } });
    clientMocks.saveModelRouting.mockImplementation(async () => {
      setState('providerRefreshPending', true);
      return {
        smallModel: { providerID: 'openai', modelID: 'gpt-5' },
        agentModels: { build: { providerID: 'openai', modelID: 'gpt-5' } },
        commitMessageModel: { providerID: 'openai', modelID: 'gpt-5' },
        autoApproveModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
      };
    });
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const nextRow = Array.from(container?.querySelectorAll('.settings-model-row') ?? []).find(
      (item) => item.querySelector('.settings-model-name')?.textContent === 'GPT-5'
    ) as HTMLElement;
    nextRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const assignButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.settings-context-menu-item')
    ).find((item) => item.textContent === 'Use as small model');
    assignButton?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(container?.querySelector('[aria-label="Small model (old)"]')?.textContent).toBe(
      'smallold'
    );
    expect(container?.querySelector('[aria-label="Small model (new)"]')?.textContent).toBe(
      'smallnew'
    );
    expect(container?.querySelector('.settings-provider-refresh-notice')?.textContent).toContain(
      'Old and new assignments are labeled in the model list.'
    );

    setState('providerRefreshPending', false);
    expect(container?.querySelector('[aria-label="Small model (old)"]')).toBeNull();
    expect(container?.querySelector('[aria-label="Small model"]')?.textContent).toBe('small');
  });

  it('labels old and new queued agent assignments in the model list', async () => {
    clientMocks.openCodeConfig.mockResolvedValue({
      smallModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
      agentModels: { review: { providerID: 'openai', modelID: 'gpt-5-mini' } },
      commitMessageModel: null,
      autoApproveModel: null,
    });
    setState('sessions', [session('session-1')]);
    setState('sessionStatus', { 'session-1': { type: 'busy' } });
    clientMocks.saveModelRouting.mockImplementation(async () => {
      setState('providerRefreshPending', true);
      return {
        smallModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
        agentModels: { review: { providerID: 'openai', modelID: 'gpt-5' } },
        commitMessageModel: null,
        autoApproveModel: null,
      };
    });
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const nextRow = Array.from(container?.querySelectorAll('.settings-model-row') ?? []).find(
      (item) => item.querySelector('.settings-model-name')?.textContent === 'GPT-5'
    ) as HTMLElement;
    nextRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const assignButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.settings-context-menu-item')
    ).find((item) => item.textContent === 'Use for review agent');
    assignButton?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(container?.querySelector('[aria-label="Agent model: review (old)"]')?.textContent).toBe(
      'reviewold'
    );
    expect(container?.querySelector('[aria-label="Agent model: review (new)"]')?.textContent).toBe(
      'reviewnew'
    );
  });

  it('strikes through a queued assignment removal instead of labeling it old', async () => {
    setState('sessions', [session('session-1')]);
    setState('sessionStatus', { 'session-1': { type: 'busy' } });
    clientMocks.saveModelRouting.mockImplementation(async () => {
      setState('providerRefreshPending', true);
      return {
        smallModel: null,
        agentModels: { build: { providerID: 'openai', modelID: 'gpt-5' } },
        commitMessageModel: { providerID: 'openai', modelID: 'gpt-5' },
        autoApproveModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
      };
    });
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const currentRow = Array.from(container?.querySelectorAll('.settings-model-row') ?? []).find(
      (item) => item.querySelector('.settings-model-name')?.textContent === 'GPT-5 mini'
    ) as HTMLElement;
    currentRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const removeButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.settings-context-menu-item')
    ).find((item) => item.textContent === "Don't use as small model");
    removeButton?.click();
    await Promise.resolve();
    await Promise.resolve();

    const removedTag = container?.querySelector('[aria-label="Small model (will be removed)"]');
    expect(removedTag?.textContent).toBe('small');
    expect(removedTag?.classList.contains('settings-route-tag-removed')).toBe(true);
    expect(container?.querySelector('[aria-label="Small model (old)"]')).toBeNull();
  });

  it('renders an inline release date for desktop layouts', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const row = Array.from(container?.querySelectorAll('.settings-model-row') ?? []).find(
      (item) => item.querySelector('.settings-model-name')?.textContent === 'GPT-5'
    );
    expect(row?.querySelector('.model-release-date')?.textContent).toBe('2026/01/01');
    expect(row?.querySelector('.settings-model-date-cell')).toBeInstanceOf(HTMLElement);
    expect(row?.querySelector('.settings-model-ctx')?.textContent).toBe('400k');
    expect(row?.querySelector('.settings-model-ctx')?.parentElement?.classList).toContain(
      'settings-model-meta'
    );
    expect(row?.querySelector('.model-default-label')?.textContent).toBe('(default)');
    expect(row?.querySelector('.model-expanded-meta')).toBeNull();

    const rowWithoutDate = Array.from(container?.querySelectorAll('.settings-model-row') ?? []).find(
      (item) => item.querySelector('.settings-model-name')?.textContent === 'GPT-5 mini'
    );
    expect(rowWithoutDate?.querySelector('.settings-model-date-cell')).toBeInstanceOf(HTMLElement);
    expect(rowWithoutDate?.querySelector('.model-release-date')).toBeNull();
    expect(
      rowWithoutDate
        ?.closest('.settings-provider')
        ?.querySelector<HTMLElement>('.settings-model-list')
        ?.style.getPropertyValue('--settings-capability-count')
    ).toBe('2');
  });

  it('shows compact capability icons without hiding universally supported features', async () => {
    setState('providers', 0, 'models', 'gpt-5', 'capabilities', {
      toolcall: true,
      vision: true,
      input: ['text', 'image', 'pdf', 'audio', 'video'],
    });
    setState('providers', 0, 'models', 'gpt-5-mini', 'capabilities', {
      toolcall: true,
      vision: true,
      input: ['text', 'image'],
    });

    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const rows = Array.from(container?.querySelectorAll('.settings-model-row') ?? []);
    const fullRow = rows.find(
      (item) => item.querySelector('.settings-model-name')?.textContent === 'GPT-5'
    );
    const miniRow = rows.find(
      (item) => item.querySelector('.settings-model-name')?.textContent === 'GPT-5 mini'
    );
    const capabilityLabels = Array.from(
      fullRow?.querySelectorAll(
        '.settings-model-badges .model-capability-tag:not(.settings-route-tag)'
      ) ?? []
    ).map((tag) => tag.textContent?.trim());

    expect(capabilityLabels).toEqual(['Tools', 'Vision', 'PDF', 'Audio', 'Video']);
    expect(fullRow?.querySelector('.model-capability-tag-tools')?.getAttribute('title')).toBe(
      'Tools'
    );
    expect(
      fullRow?.querySelector('.model-capability-tag-vision')?.getAttribute('aria-label')
    ).toBe('Vision');
    expect(fullRow?.querySelectorAll('.settings-capability-icon svg')).toHaveLength(5);
    expect(fullRow?.querySelector('.settings-capability-universal')).toBeNull();
    expect(fullRow?.querySelector('.model-capability-tag-audio')).toBeInstanceOf(HTMLElement);
    expect(fullRow?.querySelector('.model-capability-tag-video')).toBeInstanceOf(HTMLElement);
    expect(miniRow?.querySelector('.model-capability-tag-pdf')).toBeNull();
    expect(miniRow?.querySelector('.model-capability-tag-audio')).toBeNull();
    expect(miniRow?.querySelector('.model-capability-tag-video')).toBeNull();
  });

  it('shows routing tags loaded from opencode config and agents', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const tags = Array.from(container?.querySelectorAll('.settings-route-tag') ?? []);
    const labels = tags.map((tag) => tag.getAttribute('aria-label'));
    expect(labels).toEqual(
      expect.arrayContaining([
        'Small model',
        'Agent model: build',
        'Commit message model',
        'Auto-approve model',
      ])
    );
    expect(tags.every((tag) => tag.getAttribute('title') === tag.getAttribute('aria-label'))).toBe(
      true
    );
    expect(tags.map((tag) => tag.textContent)).toEqual(
      expect.arrayContaining(['small', 'commit', 'approve', 'build'])
    );
    expect(tags.map((tag) => tag.className)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('settings-route-tag-small'),
        expect.stringContaining('settings-route-tag-commit'),
        expect.stringContaining('settings-route-tag-approve'),
        expect.stringContaining('settings-route-tag-agent'),
      ])
    );
    expect(tags.every((tag) => tag.parentElement?.classList.contains('settings-model-routes'))).toBe(
      true
    );
    expect(
      tags.every((tag) => tag.closest('.settings-model-name-wrap') instanceof HTMLElement)
    ).toBe(true);
  });

  it('accepts preview routing payloads without normalized agentModels', async () => {
    clientMocks.openCodeConfig.mockResolvedValue({
      small_model: 'openai/gpt-5-mini',
      agent: { review: { model: 'openai/gpt-5' } },
    });

    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    expect(container?.querySelector('[aria-label="Small model"]')).toBeTruthy();
    expect(container?.querySelector('[aria-label="Agent model: review"]')).toBeTruthy();
  });

  it('opens the model context menu and saves a routing assignment', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const row = Array.from(container?.querySelectorAll('.settings-model-row') || []).find(
      (item) => item.querySelector('.settings-model-name')?.textContent === 'GPT-5'
    ) as HTMLElement;
    expect(row).toBeTruthy();

    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 50,
      })
    );

    const menuItems = Array.from(document.querySelectorAll('.settings-context-menu-item'));
    expect(menuItems.map((item) => item.querySelector('strong')?.textContent)).toEqual(
      expect.arrayContaining(['small', 'commit messages', 'auto-approve', 'review'])
    );
    expect(menuItems.some((item) => item.textContent?.includes('Use for build agent'))).toBe(false);
    expect(menuItems.some((item) => item.textContent?.includes('Use for review agent'))).toBe(true);
    expect(
      menuItems.some((item) => item.textContent?.includes("Don't use for commit messages"))
    ).toBe(true);
    expect(menuItems.some((item) => item.textContent?.includes('Use for auto-approve'))).toBe(true);

    const button = menuItems.find((item) =>
      item.textContent?.includes('Use as small model')
    ) as HTMLButtonElement;
    expect(button).toBeTruthy();
    button.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(clientMocks.saveModelRouting).toHaveBeenCalledWith({
      target: 'small_model',
      providerID: 'openai',
      modelID: 'gpt-5',
    });
    expect(refreshRoutingStateMock).toHaveBeenCalled();
  });

  it('shows pinned models and pins or unpins them from the context menu', async () => {
    setState('pinnedModels', ['openai:gpt-5']);
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const row = Array.from(container?.querySelectorAll('.settings-model-row') || []).find(
      (item) => item.querySelector('.settings-model-name')?.textContent === 'GPT-5'
    ) as HTMLElement;
    expect(row.querySelector('[aria-label="Pinned model"]')).not.toBeNull();

    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const menu = document.querySelector('.settings-context-menu') as HTMLElement;
    const unpinButton = Array.from(
      menu.querySelectorAll<HTMLButtonElement>('.settings-context-menu-item')
    ).find((item) => item.textContent === 'Unpin model');
    expect(unpinButton).toBeTruthy();
    expect(menu.children[0]).toBe(unpinButton);
    expect(menu.children[1]?.getAttribute('role')).toBe('separator');

    unpinButton?.click();
    await Promise.resolve();
    expect(row.querySelector('[aria-label="Pinned model"]')).toBeNull();
    expect(document.querySelector('.settings-context-menu')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.pinnedModels)!)).toEqual([]);

    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const pinButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.settings-context-menu-item')
    ).find((item) => item.textContent === 'Pin model');
    pinButton?.click();
    await Promise.resolve();

    expect(row.querySelector('[aria-label="Pinned model"]')).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.pinnedModels)!)).toEqual([
      'openai:gpt-5',
    ]);
  });

  it('reverses assigned model actions and unsets the routing assignment', async () => {
    clientMocks.openCodeConfig.mockResolvedValue({
      smallModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
      agentModels: { review: { providerID: 'openai', modelID: 'gpt-5-mini' } },
      commitMessageModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
      autoApproveModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
    });
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const row = Array.from(container?.querySelectorAll('.settings-model-row') || []).find(
      (item) => item.querySelector('.settings-model-name')?.textContent === 'GPT-5 mini'
    ) as HTMLElement;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    const menuItems = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.settings-context-menu-item')
    );
    expect(menuItems.map((item) => item.textContent)).toEqual(
      expect.arrayContaining([
        "Don't use as small model",
        "Don't use for commit messages",
        "Don't use for auto-approve",
        "Don't use for review agent",
      ])
    );

    menuItems.find((item) => item.textContent === "Don't use as small model")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(clientMocks.saveModelRouting).toHaveBeenCalledWith({
      target: 'small_model',
      providerID: 'openai',
      modelID: 'gpt-5-mini',
      unset: true,
    });
  });

  it('shows workspace status', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();
    await Promise.resolve();

    expect(container?.textContent).toContain('Workspaces: ws-1 (connected)');
    expect(refreshRoutingStateMock).toHaveBeenCalled();
    expect(clientMocks.providerAuth).not.toHaveBeenCalled();
    expect(clientMocks.workspaceStatus).not.toHaveBeenCalled();
  });

  it('collapses providers with no enabled models', async () => {
    setState('hiddenProviders', ['openai']);

    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    expect(container?.textContent).toContain('OpenAI0/2');
    expect(container?.querySelector('.settings-chevron')?.classList.contains('expanded')).toBe(
      false
    );
    expect(container?.querySelector('.settings-model-row')).toBeNull();
  });

  it('keeps provider priority order unchanged when providers are toggled', async () => {
    setState('providers', [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          openai: {
            id: 'openai',
            name: 'OpenAI model',
            capabilities: { toolcall: true },
            cost: { input: 1, output: 1 },
          },
        },
      },
      {
        id: 'alpha',
        name: 'Alpha',
        source: 'api',
        models: {
          alpha: {
            id: 'alpha',
            name: 'Alpha model',
            capabilities: { toolcall: true },
            cost: { input: 1, output: 1 },
          },
        },
      },
      {
        id: 'beta',
        name: 'Beta',
        source: 'api',
        models: {
          beta: {
            id: 'beta',
            name: 'Beta model',
            capabilities: { toolcall: true },
            cost: { input: 1, output: 1 },
          },
        },
      },
    ]);
    setState('hiddenProviders', ['alpha']);
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const providerNames = () =>
      Array.from(container?.querySelectorAll('.settings-provider-name') ?? []).map(
        (item) => item.textContent
      );
    expect(providerNames()).toEqual(['OpenAI', 'Alpha', 'Beta']);

    const betaSection = Array.from(
      container?.querySelectorAll<HTMLElement>('.settings-provider') ?? []
    ).find((section) => section.querySelector('.settings-provider-name')?.textContent === 'Beta');
    betaSection?.querySelector<HTMLInputElement>('.settings-checkbox')?.click();
    await Promise.resolve();

    expect(providerNames()).toEqual(['OpenAI', 'Alpha', 'Beta']);

    const alphaSection = Array.from(
      container?.querySelectorAll<HTMLElement>('.settings-provider') ?? []
    ).find((section) => section.querySelector('.settings-provider-name')?.textContent === 'Alpha');
    alphaSection?.querySelector<HTMLInputElement>('.settings-checkbox')?.click();
    await Promise.resolve();

    expect(providerNames()).toEqual(['OpenAI', 'Alpha', 'Beta']);
  });
});

function findButton(root: ParentNode | null | undefined, text: string) {
  return Array.from(root?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (button) => button.textContent?.trim() === text
  );
}
