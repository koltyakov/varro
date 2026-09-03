import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import type { Provider, Session } from '../types';
import {
  markProviderAuthFailure,
  resetProviderConnectionState,
} from '../lib/provider-connection-state';
import { setState, state } from '../lib/state';
import { STORAGE_KEYS } from '../lib/state-storage';
import { fixture } from '../test-fixtures';
import { ModelsPanel } from './ModelsPanel';

type TestRuntimeValue =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | TestRuntimeObject
  | readonly TestRuntimeValue[];
interface TestRuntimeObject {
  readonly [key: string]: TestRuntimeValue;
  readonly type?: string;
  readonly id?: string | number;
  readonly message?: string;
}

declare global {
  interface Window {
    __sendToExtension?: (message: TestRuntimeValue) => void;
  }
}

const clientMocks = vi.hoisted(() => ({
  openCodeConfig: vi.fn(),
  saveModelRouting: vi.fn(),
  providers: vi.fn(),
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

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise ModelsPanel integration with client, setup, and hook modules. */
vi.mock('../lib/client', () => ({
  client: {
    varro: {
      openCodeConfig: clientMocks.openCodeConfig,
      saveModelRouting: clientMocks.saveModelRouting,
    },
    config: {
      providers: clientMocks.providers,
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
  const value: Session = {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: id,
    version: '1',
    time: { created: 1, updated: 1 },
  };
  if (parentID) value.parentID = parentID;
  return value;
}

function createModels(count: number) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const id = `model-${index}`;
      return [
        id,
        {
          id,
          name: `Model ${index}`,
          capabilities: { toolcall: true },
          cost: { input: 1, output: 1 },
        },
      ];
    })
  );
}

function createDragDataTransfer() {
  const values = new Map<string, string>();
  // SAFETY: The fixture provides the DataTransfer fields exercised by these drag tests.
  return fixture<DataTransfer>({
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    setData(type: string, value: string) {
      values.set(type, value);
    },
    getData(type: string) {
      return values.get(type) ?? '';
    },
    setDragImage: vi.fn(),
  });
}

function dispatchDragEvent(target: Element, type: string, dataTransfer: DataTransfer) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  target.dispatchEvent(event);
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  delete window.__sendToExtension;
  originalResizeObserver = globalThis.ResizeObserver;
  // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
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
  clientMocks.providers.mockImplementation(async () => ({
    providers: state.providers.map((provider): Provider => ({
      ...provider,
      models: { ...provider.models },
    })),
    default: { ...state.providerDefaults },
    defaultModel: null,
  }));
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
  setState('providerOrder', []);
  setState('modelOrder', []);
  setState('addedModels', []);
  setState('pinnedModels', []);
  setState('modelDisplayNames', {});
  window.localStorage.removeItem(STORAGE_KEYS.pinnedModels);
  window.localStorage.removeItem(STORAGE_KEYS.addedModels);
  window.localStorage.removeItem(STORAGE_KEYS.modelDisplayNames);
  window.localStorage.removeItem(STORAGE_KEYS.hiddenProviders);
  window.localStorage.removeItem(STORAGE_KEYS.hiddenModels);
  window.localStorage.removeItem(STORAGE_KEYS.providerOrder);
  window.localStorage.removeItem(STORAGE_KEYS.modelOrder);
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
  setState('providerOrder', []);
  setState('modelOrder', []);
  setState('addedModels', []);
  setState('pinnedModels', []);
  setState('modelDisplayNames', {});
  window.localStorage.removeItem(STORAGE_KEYS.pinnedModels);
  window.localStorage.removeItem(STORAGE_KEYS.addedModels);
  window.localStorage.removeItem(STORAGE_KEYS.modelDisplayNames);
  window.localStorage.removeItem(STORAGE_KEYS.hiddenProviders);
  window.localStorage.removeItem(STORAGE_KEYS.hiddenModels);
  window.localStorage.removeItem(STORAGE_KEYS.providerOrder);
  window.localStorage.removeItem(STORAGE_KEYS.modelOrder);
  setState('providerAuthMethods', reconcile({}));
  resetProviderConnectionState();
  if (originalResizeObserver) {
    globalThis.ResizeObserver = originalResizeObserver;
  }
  vi.restoreAllMocks();
});

describe('ModelsPanel', () => {
  it('keeps large catalogs out of the model list until models are added', async () => {
    const template = {
      capabilities: { toolcall: true },
      cost: { input: 1, output: 1 },
    };
    setState('providers', [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        source: 'api',
        models: Object.fromEntries(
          Array.from({ length: 101 }, (_, index) => {
            const id = `model-${index}`;
            return [id, { ...template, id, name: `Model ${index}` }];
          })
        ),
      },
    ]);
    setState('providerDefaults', {});
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    expect(container?.querySelectorAll('.models-model-row')).toHaveLength(0);
    expect(container?.querySelector('.models-provider-count')?.textContent).toBe('0 added');

    findButton(container, 'Add models')?.click();
    const dialog = document.body.querySelector<HTMLElement>('.models-model-catalog-dialog');
    expect(dialog?.textContent).toContain('Refreshing model catalog...');
    expect(
      dialog?.querySelector<HTMLInputElement>('[aria-label="Search OpenRouter models"]')?.disabled
    ).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(dialog?.querySelectorAll('.models-model-catalog-row')).toHaveLength(0);
    expect(dialog?.textContent).toContain('Search 101 available models');
    expect(clientMocks.providers).toHaveBeenCalledOnce();

    const search = dialog?.querySelector<HTMLInputElement>(
      '[aria-label="Search OpenRouter models"]'
    );
    if (search) {
      search.value = 'model-100';
      search.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    const result = dialog?.querySelector<HTMLElement>('.models-model-catalog-row');
    expect(result?.textContent).toContain('Model 100');
    result?.querySelector<HTMLInputElement>('.models-checkbox')?.click();
    await Promise.resolve();

    expect(container?.querySelector('.models-provider-count')?.textContent).toBe('0 added');
    expect(window.localStorage.getItem(STORAGE_KEYS.addedModels)).toBeNull();
    expect(dialog?.textContent).toContain('1 unsaved change');
    findButton(dialog, 'Save changes')?.click();
    await Promise.resolve();

    expect(container?.querySelector('.models-provider-count')?.textContent).toBe('1 added');
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.addedModels)!)).toEqual([
      'openrouter:model-100',
    ]);

    await Promise.resolve();
    expect(container?.querySelectorAll('.models-model-row')).toHaveLength(1);
    expect(container?.querySelector('.models-model-row')?.textContent).toContain('Model 100');

    container
      ?.querySelector<HTMLElement>('.models-model-row')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    findButton(document, 'Hide model')?.click();
    await Promise.resolve();

    expect(container?.querySelectorAll('.models-model-row')).toHaveLength(0);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.addedModels)!)).toEqual([]);
  });

  it('discards pending model catalog changes when cancelled', async () => {
    const template = {
      capabilities: { toolcall: true },
      cost: { input: 1, output: 1 },
    };
    setState('providers', [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        source: 'api',
        models: Object.fromEntries(
          Array.from({ length: 51 }, (_, index) => {
            const id = `model-${index}`;
            return [id, { ...template, id, name: `Model ${index}` }];
          })
        ),
      },
    ]);
    cleanup = render(() => ModelsPanel(), container!);

    findButton(container, 'Add models')?.click();
    const dialog = document.body.querySelector<HTMLElement>('.models-model-catalog-dialog');
    await Promise.resolve();
    await Promise.resolve();
    const search = dialog?.querySelector<HTMLInputElement>(
      '[aria-label="Search OpenRouter models"]'
    );
    if (search) {
      search.value = 'model-50';
      search.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    dialog?.querySelector<HTMLInputElement>('.models-checkbox')?.click();
    findButton(dialog, 'Cancel')?.click();

    expect(document.body.querySelector('.models-model-catalog-dialog')).toBeNull();
    expect(container?.querySelector('.models-provider-count')?.textContent).toBe('0 added');
    expect(window.localStorage.getItem(STORAGE_KEYS.addedModels)).toBeNull();
  });

  it('replaces a cached large catalog with the freshly loaded models', async () => {
    setState('providers', [
      { id: 'openrouter', name: 'OpenRouter', source: 'api', models: createModels(360) },
    ]);
    clientMocks.providers.mockResolvedValue({
      providers: [
        { id: 'openrouter', name: 'OpenRouter', source: 'api', models: createModels(541) },
      ],
      default: {},
      defaultModel: null,
    });
    cleanup = render(() => ModelsPanel(), container!);

    findButton(container, 'Add models')?.click();
    const dialog = document.body.querySelector<HTMLElement>('.models-model-catalog-dialog');
    expect(dialog?.textContent).toContain('Refreshing available models...');

    await Promise.resolve();
    await Promise.resolve();

    expect(dialog?.textContent).toContain('Search 541 available models');
    expect(Object.keys(state.providers[0]?.models ?? {})).toHaveLength(541);
  });

  it('labels the Claude Fast lightning symbol on hover', async () => {
    setState('providers', 0, 'models', 'gpt-5', 'name', 'Claude Opus 5 Fast');
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const fastSymbol = container?.querySelector(
      '.models-model-name [aria-label="Fast mode may consume usage limits faster and cost more."]'
    );
    expect(fastSymbol?.textContent).toBe('⚡');
  });

  it('hides providers without matching search results', async () => {
    setState('providers', [
      ...state.providers,
      {
        id: 'xai',
        name: 'xAI',
        source: 'api',
        models: {
          grok: {
            id: 'grok',
            name: 'Grok 4.6',
            capabilities: { toolcall: true },
            cost: { input: 1, output: 1 },
          },
        },
      },
    ]);
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const search = container?.querySelector<HTMLInputElement>(
      '[aria-label="Filter providers or models"]'
    );
    if (search) {
      search.value = 'grok';
      search.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }

    expect(
      Array.from(container?.querySelectorAll('.models-provider-name') ?? []).map(
        (item) => item.textContent
      )
    ).toEqual(['xAI']);
    expect(container?.querySelector('.models-model-name')?.textContent).toBe('Grok 4.6');
  });

  it('opens provider actions and requests a list refresh', () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    cleanup = render(() => ModelsPanel(), container!);

    const actionsButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Provider actions"]'
    );
    expect(actionsButton?.getAttribute('aria-haspopup')).toBe('menu');
    expect(actionsButton?.querySelector('.models-provider-actions-icon')).toBeInstanceOf(
      HTMLSpanElement
    );
    actionsButton?.click();
    const menu = container?.querySelector('[role="menu"]');
    expect(
      Array.from(menu?.querySelectorAll('[role="menuitem"]') ?? []).map((item) => item.textContent)
    ).toEqual(['Add provider', 'Disconnect provider', 'Refresh list', 'Reset provider order']);
    expect(findButton(menu, 'Reset provider order')?.disabled).toBe(true);
    findButton(menu, 'Refresh list')?.click();

    expect(actionsButton).toBeInstanceOf(HTMLButtonElement);
    expect(actionsButton?.getAttribute('aria-expanded')).toBe('false');
    expect(send).toHaveBeenCalledWith({ type: 'providers/refresh' });
  });

  it('resets a custom provider order from provider actions', () => {
    setState('providerOrder', ['openai']);
    cleanup = render(() => ModelsPanel(), container!);

    container?.querySelector<HTMLButtonElement>('[aria-label="Provider actions"]')?.click();
    const menu = container?.querySelector('[role="menu"]');
    const resetButton = findButton(container, 'Reset provider order');

    expect(resetButton?.disabled).toBe(false);
    expect(menu?.querySelector('[role="menuitem"]:last-child')).toBe(resetButton);
    resetButton?.click();

    expect(resetButton).toBeInstanceOf(HTMLButtonElement);
    expect(state.providerOrder).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.providerOrder)!)).toEqual([]);
    expect(container?.querySelector('[role="menu"]')).toBeNull();
  });

  it('opens the embedded disconnect dialog from provider actions', async () => {
    cleanup = render(() => ModelsPanel(), container!);

    container?.querySelector<HTMLButtonElement>('[aria-label="Provider actions"]')?.click();
    const logoutButton = findButton(container, 'Disconnect provider');
    logoutButton?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(logoutButton).toBeInstanceOf(HTMLButtonElement);
    expect(document.body.textContent).toContain('Disconnect provider');
    expect(providerSetupMocks.openProviderLogout).not.toHaveBeenCalled();
  });

  it('opens a provider context menu and preselects that provider for deletion', async () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    clientMocks.openCodeConfig.mockResolvedValue({
      smallModel: null,
      agentModels: {},
      commitMessageModel: null,
      autoApproveModel: null,
      providerConfigPaths: { openai: ['/Users/test/.config/opencode/opencode.json'] },
    });
    clientMocks.providerCatalog.mockResolvedValue({
      all: [{ id: 'openai', name: 'OpenAI', source: 'config', models: {} }],
      default: {},
      connected: ['openai'],
    });
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    container
      ?.querySelector<HTMLElement>('.models-provider-header')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const deleteButton = findButton(document.body, 'Disconnect provider');
    const resetButton = findButton(document.body, 'Reset model order');
    deleteButton?.click();
    await Promise.resolve();
    await Promise.resolve();

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
    expect(resetButton?.disabled).toBe(true);
    expect(dialog?.textContent).toContain('OpenAI');
    expect(dialog?.textContent).toContain('Remove the saved credential for OpenAI?');
    expect(dialog?.textContent).toContain('configured in OpenCode config');
    expect(dialog?.querySelector('.provider-connect-options')).toBeNull();
    findButton(dialog, 'Open opencode.json')?.click();
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: {
        path: '/Users/test/.config/opencode/opencode.json',
        kind: 'file',
      },
    });
  });

  it('hides and shows a provider from its context menu', async () => {
    setState('hiddenModels', ['openai:gpt-5-mini']);
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const providerHeader = container?.querySelector<HTMLElement>('.models-provider-header');
    providerHeader?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );
    findButton(document.body, 'Hide provider')?.click();

    expect(state.hiddenProviders).toEqual(['openai']);
    expect(state.hiddenModels).toEqual(['openai:gpt-5-mini']);
    expect(providerHeader?.querySelector('.models-provider-hidden-marker')?.textContent).toBe(
      'Hidden'
    );
    expect(providerHeader?.querySelector('.models-chevron')?.classList.contains('expanded')).toBe(
      false
    );
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.hiddenProviders)!)).toEqual([
      'openai',
    ]);

    providerHeader?.querySelector<HTMLButtonElement>('.models-provider-toggle')?.click();
    expect(
      Array.from(
        container?.querySelectorAll<HTMLInputElement>('.models-model-row input') ?? []
      ).map((input) => input.checked)
    ).toEqual([true, false]);

    providerHeader?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );
    findButton(document.body, 'Show provider')?.click();

    expect(state.hiddenProviders).toEqual([]);
    expect(state.hiddenModels).toEqual(['openai:gpt-5-mini']);
    expect(providerHeader?.querySelector('.models-provider-hidden-marker')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.hiddenProviders)!)).toEqual([]);
  });

  it('resets a provider model order from its context menu', async () => {
    setState('modelOrder', ['openai:gpt-5-mini', 'openai:gpt-5']);
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    expect(
      Array.from(container?.querySelectorAll('.models-model-name') ?? []).map(
        (item) => item.textContent
      )
    ).toEqual(['GPT-5 mini', 'GPT-5']);
    container
      ?.querySelector<HTMLElement>('.models-provider-header')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const menu = document.body.querySelector('.models-provider-context-menu');
    const resetButton = findButton(document.body, 'Reset model order');

    expect(resetButton?.disabled).toBe(false);
    expect(menu?.querySelector('button:last-child')).toBe(resetButton);
    resetButton?.click();

    expect(resetButton).toBeInstanceOf(HTMLButtonElement);
    expect(state.modelOrder).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.modelOrder)!)).toEqual([]);
    expect(
      Array.from(container?.querySelectorAll('.models-model-name') ?? []).map(
        (item) => item.textContent
      )
    ).toEqual(['GPT-5', 'GPT-5 mini']);
  });

  it('shows but disables provider deletion for OpenCode Zen', () => {
    setState('providers', [
      {
        id: 'opencode',
        name: 'OpenCode Zen',
        source: 'api',
        models: {
          'claude-opus': {
            id: 'claude-opus',
            name: 'Claude Opus',
            capabilities: { toolcall: true },
            cost: { input: 1, output: 1 },
          },
        },
      },
    ]);
    cleanup = render(() => ModelsPanel(), container!);

    container
      ?.querySelector<HTMLElement>('.models-provider-header')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const deleteButton = findButton(document.body, 'Disconnect provider');

    expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
    expect(deleteButton?.disabled).toBe(true);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('opens config guidance for a provider without a saved credential', async () => {
    clientMocks.openCodeConfig.mockResolvedValue({
      smallModel: null,
      agentModels: {},
      commitMessageModel: null,
      autoApproveModel: null,
      providerConfigPaths: { custom: ['/repo/opencode.jsonc'] },
    });
    clientMocks.providerCatalog.mockResolvedValue({
      all: [{ id: 'custom', name: 'Custom', source: 'config', models: {} }],
      default: {},
      connected: [],
    });
    setState('providers', [
      {
        id: 'custom',
        name: 'Custom',
        source: 'config',
        models: {
          model: {
            id: 'model',
            name: 'Model',
            capabilities: { toolcall: true },
            cost: { input: 1, output: 1 },
          },
        },
      },
    ]);
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    container
      ?.querySelector<HTMLElement>('.models-provider-header')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    findButton(document.body, 'Disconnect provider')?.click();
    await Promise.resolve();
    await Promise.resolve();

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('has no saved credential to disconnect');
    expect(findButton(dialog, 'Open opencode.jsonc')).toBeInstanceOf(HTMLButtonElement);
    expect(findButton(dialog, 'Disconnect')).toBeUndefined();
  });

  it('explains when environment credentials keep a provider connected', async () => {
    clientMocks.providerCatalog.mockResolvedValue({
      all: [
        {
          id: 'amazon-bedrock',
          name: 'Amazon Bedrock',
          source: 'env',
          env: ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID'],
          models: {},
        },
      ],
      default: {},
      connected: ['amazon-bedrock'],
    });
    setState('providers', [
      {
        id: 'amazon-bedrock',
        name: 'Amazon Bedrock',
        source: 'env',
        env: ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID'],
        models: {
          model: {
            id: 'model',
            name: 'Model',
            capabilities: { toolcall: true },
            cost: { input: 1, output: 1 },
          },
        },
      },
    ]);
    cleanup = render(() => ModelsPanel(), container!);

    container
      ?.querySelector<HTMLElement>('.models-provider-header')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    findButton(document.body, 'Disconnect provider')?.click();
    await Promise.resolve();
    await Promise.resolve();

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('supplied by environment credentials');
    expect(dialog?.textContent).toContain('AWS_PROFILE, AWS_ACCESS_KEY_ID');
  });

  it('uses terminal provider actions on Option-click', () => {
    cleanup = render(() => ModelsPanel(), container!);

    const actionsButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Provider actions"]'
    );
    actionsButton?.click();
    const addButton = findButton(container, 'Add provider');
    addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    actionsButton?.click();
    const removeButton = findButton(container, 'Disconnect provider');
    removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));

    expect(addButton).toBeInstanceOf(HTMLButtonElement);
    expect(providerSetupMocks.openProviderSetup).toHaveBeenCalledOnce();
    expect(providerSetupMocks.openProviderLogout).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('disconnects the selected provider credential and reports the auth change', async () => {
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

    openProviderAction(container, 'Disconnect provider')?.click();
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
    expect(send).toHaveBeenCalledWith({ type: 'providers/auth-changed' });
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

    const button = openProviderAction(container, 'Add provider');
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
    expect(container?.querySelector('.models-model-row')).toBeNull();
    expect(container?.querySelector('.models-provider-count')?.textContent).toBe('Reconnect');
  });

  it('connects an API provider from the embedded dialog', async () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    cleanup = render(() => ModelsPanel(), container!);

    openProviderAction(container, 'Add provider')?.click();
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
    expect(send).toHaveBeenCalledWith({ type: 'providers/auth-changed' });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('returns to auth methods when credential entry is cancelled', async () => {
    cleanup = render(() => ModelsPanel(), container!);

    openProviderAction(container, 'Add provider')?.click();
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

    openProviderAction(container, 'Add provider')?.click();
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

    openProviderAction(container, 'Add provider')?.click();
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

    openProviderAction(container, 'Add provider')?.click();
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
      (_body: TestRuntimeValue, options?: { signal?: AbortSignal }) => {
        callbackSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason));
        });
      }
    );
    cleanup = render(() => ModelsPanel(), container!);

    openProviderAction(container, 'Add provider')?.click();
    await Promise.resolve();
    await Promise.resolve();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    dialog?.querySelector<HTMLButtonElement>('.provider-connect-option')?.click();
    dialog?.querySelector<HTMLButtonElement>('.provider-connect-method')?.click();
    findButton(dialog, 'Continue')?.click();
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

    const actionsButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Provider actions"]'
    );
    actionsButton?.click();
    findButton(container, 'Refresh list')?.click();

    expect(actionsButton?.getAttribute('aria-busy')).toBe('true');

    await vi.advanceTimersByTimeAsync(499);
    expect(actionsButton?.getAttribute('aria-busy')).toBe('true');

    await vi.advanceTimersByTimeAsync(1);
    expect(actionsButton?.getAttribute('aria-busy')).toBe('false');
  });

  it('re-enables provider reload for retry when the refresh remains incomplete', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    window.__sendToExtension = send;
    cleanup = render(() => ModelsPanel(), container!);

    const actionsButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Provider actions"]'
    );
    actionsButton?.click();
    findButton(container, 'Refresh list')?.click();
    setState('providersLoaded', false);

    await vi.advanceTimersByTimeAsync(500);

    expect(actionsButton?.getAttribute('aria-busy')).toBe('false');
    actionsButton?.click();
    findButton(container, 'Refresh list')?.click();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('shows provider refresh progress without running sessions', () => {
    setState('providerRefreshPending', true);
    cleanup = render(() => ModelsPanel(), container!);

    expect(container?.querySelector('.models-provider-refresh-notice')?.textContent).toContain(
      'Refreshing provider configuration.'
    );
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

    const notice = container?.querySelector<HTMLElement>('.models-provider-refresh-notice');
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

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const nextRow = Array.from(container?.querySelectorAll('.models-model-row') ?? []).find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5'
    ) as HTMLElement;
    nextRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const assignButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.models-context-menu-item')
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
    expect(container?.querySelector('.models-provider-refresh-notice')?.textContent).toContain(
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

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const nextRow = Array.from(container?.querySelectorAll('.models-model-row') ?? []).find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5'
    ) as HTMLElement;
    nextRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const assignButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.models-context-menu-item')
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

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const currentRow = Array.from(container?.querySelectorAll('.models-model-row') ?? []).find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5 mini'
    ) as HTMLElement;
    currentRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const removeButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.models-context-menu-item')
    ).find((item) => item.textContent === "Don't use as small model");
    removeButton?.click();
    await Promise.resolve();
    await Promise.resolve();

    const removedTag = container?.querySelector('[aria-label="Small model (will be removed)"]');
    expect(removedTag?.textContent).toBe('small');
    expect(removedTag?.classList.contains('models-route-tag-removed')).toBe(true);
    expect(container?.querySelector('[aria-label="Small model (old)"]')).toBeNull();
  });

  it('renders an inline release date for desktop layouts', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const row = Array.from(container?.querySelectorAll('.models-model-row') ?? []).find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5'
    );
    expect(row?.querySelector('.model-release-date')?.textContent).toBe('2026/01/01');
    expect(
      row
        ?.querySelector<HTMLElement>('.model-release-date .ui-icon')
        ?.style.getPropertyValue('--ui-icon-width')
    ).toBe('13px');
    expect(row?.querySelector('.models-model-date-cell')).toBeInstanceOf(HTMLElement);
    expect(row?.querySelector('.models-model-ctx')?.textContent).toBe('400k');
    expect(row?.querySelector('.models-model-ctx')?.parentElement?.classList).toContain(
      'models-model-meta'
    );
    expect(row?.querySelector('.model-default-label')?.textContent).toBe('(default)');
    expect(row?.querySelector('.model-expanded-meta')).toBeNull();

    const rowWithoutDate = Array.from(container?.querySelectorAll('.models-model-row') ?? []).find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5 mini'
    );
    expect(rowWithoutDate?.querySelector('.models-model-date-cell')).toBeInstanceOf(HTMLElement);
    expect(rowWithoutDate?.querySelector('.model-release-date')).toBeNull();
    expect(
      rowWithoutDate
        ?.closest('.models-provider')
        ?.querySelector<HTMLElement>('.models-model-list')
        ?.style.getPropertyValue('--models-capability-count')
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

    const rows = Array.from(container?.querySelectorAll('.models-model-row') ?? []);
    const fullRow = rows.find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5'
    );
    const miniRow = rows.find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5 mini'
    );
    const capabilityLabels = Array.from(
      fullRow?.querySelectorAll(
        '.models-model-badges .model-capability-tag:not(.models-route-tag)'
      ) ?? []
    ).map((tag) => tag.textContent?.trim());

    expect(capabilityLabels).toEqual(['Tools', 'Vision', 'PDF', 'Audio', 'Video']);
    expect(fullRow?.querySelector('.model-capability-tag-tools')?.getAttribute('aria-label')).toBe(
      'Tools'
    );
    expect(fullRow?.querySelector('.model-capability-tag-vision')?.getAttribute('aria-label')).toBe(
      'Vision'
    );
    expect(fullRow?.querySelectorAll('.models-capability-icon .ui-icon')).toHaveLength(0);
    expect(fullRow?.querySelectorAll('.models-capability-icon svg')).toHaveLength(5);
    expect(fullRow?.querySelector('.models-capability-universal')).toBeNull();
    expect(fullRow?.querySelector('.model-capability-tag-audio')).toBeInstanceOf(HTMLElement);
    expect(fullRow?.querySelector('.model-capability-tag-video')).toBeInstanceOf(HTMLElement);
    expect(miniRow?.querySelector('.model-capability-tag-pdf')).toBeNull();
    expect(miniRow?.querySelector('.model-capability-tag-audio')).toBeNull();
    expect(miniRow?.querySelector('.model-capability-tag-video')).toBeNull();
  });

  it('shows routing tags loaded from opencode config and agents', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const tags = Array.from(container?.querySelectorAll('.models-route-tag') ?? []);
    const labels = tags.map((tag) => tag.getAttribute('aria-label'));
    expect(labels).toEqual(
      expect.arrayContaining([
        'Small model',
        'Agent model: build',
        'Commit message model',
        'Auto-approve model',
      ])
    );
    expect(tags.every((tag) => tag.getAttribute('aria-label'))).toBe(true);
    expect(tags.every((tag) => !tag.hasAttribute('title'))).toBe(true);
    expect(tags.map((tag) => tag.textContent)).toEqual(
      expect.arrayContaining(['small', 'commit', 'approve', 'build'])
    );
    expect(tags.map((tag) => tag.className)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('models-route-tag-small'),
        expect.stringContaining('models-route-tag-commit'),
        expect.stringContaining('models-route-tag-approve'),
        expect.stringContaining('models-route-tag-agent'),
      ])
    );
    expect(tags.every((tag) => tag.parentElement?.classList.contains('models-model-routes'))).toBe(
      true
    );
    expect(tags.every((tag) => tag.closest('.models-model-name-wrap') instanceof HTMLElement)).toBe(
      true
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

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const row = Array.from(container?.querySelectorAll('.models-model-row') || []).find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5'
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

    const menuItems = Array.from(document.querySelectorAll('.models-context-menu-item'));
    expect(menuItems.map((item) => item.querySelector('strong')?.textContent)).toEqual(
      expect.arrayContaining(['small', 'commit messages', 'auto-approve', 'review'])
    );
    expect(menuItems.some((item) => item.textContent?.includes('Use for build agent'))).toBe(false);
    expect(menuItems.some((item) => item.textContent?.includes('Use for review agent'))).toBe(true);
    expect(
      menuItems.some((item) => item.textContent?.includes("Don't use for commit messages"))
    ).toBe(true);
    expect(menuItems.some((item) => item.textContent?.includes('Use for auto-approve'))).toBe(true);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
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

  it('keeps the model context menu inside the viewport', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(220);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(500);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(300);
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const row = container?.querySelector<HTMLElement>('.models-model-row');
    row?.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 490,
        clientY: 290,
      })
    );
    await Promise.resolve();

    const menu = document.querySelector<HTMLElement>('.models-context-menu');
    expect(menu?.style.left).toBe('272px');
    expect(menu?.style.top).toBe('52px');
  });

  it('shows pinned models and pins or unpins them from the context menu', async () => {
    setState('pinnedModels', ['openai:gpt-5']);
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const row = Array.from(container?.querySelectorAll('.models-model-row') || []).find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5'
    ) as HTMLElement;
    expect(row.querySelector('[aria-label="Pinned model"]')).not.toBeNull();

    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const menu = document.querySelector('.models-context-menu') as HTMLElement;
    const unpinButton = Array.from(
      menu.querySelectorAll<HTMLButtonElement>('.models-context-menu-item')
    ).find((item) => item.textContent === 'Unpin model');
    expect(unpinButton).toBeTruthy();
    expect(menu.children[0]).toBe(unpinButton);
    expect(menu.children[1]?.textContent).toBe('Rename model');
    expect(menu.children[2]?.textContent).toBe('Hide model');
    expect(menu.children[3]?.getAttribute('role')).toBe('separator');

    unpinButton?.click();
    await Promise.resolve();
    expect(row.querySelector('[aria-label="Pinned model"]')).toBeNull();
    expect(document.querySelector('.models-context-menu')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.pinnedModels)!)).toEqual([]);

    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const pinButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.models-context-menu-item')
    ).find((item) => item.textContent === 'Pin model');
    pinButton?.click();
    await Promise.resolve();

    expect(row.querySelector('[aria-label="Pinned model"]')).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.pinnedModels)!)).toEqual([
      'openai:gpt-5',
    ]);
  });

  it('hides a model behind the model catalog and restores it', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const modelRows = () =>
      Array.from(container?.querySelectorAll<HTMLElement>('.models-model-row') ?? []);
    const gpt5Row = modelRows().find(
      (row) => row.querySelector('.models-model-name')?.textContent === 'GPT-5'
    );
    gpt5Row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    findButton(document, 'Hide model')?.click();
    await Promise.resolve();

    expect(modelRows()).toHaveLength(1);
    expect(modelRows()[0]?.textContent).toContain('GPT-5 mini');
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.addedModels)!)).toEqual([
      'openai:*',
      'openai:gpt-5-mini',
    ]);

    findButton(container, 'Add models')?.click();
    await Promise.resolve();
    await Promise.resolve();
    const dialog = document.body.querySelector<HTMLElement>('.models-model-catalog-dialog');
    expect(dialog?.querySelectorAll('.models-model-catalog-row')).toHaveLength(2);
    expect(dialog?.querySelector('.models-model-catalog-id')?.textContent).toBe('(gpt-5-mini)');
    const hiddenModelRow = Array.from(
      dialog?.querySelectorAll<HTMLElement>('.models-model-catalog-row') ?? []
    ).find((row) => row.querySelector('.models-model-catalog-id')?.textContent === '(gpt-5)');
    const hiddenModelCheckbox = hiddenModelRow?.querySelector<HTMLInputElement>('.models-checkbox');
    expect(hiddenModelCheckbox?.checked).toBe(false);
    hiddenModelCheckbox?.click();
    findButton(dialog, 'Save changes')?.click();
    await Promise.resolve();

    expect(modelRows()).toHaveLength(2);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.addedModels)!)).toEqual([
      'openai:*',
      'openai:gpt-5-mini',
      'openai:gpt-5',
    ]);
  });

  it('preserves untoggled models when hiding another model', async () => {
    setState('hiddenModels', ['openai:gpt-5-mini']);
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const modelRows = () =>
      Array.from(container?.querySelectorAll<HTMLElement>('.models-model-row') ?? []);
    const gpt5Row = modelRows().find(
      (row) => row.querySelector('.models-model-name')?.textContent === 'GPT-5'
    );
    gpt5Row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    findButton(document, 'Hide model')?.click();
    await Promise.resolve();

    container?.querySelector<HTMLButtonElement>('.models-provider-toggle')?.click();
    await Promise.resolve();
    const remainingCheckbox = modelRows()[0]?.querySelector<HTMLInputElement>('.models-checkbox');
    expect(modelRows()).toHaveLength(1);
    expect(modelRows()[0]?.textContent).toContain('GPT-5 mini');
    expect(remainingCheckbox?.checked).toBe(false);
    expect(state.hiddenModels).toEqual(['openai:gpt-5-mini']);
  });

  it('renames and resets a model display name without changing its ID', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const row = Array.from(container?.querySelectorAll('.models-model-row') || []).find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5'
    ) as HTMLElement;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    findButton(document, 'Rename model')?.click();
    await Promise.resolve();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const nameInput = dialog?.querySelector<HTMLInputElement>('[aria-label="Model display name"]');
    expect(dialog?.textContent).toContain('GPT-5');
    expect(nameInput?.value).toBe('GPT-5');
    if (nameInput) {
      nameInput.value = 'Primary coder';
    }
    findButton(dialog, 'Save')?.click();
    await Promise.resolve();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const renamedRow = Array.from(container?.querySelectorAll('.models-model-row') || []).find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'Primary coder'
    ) as HTMLElement;
    expect(renamedRow).toBeTruthy();
    const renamedMarker = renamedRow.querySelector('.models-model-renamed-marker');
    expect(renamedMarker?.textContent).toBe('renamed');
    expect(renamedMarker?.getAttribute('aria-label')).toBe('Renamed model. Original name: GPT-5');
    expect(renamedMarker?.getAttribute('title')).toBeNull();
    expect(renamedMarker?.getAttribute('aria-label')).toBe('Renamed model. Original name: GPT-5');
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.modelDisplayNames)!)).toEqual({
      'openai:gpt-5': 'Primary coder',
    });

    renamedRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    findButton(document, 'Reset model name')?.click();
    await Promise.resolve();

    expect(container?.querySelector('.models-model-name')?.textContent).toBe('GPT-5');
    expect(container?.querySelector('.models-model-renamed-marker')).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEYS.modelDisplayNames)).toBeNull();
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

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const row = Array.from(container?.querySelectorAll('.models-model-row') || []).find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5 mini'
    ) as HTMLElement;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    const menuItems = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.models-context-menu-item')
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

  it('collapses hidden providers by default', async () => {
    setState('hiddenProviders', ['openai']);

    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.models-provider-count')?.textContent).toBe('2/2');
    expect(container?.querySelector('.models-provider-hidden-marker')?.textContent).toBe('Hidden');
    expect(container?.querySelector('.models-chevron')?.classList.contains('expanded')).toBe(false);
    expect(container?.querySelector('.ui-icon.models-chevron')).toBeInstanceOf(HTMLSpanElement);
    expect(container?.querySelector('.models-model-row')).toBeNull();
  });

  it('sorts hidden and fully disabled providers after enabled providers', async () => {
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
        name: 'Aardvark',
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
    setState('hiddenProviders', ['openai']);
    setState('hiddenModels', ['beta:beta']);
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const providerNames = () =>
      Array.from(container?.querySelectorAll('.models-provider-name') ?? []).map(
        (item) => item.textContent
      );
    expect(providerNames()).toEqual(['Alpha', 'OpenAI', 'Aardvark']);

    const openAISection = Array.from(
      container?.querySelectorAll<HTMLElement>('.models-provider') ?? []
    ).find((section) => section.querySelector('.models-provider-name')?.textContent === 'OpenAI');
    openAISection
      ?.querySelector<HTMLElement>('.models-provider-header')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    findButton(document.body, 'Show provider')?.click();
    await Promise.resolve();

    expect(providerNames()).toEqual(['OpenAI', 'Alpha', 'Aardvark']);

    const disabledSection = Array.from(
      container?.querySelectorAll<HTMLElement>('.models-provider') ?? []
    ).find((section) => section.querySelector('.models-provider-name')?.textContent === 'Aardvark');
    disabledSection?.querySelector<HTMLInputElement>('.models-checkbox')?.click();
    await Promise.resolve();

    expect(providerNames()).toEqual(['OpenAI', 'Aardvark', 'Alpha']);
  });

  it('reorders active providers by dragging and persists their order', async () => {
    setState('providers', [
      ...state.providers,
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
        id: 'hidden',
        name: 'Hidden',
        source: 'api',
        models: {
          hidden: {
            id: 'hidden',
            name: 'Hidden model',
            capabilities: { toolcall: true },
            cost: { input: 1, output: 1 },
          },
        },
      },
    ]);
    setState('hiddenProviders', ['hidden']);
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const providerNames = () =>
      Array.from(container?.querySelectorAll('.models-provider-name') ?? []).map(
        (item) => item.textContent
      );
    const sections = container!.querySelectorAll<HTMLElement>('.models-provider');
    const handles = container!.querySelectorAll<HTMLButtonElement>(
      '[aria-label^="Reorder provider:"]'
    );
    const dataTransfer = createDragDataTransfer();

    expect(providerNames()).toEqual(['OpenAI', 'Alpha', 'Hidden']);
    expect([...handles].map((handle) => handle.getAttribute('aria-label'))).toEqual([
      'Reorder provider: OpenAI',
      'Reorder provider: Alpha',
    ]);
    dispatchDragEvent(handles[1]!, 'dragstart', dataTransfer);
    dispatchDragEvent(sections[0]!, 'dragover', dataTransfer);
    expect(sections[1]?.classList.contains('is-dragging')).toBe(true);
    expect(sections[0]?.classList.contains('is-drag-over')).toBe(true);
    dispatchDragEvent(sections[0]!, 'drop', dataTransfer);

    expect(providerNames()).toEqual(['Alpha', 'OpenAI', 'Hidden']);
    expect(state.providerOrder).toEqual(['alpha', 'openai']);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.providerOrder)!)).toEqual([
      'alpha',
      'openai',
    ]);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Reorder provider: Alpha"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(providerNames()).toEqual(['OpenAI', 'Alpha', 'Hidden']);
  });

  it('reorders models by dragging and persists their provider-scoped order', async () => {
    setState('hiddenModels', ['openai:gpt-5-mini']);
    cleanup = render(() => ModelsPanel(), container!);
    await Promise.resolve();

    const modelNames = () =>
      Array.from(container?.querySelectorAll('.models-model-name') ?? []).map(
        (item) => item.textContent
      );
    const rows = container!.querySelectorAll<HTMLElement>('.models-model-row');
    const handles = container!.querySelectorAll<HTMLElement>('[aria-label^="Reorder model:"]');
    const dataTransfer = createDragDataTransfer();

    expect(modelNames()).toEqual(['GPT-5', 'GPT-5 mini']);
    expect([...handles].map((handle) => handle.getAttribute('aria-label'))).toEqual([
      'Reorder model: GPT-5',
      'Reorder model: GPT-5 mini',
    ]);
    dispatchDragEvent(handles[1]!, 'dragstart', dataTransfer);
    dispatchDragEvent(rows[0]!, 'dragover', dataTransfer);
    expect(rows[1]?.classList.contains('is-dragging')).toBe(true);
    expect(rows[0]?.classList.contains('is-drag-over')).toBe(true);
    dispatchDragEvent(rows[0]!, 'drop', dataTransfer);

    expect(modelNames()).toEqual(['GPT-5 mini', 'GPT-5']);
    expect(state.modelOrder).toEqual(['openai:gpt-5-mini', 'openai:gpt-5']);
    expect(state.hiddenModels).toEqual(['openai:gpt-5-mini']);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.modelOrder)!)).toEqual([
      'openai:gpt-5-mini',
      'openai:gpt-5',
    ]);

    container
      ?.querySelector<HTMLElement>('[aria-label="Reorder model: GPT-5 mini"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(modelNames()).toEqual(['GPT-5', 'GPT-5 mini']);
  });
});

function findButton(root: ParentNode | null | undefined, text: string) {
  return Array.from(root?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (button) => button.textContent?.trim() === text
  );
}

function openProviderAction(root: ParentNode | null | undefined, action: string) {
  root?.querySelector<HTMLButtonElement>('[aria-label="Provider actions"]')?.click();
  return findButton(root, action);
}
