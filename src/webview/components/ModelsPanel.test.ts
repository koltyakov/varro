import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { setState } from '../lib/state';
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
  setState('sessionStatus', {});
  setState('agents', []);
  setState('allAgents', []);
  setState('providerAuthMethods', {});
  setState('workspaceStatuses', []);
  setState('hiddenProviders', []);
  setState('hiddenModels', []);
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

  it('opens provider logout from the minus button', () => {
    cleanup = render(() => ModelsPanel(), container!);

    const logoutButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Log out provider"]'
    );
    logoutButton?.click();

    expect(logoutButton).toBeInstanceOf(HTMLButtonElement);
    expect(providerSetupMocks.openProviderLogout).toHaveBeenCalledOnce();
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

  it('explains when provider changes are waiting for active work', () => {
    setState('providerRefreshPending', true);
    cleanup = render(() => ModelsPanel(), container!);

    const notice = container?.querySelector<HTMLElement>('.settings-provider-refresh-notice');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain('Provider update queued.');
    expect(notice?.textContent).toContain(
      'Changes will appear automatically when active work finishes.'
    );

    setState('providerRefreshPending', false);
    expect(container?.querySelector('.settings-provider-refresh-notice')).toBeNull();
  });

  it('updates the number of running agents in the queued provider notice', () => {
    setState('providerRefreshPending', true);
    setState('sessionStatus', {
      'session-1': { type: 'busy' },
      'session-2': { type: 'retry', attempt: 1, message: 'Retrying', next: Date.now() },
      'session-3': { type: 'idle' },
    });
    cleanup = render(() => ModelsPanel(), container!);

    const notice = container?.querySelector<HTMLElement>('.settings-provider-refresh-notice');
    expect(notice?.textContent).toContain('when 2 running agents finish.');

    setState('sessionStatus', 'session-2', { type: 'idle' });
    expect(notice?.textContent).toContain('when 1 running agent finishes.');
  });

  it('renders an inline release date for desktop layouts', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const row = Array.from(container?.querySelectorAll('.settings-model-row') ?? []).find(
      (item) => item.querySelector('.settings-model-name')?.textContent === 'GPT-5'
    );
    expect(row?.querySelector('.model-release-date')?.textContent).toBe('2026/01/01');
    expect(row?.querySelector('.model-default-label')?.textContent).toBe('(default)');
    expect(row?.querySelector('.model-expanded-meta')).toBeNull();
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
      expect.arrayContaining(['small', 'commit', 'auto', 'build'])
    );
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
    expect(menuItems.some((item) => item.textContent?.includes('Use for commit messages'))).toBe(
      true
    );
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
});
