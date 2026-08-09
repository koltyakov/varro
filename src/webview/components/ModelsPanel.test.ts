import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { Session } from '../types';
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
});
