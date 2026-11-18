import { flush as flushSolid, reconcile } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import type { Agent, Provider, Session } from '../types';
import type { ProviderLimitStatus } from '../../shared/protocol';
import {
  markProviderAuthFailure,
  resetProviderConnectionState,
} from '../lib/provider-connection-state';
import { setProviderLimit, setProviderLimitPin, setState, state } from '../lib/state';
import { STORAGE_KEYS } from '../lib/state-storage';
import { fixture } from '../test-fixtures';
import { ModelsPanel } from './ModelsPanel';
import { DEFAULT_TOOLTIP_DELAY } from './Tooltip';
import { SessionActionFeedback } from './chat/SessionActionFeedback';

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
  decisionProviderStatus: vi.fn(),
  updateDecisionProvider: vi.fn(),
  openCodeConfig: vi.fn(),
  promptCompletionModels: vi.fn(),
  testPromptCompletion: vi.fn(),
  saveModelRouting: vi.fn(),
  providers: vi.fn(),
  providerAuth: vi.fn(),
  providerLimit:
    vi.fn<(providerID: string, modelID?: string | null) => Promise<ProviderLimitStatus>>(),
  providerCatalog: vi.fn(),
  authorizeProvider: vi.fn(),
  completeProviderAuth: vi.fn(),
  connectApiProvider: vi.fn(),
  disconnectProvider: vi.fn(),
  disableProvider: vi.fn(),
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
      promptCompletionModels: clientMocks.promptCompletionModels,
      testPromptCompletion: clientMocks.testPromptCompletion,
      saveModelRouting: clientMocks.saveModelRouting,
      decisionProviders: {
        status: clientMocks.decisionProviderStatus,
        update: clientMocks.updateDecisionProvider,
      },
    },
    config: {
      providers: clientMocks.providers,
      providerAuth: clientMocks.providerAuth,
      providerLimit: clientMocks.providerLimit,
      providerCatalog: clientMocks.providerCatalog,
      authorizeProvider: clientMocks.authorizeProvider,
      completeProviderAuth: clientMocks.completeProviderAuth,
      connectApiProvider: clientMocks.connectApiProvider,
      disconnectProvider: clientMocks.disconnectProvider,
      disableProvider: clientMocks.disableProvider,
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

function availableLimit(
  providerID = 'openai'
): Extract<ProviderLimitStatus, { status: 'available' }> {
  return {
    providerID,
    modelID: null,
    status: 'available',
    source: 'provider',
    checkedAt: 1,
    windows: [
      {
        id: 'weekly',
        label: 'Weekly',
        unit: 'messages',
        remaining: 50,
        limit: 100,
        resetAt: null,
        percent: 50,
      },
    ],
  };
}

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
  flushSolid();
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
  clientMocks.decisionProviderStatus.mockResolvedValue({
    jev: {
      connected: false,
      credentialSource: null,
      model: 'jev-latest',
      autoApprove: false,
    },
  });
  clientMocks.openCodeConfig.mockResolvedValue({
    smallModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
    agentModels: { build: { providerID: 'openai', modelID: 'gpt-5' } },
    commitMessageModel: { providerID: 'openai', modelID: 'gpt-5' },
    autoApproveModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
  });
  clientMocks.promptCompletionModels.mockResolvedValue({
    'openai/gpt-5-mini': { available: true },
  });
  clientMocks.testPromptCompletion.mockResolvedValue({ success: true, elapsedMs: 1200 });
  clientMocks.saveModelRouting.mockResolvedValue({
    small_model: 'openai/gpt-5',
    agent: { build: { model: 'openai/gpt-5' } },
  });
  clientMocks.providerAuth.mockResolvedValue({
    openai: [{ type: 'api', label: 'API key' }],
  });
  clientMocks.providerLimit.mockReset();
  clientMocks.providerLimit.mockImplementation(async (providerID) => availableLimit(providerID));
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
    setState(
      storePath('providerAuthMethods', {
        openai: [{ type: 'api', label: 'API key' }],
      })
    );
    setState(storePath('workspaceStatuses', [{ workspaceID: 'ws-1', status: 'connected' }]));
  });
  setState(
    storePath('providers', [
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
    ])
  );
  flushSolid();
  setState(storePath('providerDefaults', { openai: 'gpt-5' }));
  flushSolid();
  setState(storePath('providersLoaded', true));
  flushSolid();
  setState(storePath('providersRefreshing', false));
  flushSolid();
  setState(storePath('providerRefreshPending', false));
  flushSolid();
  setState(storePath('sessions', []));
  flushSolid();
  setState(storePath('sessionStatus', {}));
  flushSolid();
  setState(
    storePath('agents', [
      {
        name: 'build',
        mode: 'primary',
        builtIn: true,
        permission: { edit: 'allow', bash: { '*': 'allow' } },
        tools: {},
        model: { providerID: 'openai', modelID: 'gpt-5' },
      },
    ])
  );
  flushSolid();
  setState(
    storePath('allAgents', [
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
    ])
  );
  flushSolid();
  setState(storePath('hiddenProviders', []));
  flushSolid();
  setState(storePath('hiddenModels', []));
  flushSolid();
  setState(storePath('removedModels', []));
  flushSolid();
  setState(storePath('providerOrder', []));
  flushSolid();
  setState((draft) => {
    const current = draft['providerLimitPins'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['providerLimitPins'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  setState((draft) => {
    const current = draft['providerLimits'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['providerLimits'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.providerLimitPins);
  flushSolid();
  setState(storePath('modelOrder', []));
  flushSolid();
  setState(storePath('addedModels', []));
  flushSolid();
  setState(storePath('pinnedModels', []));
  flushSolid();
  setState(storePath('modelDisplayNames', {}));
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.pinnedModels);
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.addedModels);
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.modelDisplayNames);
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.hiddenProviders);
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.hiddenModels);
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.removedModels);
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.providerOrder);
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.modelOrder);
  flushSolid();
  setState((draft) => {
    const current = draft['providerAuthMethods'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['providerAuthMethods'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  resetProviderConnectionState();
  flushSolid();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup?.();
  flushSolid();
  cleanup = undefined;
  container?.remove();
  flushSolid();
  container = null;
  delete window.__sendToExtension;
  setState(storePath('providers', []));
  flushSolid();
  setState(storePath('providerDefaults', {}));
  flushSolid();
  setState(storePath('providersLoaded', false));
  flushSolid();
  setState(storePath('providerRefreshPending', false));
  flushSolid();
  setState(storePath('sessions', []));
  flushSolid();
  setState(storePath('sessionStatus', {}));
  flushSolid();
  setState(storePath('agents', []));
  flushSolid();
  setState(storePath('allAgents', []));
  flushSolid();
  setState(storePath('providerAuthMethods', {}));
  flushSolid();
  setState(storePath('workspaceStatuses', []));
  flushSolid();
  setState(storePath('hiddenProviders', []));
  flushSolid();
  setState(storePath('hiddenModels', []));
  flushSolid();
  setState(storePath('removedModels', []));
  flushSolid();
  setState(storePath('providerOrder', []));
  flushSolid();
  setState((draft) => {
    const current = draft['providerLimitPins'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['providerLimitPins'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  setState((draft) => {
    const current = draft['providerLimits'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['providerLimits'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.providerLimitPins);
  flushSolid();
  setState(storePath('modelOrder', []));
  flushSolid();
  setState(storePath('addedModels', []));
  flushSolid();
  setState(storePath('pinnedModels', []));
  flushSolid();
  setState(storePath('modelDisplayNames', {}));
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.pinnedModels);
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.addedModels);
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.modelDisplayNames);
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.hiddenProviders);
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.hiddenModels);
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.removedModels);
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.providerOrder);
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.modelOrder);
  flushSolid();
  setState((draft) => {
    const current = draft['providerAuthMethods'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['providerAuthMethods'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  resetProviderConnectionState();
  flushSolid();
  if (originalResizeObserver) {
    globalThis.ResizeObserver = originalResizeObserver;
  }
  vi.restoreAllMocks();
  flushSolid();
});

describe('ModelsPanel', () => {
  it('pins provider limits with a status-bar-only name, renames, and unpins', async () => {
    const post = vi.fn();
    window.__sendToExtension = post;
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const header = container?.querySelector<HTMLElement>('.models-provider-header');
    expect(header).toBeTruthy();
    const originalHeaderMarkup = header?.innerHTML;
    expect(header?.querySelector('.models-provider-limit-pin, .chat-header-btn')).toBeNull();
    header?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    await vi.waitFor(() =>
      expect(findButton(document, 'Pin limits to status bar')?.disabled).toBe(false)
    );
    flushSolid();
    findButton(document, 'Pin limits to status bar')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    let input = document.querySelector<HTMLInputElement>('[aria-label="Status-bar provider name"]');
    expect(input?.value).toBe('OpenAI');
    if (input) input.value = ' Work ';
    findButton(document.querySelector('[role="dialog"]'), 'Save')?.click();
    flushSolid();
    expect(state.providerLimitPins).toEqual({ openai: 'Work' });
    expect(header?.innerHTML).toBe(originalHeaderMarkup);
    expect(container?.querySelector('.models-provider-name')?.textContent).toBe('OpenAI');
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.providerLimitPins)!)).toEqual({
      openai: 'Work',
    });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'model-preferences/update',
        payload: expect.objectContaining({
          preferences: expect.objectContaining({ providerLimitPins: { openai: 'Work' } }),
        }),
      })
    );

    header?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    findButton(document, 'Rename status-bar provider')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    input = document.querySelector<HTMLInputElement>('[aria-label="Status-bar provider name"]');
    expect(input?.value).toBe('Work');
    if (input) input.value = '';
    findButton(document.querySelector('[role="dialog"]'), 'Save')?.click();
    flushSolid();
    expect(state.providerLimitPins).toEqual({ openai: '' });

    header?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    findButton(document, 'Unpin limits from status bar')?.click();
    flushSolid();
    expect(state.providerLimitPins).toEqual({});
    expect(header?.innerHTML).toBe(originalHeaderMarkup);
  });

  it('does not pin limits when the name dialog is cancelled', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    container
      ?.querySelector<HTMLElement>('.models-provider-header')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    await vi.waitFor(() =>
      expect(findButton(document, 'Pin limits to status bar')?.disabled).toBe(false)
    );
    flushSolid();
    findButton(document, 'Pin limits to status bar')?.click();
    flushSolid();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    findButton(document.querySelector('[role="dialog"]'), 'Cancel')?.click();
    flushSolid();
    expect(state.providerLimitPins).toEqual({});
  });

  it.each(['unsupported', 'error', 'empty'] as const)(
    'does not allow pinning providers with %s limits',
    async (status) => {
      clientMocks.providerLimit.mockResolvedValue(
        status === 'empty'
          ? { ...availableLimit(), status: 'available', windows: [] }
          : { providerID: 'openai', status, source: 'provider', checkedAt: 1, note: 'No quotas' }
      );
      cleanup = render(() => ModelsPanel(), container!);
      flushSolid();
      container
        ?.querySelector<HTMLElement>('.models-provider-header')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(clientMocks.providerLimit).toHaveBeenCalledWith('openai', null);
      const pin = findButton(document, 'Pin limits to status bar');
      expect(pin).toBeInstanceOf(HTMLButtonElement);
      expect(pin?.disabled).toBe(true);
      pin?.click();
      flushSolid();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      setProviderLimitPin('openai', 'Work');
      flushSolid();
      expect(state.providerLimitPins).toEqual({});
      expect(window.localStorage.getItem(STORAGE_KEYS.providerLimitPins)).toBeNull();
    }
  );

  it('requires provider-wide limits rather than model-only quotas before enabling pinning', async () => {
    let resolve: (limit: ProviderLimitStatus) => void = () => {};
    clientMocks.providerLimit.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    setProviderLimit('openai', 'gpt-5', { ...availableLimit(), modelID: 'gpt-5' });
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    container
      ?.querySelector<HTMLElement>('.models-provider-header')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    expect(findButton(document, 'Pin limits to status bar')?.disabled).toBe(true);
    setProviderLimitPin('openai', 'Work');
    flushSolid();
    expect(state.providerLimitPins).toEqual({});
    resolve(availableLimit());
    flushSolid();
    await vi.waitFor(() =>
      expect(findButton(document, 'Pin limits to status bar')?.disabled).toBe(false)
    );
    flushSolid();
    findButton(document, 'Pin limits to status bar')?.click();
    flushSolid();
    findButton(document.querySelector('[role="dialog"]'), 'Save')?.click();
    flushSolid();
    expect(state.providerLimitPins).toEqual({ openai: '' });
  });

  it('allows renaming and removing existing pins when limits become unavailable', async () => {
    setState((draft) => {
      const current = draft['providerLimitPins'];
      const incoming = { openai: 'Work' } satisfies typeof current;
      if (incoming === null || incoming === undefined || current === null || current === undefined)
        draft['providerLimitPins'] = incoming;
      else reconcile(incoming)(current);
    });
    flushSolid();
    setProviderLimit('openai', null, {
      providerID: 'openai',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1,
      note: 'No quotas',
    });
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    const header = container?.querySelector<HTMLElement>('.models-provider-header');
    header?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    expect(findButton(document, 'Unpin limits from status bar')?.disabled).toBe(false);
    findButton(document, 'Rename status-bar provider')?.click();
    flushSolid();
    const input = document.querySelector<HTMLInputElement>(
      '[aria-label="Status-bar provider name"]'
    );
    if (input) input.value = 'Personal';
    findButton(document.querySelector('[role="dialog"]'), 'Save')?.click();
    flushSolid();
    expect(state.providerLimitPins).toEqual({ openai: 'Personal' });
    header?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    findButton(document, 'Unpin limits from status bar')?.click();
    flushSolid();
    expect(state.providerLimitPins).toEqual({});
    expect(clientMocks.providerLimit).not.toHaveBeenCalled();
  });

  it('does not save a new pin if limits become unavailable while its name dialog is open', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    container
      ?.querySelector<HTMLElement>('.models-provider-header')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    await vi.waitFor(() =>
      expect(findButton(document, 'Pin limits to status bar')?.disabled).toBe(false)
    );
    flushSolid();
    findButton(document, 'Pin limits to status bar')?.click();
    flushSolid();
    setProviderLimit('openai', null, {
      providerID: 'openai',
      status: 'error',
      source: 'provider',
      checkedAt: 2,
      note: 'Quota lookup failed',
    });
    flushSolid();
    expect(findButton(document.querySelector('[role="dialog"]'), 'Save')?.disabled).toBe(true);
    document
      .querySelector('[role="dialog"]')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    flushSolid();
    expect(state.providerLimitPins).toEqual({});
  });

  it('ignores a quota check after switching to another provider context menu', async () => {
    let resolve: (limit: ProviderLimitStatus) => void = () => {};
    clientMocks.providerLimit.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    clientMocks.providerLimit.mockResolvedValueOnce({
      providerID: 'unsupported',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1,
      note: 'No quotas',
    });
    setState(
      storePath('providers', (providers) => [
        ...providers,
        { ...providers[0]!, id: 'unsupported', name: 'Unsupported' },
      ])
    );
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    const headers = container?.querySelectorAll<HTMLElement>('.models-provider-header');
    headers?.[0]?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    headers?.[1]?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    resolve(availableLimit());
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(state.providerLimits['openai:']).toBeUndefined();
    expect(findButton(document, 'Pin limits to status bar')?.disabled).toBe(true);
  });

  it('reports quota-check failures without enabling pinning', async () => {
    clientMocks.providerLimit.mockRejectedValueOnce(new Error('API call timed out'));
    cleanup = render(() => [ModelsPanel(), SessionActionFeedback()], container!);
    flushSolid();
    container
      ?.querySelector<HTMLElement>('.models-provider-header')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    await vi.waitFor(() =>
      expect(document.querySelector('.session-action-feedback.is-warning')?.textContent).toContain(
        'Could not check provider limits: API call timed out'
      )
    );
    flushSolid();
    expect(findButton(document, 'Pin limits to status bar')?.disabled).toBe(true);
  });
  it('reports unexpected completion test transport failures', async () => {
    clientMocks.testPromptCompletion.mockRejectedValueOnce(new Error('API call timed out'));
    cleanup = render(() => [ModelsPanel(), SessionActionFeedback()], container!);
    flushSolid();
    await vi.waitFor(() => expect(clientMocks.promptCompletionModels).toHaveBeenCalled());
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const row = Array.from(container!.querySelectorAll<HTMLElement>('.models-model-row')).find(
      (item) => item.textContent?.includes('GPT-5 mini')
    )!;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    findButton(document.body, 'Test prompt completion')!.click();
    flushSolid();
    await vi.waitFor(() =>
      expect(document.querySelector('.session-action-feedback.is-warning')?.textContent).toContain(
        'Prompt completion test could not finish: API call timed out'
      )
    );
    flushSolid();
  });
  it('tests the context-menu model without assigning it and prevents duplicate tests', async () => {
    let resolve!: (result: { success: boolean; elapsedMs: number }) => void;
    clientMocks.testPromptCompletion.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await vi.waitFor(() => expect(clientMocks.promptCompletionModels).toHaveBeenCalled());
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const row = Array.from(container!.querySelectorAll<HTMLElement>('.models-model-row')).find(
      (item) => item.textContent?.includes('GPT-5 mini')
    )!;
    const open = () =>
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    open();
    flushSolid();
    const testButton = findButton(document.body, 'Test prompt completion')!;
    const group = testButton.closest('[role="group"]');
    flushSolid();
    expect(group?.getAttribute('aria-label')).toBe('Prompt completion');
    expect(group?.previousElementSibling?.getAttribute('role')).toBe('separator');
    expect(group?.previousElementSibling?.previousElementSibling?.textContent).toContain('agent');
    expect(findButton(group, 'Use for prompt completion')).toBeTruthy();
    expect(group?.querySelectorAll('button')).toHaveLength(2);
    expect(testButton.disabled).toBe(false);
    expect(testButton.title).toContain('consume provider usage');
    testButton.click();
    flushSolid();
    expect(clientMocks.testPromptCompletion).toHaveBeenCalledWith(
      { providerID: 'openai', modelID: 'gpt-5-mini' },
      { signal: expect.any(AbortSignal) }
    );
    expect(clientMocks.saveModelRouting).not.toHaveBeenCalled();
    open();
    flushSolid();
    expect(findButton(document.body, 'Test prompt completion')?.disabled).toBe(true);
    resolve({ success: true, elapsedMs: 1200 });
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(findButton(document.body, 'Test prompt completion')?.disabled).toBe(false);
  });

  it('hides the completion group for an unsupported model', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await vi.waitFor(() => expect(clientMocks.promptCompletionModels).toHaveBeenCalled());
    flushSolid();
    await Promise.resolve();
    flushSolid();
    container!
      .querySelector<HTMLElement>('.models-model-row')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    expect(findButton(document.body, 'Test prompt completion')).toBeUndefined();
    expect(findButton(document.body, 'Use for prompt completion')).toBeUndefined();
    expect(document.querySelector('[role="group"][aria-label="Prompt completion"]')).toBeNull();
    expect(document.querySelectorAll('.models-context-menu [role="separator"]')).toHaveLength(1);
    expect(clientMocks.testPromptCompletion).not.toHaveBeenCalled();
  });

  it('cancels a completion test when the models panel closes', async () => {
    let reject!: (error: Error) => void;
    clientMocks.testPromptCompletion.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    );
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await vi.waitFor(() => expect(clientMocks.promptCompletionModels).toHaveBeenCalled());
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const row = Array.from(container!.querySelectorAll<HTMLElement>('.models-model-row')).find(
      (item) => item.textContent?.includes('GPT-5 mini')
    )!;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    findButton(document.body, 'Test prompt completion')!.click();
    flushSolid();
    const signal = clientMocks.testPromptCompletion.mock.calls[0]![1].signal;
    cleanup?.();
    flushSolid();
    cleanup = undefined;
    expect(signal.aborted).toBe(true);
    reject(new Error('API call aborted'));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const cleanupFeedback = render(() => SessionActionFeedback(), container!);
    flushSolid();
    expect(document.querySelector('.session-action-feedback')).toBeNull();
    cleanupFeedback();
    flushSolid();
  });
  it('keeps large catalogs out of the model list until models are added', async () => {
    const template = {
      capabilities: { toolcall: true },
      cost: { input: 1, output: 1 },
    };
    setState(
      storePath('providers', [
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
      ])
    );
    flushSolid();
    setState(storePath('providerDefaults', {}));
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelectorAll('.models-model-row')).toHaveLength(0);
    expect(container?.querySelector('.models-provider-count')?.textContent).toBe('0 added');

    findButton(container, 'Add models')?.click();
    flushSolid();
    const dialog = document.body.querySelector<HTMLElement>('.models-model-catalog-dialog');
    expect(dialog?.textContent).toContain('Refreshing model catalog...');
    expect(
      dialog?.querySelector<HTMLInputElement>('[aria-label="Search OpenRouter models"]')?.disabled
    ).toBe(true);
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(dialog?.querySelectorAll('.models-model-catalog-row')).toHaveLength(0);
    expect(dialog?.textContent).toContain('Search 101 available models');
    expect(clientMocks.providers).toHaveBeenCalledOnce();

    const search = dialog?.querySelector<HTMLInputElement>(
      '[aria-label="Search OpenRouter models"]'
    );
    if (search) {
      search.value = 'model-100';
      search.dispatchEvent(new InputEvent('input', { bubbles: true }));
      flushSolid();
    }
    flushSolid();
    const result = dialog?.querySelector<HTMLElement>('.models-model-catalog-row');
    expect(result?.textContent).toContain('Model 100');
    result?.querySelector<HTMLInputElement>('.models-checkbox')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.models-provider-count')?.textContent).toBe('0 added');
    expect(window.localStorage.getItem(STORAGE_KEYS.addedModels)).toBeNull();
    expect(dialog?.textContent).toContain('1 unsaved change');
    findButton(dialog, 'Save changes')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.models-provider-count')?.textContent).toBe('1 added');
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.addedModels)!)).toEqual([
      'openrouter:model-100',
    ]);

    await Promise.resolve();
    flushSolid();
    expect(container?.querySelectorAll('.models-model-row')).toHaveLength(1);
    expect(container?.querySelector('.models-model-row')?.textContent).toContain('Model 100');

    container
      ?.querySelector<HTMLElement>('.models-model-row')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    findButton(document, 'Hide model')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelectorAll('.models-model-row')).toHaveLength(0);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.addedModels)!)).toEqual([]);
  });

  it.each([3, 51])(
    'keeps a %i-model catalog in its opening order until saved and reopened',
    async (count) => {
      const models = createModels(count);
      setState(storePath('providers', [{ id: 'openai', name: 'OpenAI', source: 'api', models }]));
      flushSolid();
      setState(storePath('addedModels', ['openai:*', 'openai:model-1']));
      flushSolid();
      setState(
        storePath(
          'removedModels',
          Object.keys(models)
            .filter((id) => id !== 'model-1')
            .map((id) => `openai:${id}`)
        )
      );
      flushSolid();
      cleanup = render(() => ModelsPanel(), container!);
      flushSolid();

      const openCatalog = async () => {
        findButton(container, 'Add models')?.click();
        flushSolid();
        const dialog = document.body.querySelector<HTMLElement>('.models-model-catalog-dialog')!;
        await vi.waitFor(() =>
          expect(dialog.querySelector('.models-model-catalog-row')).not.toBeNull()
        );
        const search = dialog.querySelector<HTMLInputElement>(
          '[aria-label="Search OpenAI models"]'
        )!;
        search.value = 'Model ';
        search.dispatchEvent(new InputEvent('input', { bubbles: true }));
        flushSolid();
        return dialog;
      };
      const rows = (dialog: HTMLElement) =>
        Array.from(dialog.querySelectorAll<HTMLElement>('.models-model-catalog-row'));
      const checkbox = (dialog: HTMLElement, id: string) =>
        rows(dialog)
          .find((row) => row.querySelector('.models-model-catalog-id')?.textContent === `(${id})`)!
          .querySelector<HTMLInputElement>('input')!;

      const dialog = await openCatalog();
      flushSolid();
      const openingRows = rows(dialog);
      expect(openingRows[0]?.querySelector('.models-model-catalog-id')?.textContent).toBe(
        '(model-1)'
      );
      expect(checkbox(dialog, 'model-1').checked).toBe(true);
      expect(checkbox(dialog, 'model-2').checked).toBe(false);

      checkbox(dialog, 'model-1').click();
      flushSolid();
      expect(rows(dialog)).toEqual(openingRows);
      expect(checkbox(dialog, 'model-1').checked).toBe(false);
      checkbox(dialog, 'model-2').click();
      flushSolid();
      expect(rows(dialog)).toEqual(openingRows);
      expect(checkbox(dialog, 'model-2').checked).toBe(true);
      expect(dialog.textContent).toContain('2 unsaved changes');

      findButton(dialog, 'Save changes')?.click();
      flushSolid();
      expect(document.body.querySelector('.models-model-catalog-dialog')).toBeNull();
      const reopenedDialog = await openCatalog();
      flushSolid();
      expect(rows(reopenedDialog)[0]?.querySelector('.models-model-catalog-id')?.textContent).toBe(
        '(model-2)'
      );
      expect(checkbox(reopenedDialog, 'model-2').checked).toBe(true);
      expect(checkbox(reopenedDialog, 'model-1').checked).toBe(false);
      expect(findButton(reopenedDialog, 'Save changes')?.disabled).toBe(true);
    }
  );

  it('discards pending model catalog changes when cancelled', async () => {
    const template = {
      capabilities: { toolcall: true },
      cost: { input: 1, output: 1 },
    };
    setState(
      storePath('providers', [
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
      ])
    );
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();

    findButton(container, 'Add models')?.click();
    flushSolid();
    const dialog = document.body.querySelector<HTMLElement>('.models-model-catalog-dialog');
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const search = dialog?.querySelector<HTMLInputElement>(
      '[aria-label="Search OpenRouter models"]'
    );
    if (search) {
      search.value = 'model-50';
      search.dispatchEvent(new InputEvent('input', { bubbles: true }));
      flushSolid();
    }
    flushSolid();
    dialog?.querySelector<HTMLInputElement>('.models-checkbox')?.click();
    flushSolid();
    findButton(dialog, 'Cancel')?.click();
    flushSolid();

    expect(document.body.querySelector('.models-model-catalog-dialog')).toBeNull();
    expect(container?.querySelector('.models-provider-count')?.textContent).toBe('0 added');
    expect(window.localStorage.getItem(STORAGE_KEYS.addedModels)).toBeNull();
  });

  it('replaces a cached large catalog with the freshly loaded models', async () => {
    setState(
      storePath('providers', [
        { id: 'openrouter', name: 'OpenRouter', source: 'api', models: createModels(360) },
      ])
    );
    flushSolid();
    clientMocks.providers.mockResolvedValue({
      providers: [
        { id: 'openrouter', name: 'OpenRouter', source: 'api', models: createModels(541) },
      ],
      default: {},
      defaultModel: null,
    });
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();

    findButton(container, 'Add models')?.click();
    flushSolid();
    const dialog = document.body.querySelector<HTMLElement>('.models-model-catalog-dialog');
    expect(dialog?.textContent).toContain('Refreshing available models...');

    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(dialog?.textContent).toContain('Search 541 available models');
    expect(Object.keys(state.providers[0]?.models ?? {})).toHaveLength(541);
  });

  it('selects newly published models when refreshing a managed provider catalog', async () => {
    const provider = state.providers[0]!;
    setState(storePath('addedModels', ['openai:*', 'openai:gpt-5']));
    flushSolid();
    setState(storePath('removedModels', ['openai:gpt-5-mini']));
    flushSolid();
    clientMocks.providers.mockResolvedValue({
      providers: [
        {
          ...provider,
          models: {
            ...provider.models,
            'new-model': { ...provider.models['gpt-5']!, id: 'new-model', name: 'New model' },
          },
        },
      ],
      default: {},
      defaultModel: null,
    });
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    findButton(container, 'Add models')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const dialog = document.body.querySelector<HTMLElement>('.models-model-catalog-dialog');
    const rows = Array.from(
      dialog?.querySelectorAll<HTMLElement>('.models-model-catalog-row') ?? []
    );
    const checkbox = (id: string) =>
      rows
        .find((row) => row.querySelector('.models-model-catalog-id')?.textContent === `(${id})`)
        ?.querySelector<HTMLInputElement>('input');
    expect(checkbox('new-model')?.checked).toBe(true);
    expect(checkbox('gpt-5-mini')?.checked).toBe(false);
    expect(rows.at(-1)?.querySelector('.models-model-catalog-id')?.textContent).toBe(
      '(gpt-5-mini)'
    );
    expect(findButton(dialog, 'Save changes')?.disabled).toBe(true);
  });

  it.each([undefined, false, true])(
    'gates the native decision section on debug visibility %s',
    async (visible) => {
      clientMocks.decisionProviderStatus.mockResolvedValue({
        jev: { connected: false, credentialSource: null, model: 'jev-latest', autoApprove: false },
        native: {
          visible,
          supported: true,
          model: null,
          models: [{ providerID: 'fixture', modelID: 'reviewer', name: 'Reviewer' }],
        },
      });
      cleanup = render(() => ModelsPanel(), container!);
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.decisionProviderStatus).toHaveBeenCalled());
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(!!container?.querySelector('select[aria-label="Native permission reviewer"]')).toBe(
        visible === true
      );
    }
  );

  it('adds Jev from the provider actions menu and shows it above providers', async () => {
    const disconnected = {
      jev: {
        connected: false,
        credentialSource: null,
        model: 'jev-latest',
        autoApprove: false,
      },
    };
    const connected = { jev: { ...disconnected.jev, connected: true, credentialSource: 'secret' } };
    clientMocks.decisionProviderStatus.mockResolvedValue(disconnected);
    clientMocks.updateDecisionProvider
      .mockResolvedValueOnce(connected)
      .mockResolvedValueOnce({ jev: { ...connected.jev, autoApprove: true } })
      .mockResolvedValueOnce(disconnected);
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await vi.waitFor(() => expect(clientMocks.decisionProviderStatus).toHaveBeenCalled());
    flushSolid();
    expect(container?.querySelector('.decision-provider')).toBeNull();

    const addDecisionModel = await vi.waitFor(() => {
      const button = openProviderAction(container, 'Add decision model');
      flushSolid();
      expect(button).toBeInstanceOf(HTMLButtonElement);
      return button!;
    });
    flushSolid();
    addDecisionModel.click();
    flushSolid();
    await vi.waitFor(() =>
      expect(clientMocks.updateDecisionProvider).toHaveBeenCalledWith({ action: 'connect' })
    );
    flushSolid();

    const section = await vi.waitFor(() => {
      const element = container?.querySelector<HTMLElement>('.decision-provider');
      expect(element).toBeInstanceOf(HTMLElement);
      return element!;
    });
    flushSolid();
    const firstProvider = container!.querySelector('.models-provider');
    expect(
      section.compareDocumentPosition(firstProvider!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(openProviderAction(container, 'Add decision model')).toBeUndefined();
    flushSolid();

    const autoApprove = container!.querySelector<HTMLInputElement>('.decision-provider-checkbox')!;
    autoApprove.click();
    flushSolid();
    await vi.waitFor(() => expect(autoApprove.checked).toBe(true));
    flushSolid();
    expect(clientMocks.updateDecisionProvider).toHaveBeenLastCalledWith({
      action: 'update',
      autoApprove: true,
    });

    findButton(container, 'Disconnect')?.click();
    flushSolid();
    await vi.waitFor(() => expect(container?.querySelector('.decision-provider')).toBeNull());
    flushSolid();
  });

  it.each(['Jev', 'native'])(
    'marks the chat judge as fallback while %s handles auto-approve',
    async (reviewer) => {
      clientMocks.decisionProviderStatus.mockResolvedValue({
        native: {
          supported: true,
          model: reviewer === 'native' ? { providerID: 'typesafe-ai', modelID: 'jev' } : null,
          models: [],
        },
        jev: {
          connected: true,
          credentialSource: 'secret',
          model: 'jev-latest',
          autoApprove: reviewer === 'Jev',
        },
      });
      cleanup = render(() => ModelsPanel(), container!);
      flushSolid();

      await vi.waitFor(() =>
        expect(container?.querySelector('.models-route-tag-approve')?.classList).toContain(
          'models-route-tag-overridden'
        )
      );
      flushSolid();
      expect(
        container?.querySelector('.models-route-tag-approve')?.getAttribute('aria-label')
      ).toBe('Auto-approve chat fallback (a decision model reviews first)');
    }
  );

  it.each(['Fast', 'Ultrafast'])('shows a dimmed %s label after the flash icons', async (speed) => {
    setState(storePath('providers', 0, 'models', 'gpt-5', 'name', `Claude Opus 5 ${speed}`));
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const fastSymbol = container?.querySelector(
      '.models-model-name [aria-label="Fast mode may consume usage limits faster and cost more."]'
    );
    expect(fastSymbol?.querySelectorAll('.model-speed-icon')).toHaveLength(
      speed === 'Ultrafast' ? 2 : 1
    );
    expect(fastSymbol?.nextElementSibling?.classList.contains('model-speed-label')).toBe(true);
    expect(fastSymbol?.nextElementSibling?.textContent).toBe(speed);
  });

  it('hides providers without matching search results', async () => {
    setState(
      storePath('providers', [
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
      ])
    );
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const search = container?.querySelector<HTMLInputElement>(
      '[aria-label="Filter providers or models"]'
    );
    if (search) {
      search.value = 'grok';
      search.dispatchEvent(new InputEvent('input', { bubbles: true }));
      flushSolid();
    }
    flushSolid();

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
    flushSolid();

    const actionsButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Provider actions"]'
    );
    expect(actionsButton?.getAttribute('aria-haspopup')).toBe('menu');
    expect(actionsButton?.querySelector('.models-provider-actions-icon')).toBeInstanceOf(
      HTMLSpanElement
    );
    actionsButton?.click();
    flushSolid();
    const menu = container?.querySelector('[role="menu"]');
    expect(
      Array.from(menu?.querySelectorAll('[role="menuitem"]') ?? []).map((item) => item.textContent)
    ).toEqual(['Add provider', 'Disconnect provider', 'Refresh list', 'Reset provider order']);
    expect(findButton(menu, 'Reset provider order')?.disabled).toBe(true);
    findButton(menu, 'Refresh list')?.click();
    flushSolid();

    expect(actionsButton).toBeInstanceOf(HTMLButtonElement);
    expect(actionsButton?.getAttribute('aria-expanded')).toBe('false');
    expect(send).toHaveBeenCalledWith({ type: 'providers/refresh' });
  });

  it('resets a custom provider order from provider actions', () => {
    setState(storePath('providerOrder', ['openai']));
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();

    container?.querySelector<HTMLButtonElement>('[aria-label="Provider actions"]')?.click();
    flushSolid();
    const menu = container?.querySelector('[role="menu"]');
    const resetButton = findButton(container, 'Reset provider order');

    expect(resetButton?.disabled).toBe(false);
    expect(menu?.querySelector('[role="menuitem"]:last-child')).toBe(resetButton);
    resetButton?.click();
    flushSolid();

    expect(resetButton).toBeInstanceOf(HTMLButtonElement);
    expect(state.providerOrder).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.providerOrder)!)).toEqual([]);
    expect(container?.querySelector('[role="menu"]')).toBeNull();
  });

  it('opens the embedded disconnect dialog from provider actions', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();

    container?.querySelector<HTMLButtonElement>('[aria-label="Provider actions"]')?.click();
    flushSolid();
    const logoutButton = findButton(container, 'Disconnect provider');
    logoutButton?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

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
    flushSolid();
    await Promise.resolve();
    flushSolid();

    container
      ?.querySelector<HTMLElement>('.models-provider-header')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    const deleteButton = findButton(document.body, 'Disconnect provider');
    const resetButton = findButton(document.body, 'Reset model order');
    deleteButton?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
    expect(resetButton?.disabled).toBe(true);
    expect(dialog?.textContent).toContain('OpenAI');
    expect(dialog?.textContent).toContain('Remove the saved credential for OpenAI?');
    expect(dialog?.textContent).toContain('configured in OpenCode config');
    expect(dialog?.querySelector('.provider-connect-options')).toBeNull();
    findButton(dialog, 'Open opencode.json in VS Code')?.click();
    flushSolid();
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: {
        path: '/Users/test/.config/opencode/opencode.json',
        kind: 'file',
      },
    });
  });

  it('hides and shows a provider from its context menu', async () => {
    clientMocks.openCodeConfig.mockResolvedValue({});
    setState(storePath('hiddenModels', ['openai:gpt-5-mini']));
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const providerHeader = container?.querySelector<HTMLElement>('.models-provider-header');
    providerHeader?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );
    flushSolid();
    findButton(document.body, 'Hide provider')?.click();
    flushSolid();

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
    flushSolid();
    expect(
      Array.from(
        container?.querySelectorAll<HTMLInputElement>('.models-model-row input') ?? []
      ).map((input) => input.checked)
    ).toEqual([true, false]);

    providerHeader?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );
    flushSolid();
    findButton(document.body, 'Show provider')?.click();
    flushSolid();

    expect(state.hiddenProviders).toEqual([]);
    expect(state.hiddenModels).toEqual(['openai:gpt-5-mini']);
    expect(providerHeader?.querySelector('.models-provider-hidden-marker')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.hiddenProviders)!)).toEqual([]);
  });

  it('deselects all models without hiding or collapsing the provider', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const section = container?.querySelector<HTMLElement>('.models-provider');
    const checkbox = section?.querySelector<HTMLInputElement>(
      '.models-provider-header .models-checkbox'
    );
    expect(checkbox?.checked).toBe(true);
    checkbox?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(state.hiddenProviders).toEqual([]);
    expect(state.hiddenModels).toEqual(['openai:gpt-5', 'openai:gpt-5-mini']);
    expect(section?.querySelector('.models-provider-hidden-marker')).toBeNull();
    expect(section?.querySelector('.models-provider-count')?.textContent).toBe('0/2');
    expect(section?.querySelector('.models-chevron')?.classList.contains('expanded')).toBe(true);
    expect(section?.querySelectorAll('.models-model-row')).toHaveLength(2);
    expect(checkbox?.checked).toBe(false);

    checkbox?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(state.hiddenProviders).toEqual([]);
    expect(state.hiddenModels).toEqual([]);
    expect(checkbox?.checked).toBe(true);
  });

  it('keeps an explicitly hidden provider hidden when selecting all models', async () => {
    setState(storePath('hiddenProviders', ['openai']));
    flushSolid();
    setState(storePath('hiddenModels', ['openai:gpt-5', 'openai:gpt-5-mini']));
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    container?.querySelector<HTMLInputElement>('.models-provider-header .models-checkbox')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(state.hiddenModels).toEqual([]);
    expect(state.hiddenProviders).toEqual(['openai']);
    expect(container?.querySelector('.models-provider-hidden-marker')?.textContent).toBe('Hidden');
  });

  it('resets a provider model order from its context menu', async () => {
    setState(storePath('modelOrder', ['openai:gpt-5-mini', 'openai:gpt-5']));
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(
      Array.from(container?.querySelectorAll('.models-model-name') ?? []).map(
        (item) => item.textContent
      )
    ).toEqual(['GPT-5 mini', 'GPT-5']);
    container
      ?.querySelector<HTMLElement>('.models-provider-header')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    const menu = document.body.querySelector('.models-provider-context-menu');
    const resetButton = findButton(document.body, 'Reset model order');

    expect(resetButton?.disabled).toBe(false);
    expect(menu?.querySelector('button:last-child')).toBe(resetButton);
    resetButton?.click();
    flushSolid();

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
    setState(
      storePath('providers', [
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
      ])
    );
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();

    container
      ?.querySelector<HTMLElement>('.models-provider-header')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    const deleteButton = findButton(document.body, 'Disconnect provider');

    expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
    expect(deleteButton?.disabled).toBe(true);
    deleteButton?.click();
    flushSolid();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each([true, false])(
    'shows config links only for matching provider entries, known provider path=%s',
    async (knownProviderPath) => {
      const send = vi.fn();
      window.__sendToExtension = send;
      clientMocks.openCodeConfig.mockResolvedValue({
        smallModel: null,
        agentModels: {},
        commitMessageModel: null,
        autoApproveModel: null,
        providerConfigPaths: knownProviderPath
          ? { custom: ['/repo/opencode.jsonc'] }
          : { unrelated: ['/repo/opencode.jsonc'] },
      });
      clientMocks.providerCatalog.mockResolvedValue({
        all: [{ id: 'custom', name: 'Custom', source: 'config', models: {} }],
        default: {},
        connected: [],
      });
      setState(
        storePath('providers', [
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
        ])
      );
      flushSolid();
      cleanup = render(() => ModelsPanel(), container!);
      flushSolid();
      await Promise.resolve();
      flushSolid();

      container
        ?.querySelector<HTMLElement>('.models-provider-header')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      flushSolid();
      findButton(document.body, 'Disconnect provider')?.click();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushSolid();

      const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog?.textContent).toContain('has no saved credential to disconnect');
      const openConfig = findButton(dialog, 'Open opencode.jsonc in VS Code');
      if (knownProviderPath) {
        expect(openConfig).toBeInstanceOf(HTMLButtonElement);
        openConfig?.click();
        flushSolid();
        expect(send).toHaveBeenCalledWith({
          type: 'vscode/open',
          payload: { path: '/repo/opencode.jsonc', kind: 'file' },
        });
      } else {
        expect(openConfig).toBeUndefined();
        expect(dialog?.textContent).not.toContain('configured in OpenCode config');
      }
      flushSolid();
      expect(findButton(dialog, 'Disconnect')).toBeUndefined();
    }
  );

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
    setState(
      storePath('providers', [
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
      ])
    );
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();

    container
      ?.querySelector<HTMLElement>('.models-provider-header')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    findButton(document.body, 'Disconnect provider')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('supplied by environment credentials');
    expect(dialog?.textContent).toContain('AWS_PROFILE, AWS_ACCESS_KEY_ID');
  });

  it('uses terminal provider actions on Option-click', () => {
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();

    const actionsButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Provider actions"]'
    );
    actionsButton?.click();
    flushSolid();
    const addButton = findButton(container, 'Add provider');
    addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    flushSolid();
    actionsButton?.click();
    flushSolid();
    const removeButton = findButton(container, 'Disconnect provider');
    removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    flushSolid();

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
    flushSolid();

    openProviderAction(container, 'Disconnect provider')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('Anthropic');
    expect(dialog?.textContent).not.toContain('OpenAI');
    expect(dialog?.textContent).not.toContain('OpenCode Zen');
    dialog?.querySelector<HTMLButtonElement>('.provider-connect-option')?.click();
    flushSolid();
    expect(dialog?.textContent).toContain('Remove the saved credential');
    findButton(dialog, 'Disconnect')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(clientMocks.disconnectProvider).toHaveBeenCalledWith('anthropic');
    expect(send).toHaveBeenCalledWith({ type: 'providers/auth-changed' });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each([false, true])(
    'disables local Ollama through configuration, failure=%s',
    async (fails) => {
      const send = vi.fn();
      window.__sendToExtension = send;
      clientMocks.providerCatalog.mockResolvedValue({
        all: [
          { id: 'ollama', name: 'Ollama', source: 'config', disconnectMode: 'disable', models: {} },
        ],
        connected: ['ollama'],
        default: {},
      });
      if (fails)
        clientMocks.disableProvider.mockRejectedValueOnce(new Error('Config is read-only'));
      else clientMocks.disableProvider.mockResolvedValueOnce(true);
      cleanup = render(() => ModelsPanel(), container!);
      flushSolid();
      openProviderAction(container, 'Disconnect provider')?.click();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
      dialog?.querySelector<HTMLButtonElement>('.provider-connect-option')?.click();
      flushSolid();
      expect(dialog?.textContent).toContain('discovers this local provider automatically');
      expect(dialog?.textContent).not.toContain('Remove the saved credential');
      findButton(dialog, 'Disable in this workspace')?.click();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(clientMocks.disableProvider).toHaveBeenCalledWith('ollama');
      expect(clientMocks.disconnectProvider).not.toHaveBeenCalled();
      if (fails) {
        expect(dialog?.querySelector('[role="alert"]')?.textContent).toContain(
          'Config is read-only'
        );
        expect(send).not.toHaveBeenCalledWith({ type: 'providers/auth-changed' });
      } else {
        expect(send).toHaveBeenCalledWith({ type: 'providers/auth-changed' });
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      }
    }
  );

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
    flushSolid();

    const button = openProviderAction(container, 'Add provider');
    flushSolid();
    button?.click();
    flushSolid();

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
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(dialog?.querySelector('.provider-connect-skeleton')).toBeNull();
    expect(dialog?.querySelector('.provider-connect-option')?.textContent).toContain('OpenAI');
    expect(dialog?.querySelector('[aria-label="Search providers"]')).toBeInstanceOf(
      HTMLInputElement
    );
  });

  it('hides fallback models while a provider requires re-authentication', async () => {
    markProviderAuthFailure('openai', 'failed-message');
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

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
    flushSolid();

    openProviderAction(container, 'Add provider')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    dialog?.querySelector<HTMLButtonElement>('.provider-connect-option')?.click();
    flushSolid();
    dialog?.querySelector<HTMLButtonElement>('.provider-connect-method')?.click();
    flushSolid();
    const keyInput = dialog?.querySelector<HTMLInputElement>('input[type="password"]');
    if (keyInput) {
      keyInput.value = 'sk-test';
      keyInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
      flushSolid();
    }
    flushSolid();
    findButton(dialog, 'Connect')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

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
    flushSolid();

    openProviderAction(container, 'Add provider')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    dialog?.querySelector<HTMLButtonElement>('.provider-connect-option')?.click();
    flushSolid();
    dialog?.querySelector<HTMLButtonElement>('.provider-connect-method')?.click();
    flushSolid();
    expect(dialog?.querySelector('input[type="password"]')).toBeInstanceOf(HTMLInputElement);

    findButton(dialog, 'Cancel')?.click();
    flushSolid();

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
    setState(
      storePath('providerAuthMethods', {
        anthropic: [{ type: 'oauth', label: 'Claude subscription' }],
      })
    );
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();

    openProviderAction(container, 'Add provider')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
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
      flushSolid();
    }
    flushSolid();

    expect(options()).toHaveLength(1);
    expect(options()[0]?.textContent).toContain('Custom Cloud');
    options()[0]?.click();
    flushSolid();
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
    flushSolid();

    openProviderAction(container, 'Add provider')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const options = dialog?.querySelector<HTMLElement>('.provider-connect-options');
    Object.defineProperties(options!, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    options?.dispatchEvent(new Event('scroll'));
    flushSolid();

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
    setState(
      storePath('providerAuthMethods', {
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
      })
    );
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();

    openProviderAction(container, 'Add provider')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const dialog = Array.from(document.body.querySelectorAll<HTMLElement>('[role="dialog"]')).at(
      -1
    );
    const providerOption = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('.provider-connect-option') ?? []
    ).find((option) => option.textContent?.includes('GitLab'));
    expect(providerOption?.textContent).toContain('GitLab');
    providerOption?.click();
    flushSolid();
    const methodOption = dialog?.querySelector<HTMLButtonElement>('.provider-connect-method');
    expect(methodOption?.textContent).toContain('GitLab Copilot');
    methodOption?.click();
    flushSolid();

    expect(dialog?.querySelector('select')).toBeNull();
    const trigger = dialog?.querySelector<HTMLButtonElement>('.provider-connect-select-trigger');
    expect(trigger).toBeInstanceOf(HTMLButtonElement);
    trigger?.click();
    flushSolid();
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(dialog?.querySelector('.provider-connect-body')?.classList).toContain('has-open-select');
    expect(dialog?.querySelector('[role="listbox"]')).toBeInstanceOf(HTMLElement);
    expect(dialog?.textContent).toContain('Hosted by GitLab');

    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    flushSolid();
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    flushSolid();
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
    setState(
      storePath('providerAuthMethods', {
        'github-copilot': [{ type: 'oauth', label: 'GitHub Copilot' }],
      })
    );
    flushSolid();
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
    flushSolid();

    openProviderAction(container, 'Add provider')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    dialog?.querySelector<HTMLButtonElement>('.provider-connect-option')?.click();
    flushSolid();
    dialog?.querySelector<HTMLButtonElement>('.provider-connect-method')?.click();
    flushSolid();
    findButton(dialog, 'Continue')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(dialog?.textContent).toContain('Enter code: 69FA-4C72');
    expect(dialog?.querySelector('[aria-label*="Copy authorization code"]')).toBeInstanceOf(
      HTMLButtonElement
    );
    expect(callbackSignal?.aborted).toBe(false);
    dialog?.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click();
    flushSolid();

    expect(callbackSignal?.aborted).toBe(true);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows a loading indicator long enough to be perceptible', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    window.__sendToExtension = send;
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();

    setState(storePath('providersRefreshing', true));
    flushSolid();
    expect(container?.querySelector('.models-list-refreshed')).toBeNull();
    setState(storePath('providersRefreshing', false));
    flushSolid();

    const actionsButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Provider actions"]'
    );
    actionsButton?.click();
    flushSolid();
    findButton(container, 'Refresh list')?.click();
    flushSolid();

    expect(actionsButton?.getAttribute('aria-busy')).toBe('true');

    setState(storePath('providersRefreshing', false));
    flushSolid();

    await vi.advanceTimersByTimeAsync(499);
    flushSolid();
    expect(actionsButton?.getAttribute('aria-busy')).toBe('true');

    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    expect(actionsButton?.getAttribute('aria-busy')).toBe('false');
  });

  it('keeps the animation active until a slow refresh finishes and allows retry', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    window.__sendToExtension = send;
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();

    const actionsButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Provider actions"]'
    );
    actionsButton?.click();
    flushSolid();
    findButton(container, 'Refresh list')?.click();
    flushSolid();
    setState(storePath('providersLoaded', false));
    flushSolid();

    await vi.advanceTimersByTimeAsync(500);
    flushSolid();

    expect(actionsButton?.getAttribute('aria-busy')).toBe('true');
    expect(container?.querySelector('.models-list-refreshed')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    flushSolid();
    container?.querySelector('.models-panel')?.dispatchEvent(
      Object.assign(new Event('animationiteration', { bubbles: true }), {
        animationName: 'models-list-refresh',
      })
    );
    flushSolid();
    expect(container?.querySelector('.models-list-refreshed')).not.toBeNull();

    // A failed refresh finishes too, even though providersLoaded stays false.
    setState(storePath('providersRefreshing', false));
    flushSolid();
    expect(actionsButton?.getAttribute('aria-busy')).toBe('false');
    expect(container?.querySelector('.models-list-refreshed')).not.toBeNull();
    container?.querySelector('.models-panel')?.dispatchEvent(
      Object.assign(new Event('animationiteration', { bubbles: true }), {
        animationName: 'models-list-refresh',
      })
    );
    flushSolid();
    expect(container?.querySelector('.models-list-refreshed')).toBeNull();
    actionsButton?.click();
    flushSolid();
    findButton(container, 'Refresh list')?.click();
    flushSolid();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('shows provider refresh progress without running sessions', () => {
    setState(storePath('providerRefreshPending', true));
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();

    expect(container?.querySelector('.models-provider-refresh-notice')?.textContent).toContain(
      'Synchronizing providers with OpenCode.'
    );
  });

  it('counts only running parent sessions in the queued provider notice', () => {
    setState(storePath('providerRefreshPending', true));
    flushSolid();
    setState(
      storePath('sessions', [
        session('session-1'),
        session('session-2'),
        session('session-3'),
        session('child-1', 'session-1'),
      ])
    );
    flushSolid();
    setState(
      storePath('sessionStatus', {
        'session-1': { type: 'busy' },
        'session-2': { type: 'retry', attempt: 1, message: 'Retrying', next: Date.now() },
        'session-3': { type: 'idle' },
        'child-1': { type: 'busy' },
      })
    );
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();

    const notice = container?.querySelector<HTMLElement>('.models-provider-refresh-notice');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain('Provider synchronization queued.');
    expect(notice?.textContent).toContain('when 2 running agents finish.');

    setState(storePath('sessionStatus', 'session-2', { type: 'idle' }));
    flushSolid();
    expect(notice?.textContent).toContain('when 1 running agent finishes.');
  });

  it('labels old and new queued small-model assignments in the model list', async () => {
    setState(storePath('sessions', [session('session-1')]));
    flushSolid();
    setState(storePath('sessionStatus', { 'session-1': { type: 'busy' } }));
    flushSolid();
    clientMocks.saveModelRouting.mockImplementation(async () => {
      setState(storePath('providerRefreshPending', true));
      return {
        smallModel: { providerID: 'openai', modelID: 'gpt-5' },
        agentModels: { build: { providerID: 'openai', modelID: 'gpt-5' } },
        commitMessageModel: { providerID: 'openai', modelID: 'gpt-5' },
        autoApproveModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
      };
    });
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const nextRow = Array.from(container?.querySelectorAll('.models-model-row') ?? []).find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5'
    ) as HTMLElement;
    nextRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    const assignButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.models-context-menu-item')
    ).find((item) => item.textContent === 'Use as small model');
    assignButton?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('[aria-label="Small model (old)"]')?.textContent).toBe(
      'smallold'
    );
    expect(container?.querySelector('[aria-label="Small model (new)"]')?.textContent).toBe(
      'smallnew'
    );
    expect(container?.querySelector('.models-provider-refresh-notice')?.textContent).toContain(
      'Old and new assignments are labeled in the model list.'
    );

    setState(storePath('providerRefreshPending', false));
    flushSolid();
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
    setState(storePath('sessions', [session('session-1')]));
    flushSolid();
    setState(storePath('sessionStatus', { 'session-1': { type: 'busy' } }));
    flushSolid();
    clientMocks.saveModelRouting.mockImplementation(async () => {
      setState(storePath('providerRefreshPending', true));
      return {
        smallModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
        agentModels: { review: { providerID: 'openai', modelID: 'gpt-5' } },
        commitMessageModel: null,
        autoApproveModel: null,
      };
    });
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const nextRow = Array.from(container?.querySelectorAll('.models-model-row') ?? []).find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5'
    ) as HTMLElement;
    nextRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    const assignButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.models-context-menu-item')
    ).find((item) => item.textContent === 'Use for review agent');
    assignButton?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('[aria-label="Agent model: review (old)"]')?.textContent).toBe(
      'reviewold'
    );
    expect(container?.querySelector('[aria-label="Agent model: review (new)"]')?.textContent).toBe(
      'reviewnew'
    );
  });

  it('strikes through a queued assignment removal instead of labeling it old', async () => {
    setState(storePath('sessions', [session('session-1')]));
    flushSolid();
    setState(storePath('sessionStatus', { 'session-1': { type: 'busy' } }));
    flushSolid();
    clientMocks.saveModelRouting.mockImplementation(async () => {
      setState(storePath('providerRefreshPending', true));
      return {
        smallModel: null,
        agentModels: { build: { providerID: 'openai', modelID: 'gpt-5' } },
        commitMessageModel: { providerID: 'openai', modelID: 'gpt-5' },
        autoApproveModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
      };
    });
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const currentRow = Array.from(container?.querySelectorAll('.models-model-row') ?? []).find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5 mini'
    ) as HTMLElement;
    currentRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    const removeButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.models-context-menu-item')
    ).find((item) => item.textContent === "Don't use as small model");
    removeButton?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const removedTag = container?.querySelector('[aria-label="Small model (will be removed)"]');
    expect(removedTag?.textContent).toBe('small');
    expect(removedTag?.classList.contains('models-route-tag-removed')).toBe(true);
    expect(container?.querySelector('[aria-label="Small model (old)"]')).toBeNull();
  });

  it('renders an inline release date for desktop layouts', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

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
    flushSolid();
  });

  it('shows compact capability icons without hiding universally supported features', async () => {
    setState(
      storePath('providers', 0, 'models', 'gpt-5', 'capabilities', {
        toolcall: true,
        vision: true,
        input: ['text', 'image', 'pdf', 'audio', 'video'],
      })
    );
    flushSolid();
    setState(
      storePath('providers', 0, 'models', 'gpt-5-mini', 'capabilities', {
        toolcall: true,
        vision: true,
        input: ['text', 'image'],
      })
    );
    flushSolid();

    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

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

  it('shows proxy vision with a separate tooltip and keeps native vision unchanged', async () => {
    setState(storePath('providers', 0, 'models', 'gpt-5', 'capabilities', 'vision', true));
    flushSolid();
    setState(storePath('providers', 0, 'models', 'gpt-5-mini', 'capabilities', 'vision', false));
    flushSolid();
    setState(storePath('providers', 0, 'models', 'gpt-5-mini', 'variants', { high: {} }));
    flushSolid();
    setState(
      storePath('allAgents', [
        {
          name: 'vision',
          mode: 'subagent',
          permission: [],
          model: { providerID: 'openai', modelID: 'gpt-5' },
        },
      ])
    );
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const rows = Array.from(container?.querySelectorAll('.models-model-row') ?? []);
    const nativeRow = rows.find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5'
    );
    const proxyRow = rows.find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5 mini'
    );
    const nativeBadge = nativeRow?.querySelector('.model-capability-tag-vision');
    const proxyBadge = proxyRow?.querySelector('.model-capability-tag-vision');
    expect(nativeBadge?.getAttribute('aria-label')).toBe('Vision');
    expect(nativeBadge?.classList.contains('model-capability-tag-vision-proxy')).toBe(false);
    expect(nativeBadge?.querySelector('.models-capability-proxy-marker')).toBeNull();
    expect(proxyBadge?.getAttribute('aria-label')).toBe('Vision (via proxy model)');
    expect(proxyBadge?.classList.contains('model-capability-tag-vision-proxy')).toBe(true);
    expect(proxyBadge?.querySelector('.models-capability-label')?.textContent).toBe('Vision');
    const marker = proxyBadge?.querySelector('.models-capability-proxy-marker');
    expect(marker?.textContent?.trim()).toBe('*');
    expect(marker?.getAttribute('aria-hidden')).toBe('true');
    expect(proxyRow?.querySelectorAll('.model-capability-tag-vision')).toHaveLength(1);
    expect(
      container
        ?.querySelector<HTMLElement>('.models-model-list')
        ?.style.getPropertyValue('--models-capability-count')
    ).toBe('3');

    vi.useFakeTimers();
    proxyBadge?.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    await vi.advanceTimersByTimeAsync(DEFAULT_TOOLTIP_DELAY);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Vision (via proxy model)'
    );
    proxyBadge?.dispatchEvent(new MouseEvent('mouseleave'));
    flushSolid();
    vi.useRealTimers();

    setState(storePath('providers', 0, 'models', 'gpt-5-mini', 'capabilities', 'vision', true));
    flushSolid();
    expect(proxyRow?.querySelector('.models-capability-proxy-marker')).toBeNull();
    expect(
      proxyRow?.querySelector('.model-capability-tag-vision')?.getAttribute('aria-label')
    ).toBe('Vision');
    setState(storePath('providers', 0, 'models', 'gpt-5-mini', 'capabilities', 'vision', false));
    flushSolid();
    expect(proxyRow?.querySelector('.models-capability-proxy-marker')?.textContent?.trim()).toBe(
      '*'
    );

    setState(storePath('allAgents', []));
    flushSolid();
    expect(proxyRow?.querySelector('.model-capability-tag-vision')).toBeNull();
    expect(
      nativeRow?.querySelector('.model-capability-tag-vision')?.getAttribute('aria-label')
    ).toBe('Vision');
    expect(
      container
        ?.querySelector<HTMLElement>('.models-model-list')
        ?.style.getPropertyValue('--models-capability-count')
    ).toBe('2');
  });

  it.each<Partial<Agent>>([
    {},
    { hidden: true },
    { mode: 'primary' },
    { model: undefined },
    { model: { providerID: 'openai', modelID: 'gpt-5-mini' } },
    { model: { providerID: 'missing', modelID: 'missing' } },
  ])('shows proxy vision only for an available vision helper: %j', async (overrides) => {
    setState(storePath('providers', 0, 'models', 'gpt-5', 'capabilities', 'vision', true));
    flushSolid();
    setState(storePath('providers', 0, 'models', 'gpt-5-mini', 'capabilities', 'vision', false));
    flushSolid();
    setState(
      storePath('allAgents', [
        {
          name: 'vision',
          mode: 'all',
          permission: [],
          model: { providerID: 'openai', modelID: 'gpt-5' },
          ...overrides,
        },
      ])
    );
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelectorAll('.model-capability-tag-vision-proxy')).toHaveLength(
      Object.keys(overrides).length === 0 ? 1 : 0
    );
    setState(storePath('providers', 0, 'models', 'gpt-5-mini', 'capabilities', 'toolcall', false));
    flushSolid();
    expect(container?.querySelector('.model-capability-tag-vision-proxy')).toBeNull();
  });

  it('shows routing tags loaded from opencode config and agents', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

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
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('[aria-label="Small model"]')).toBeTruthy();
    expect(container?.querySelector('[aria-label="Agent model: review"]')).toBeTruthy();
  });

  it('opens the model context menu and saves a routing assignment', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

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
    flushSolid();

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
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(clientMocks.saveModelRouting).toHaveBeenCalledWith({
      target: 'small_model',
      providerID: 'openai',
      modelID: 'gpt-5',
    });
    expect(refreshRoutingStateMock).toHaveBeenCalled();
  });

  it.each([false, true])(
    'offers a global vision assignment before the agent exists (image support: %s)',
    async (supportsVision) => {
      setState(storePath('allAgents', []));
      flushSolid();
      setState(
        storePath('providers', 0, 'models', 'gpt-5-mini', 'capabilities', 'vision', supportsVision)
      );
      flushSolid();
      cleanup = render(() => ModelsPanel(), container!);
      flushSolid();
      await Promise.resolve();
      flushSolid();
      const row = Array.from(
        container?.querySelectorAll<HTMLElement>('.models-model-row') ?? []
      ).find((item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5 mini');
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      flushSolid();
      const button = findButton(document, 'Use for vision agent');
      expect(button).not.toBeNull();
      expect(button?.title).toBe('Global vision agent model');
      expect(button?.disabled).toBe(!supportsVision);
      button?.click();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      if (supportsVision)
        expect(clientMocks.saveModelRouting).toHaveBeenCalledWith({
          target: 'agent',
          agentName: 'vision',
          providerID: 'openai',
          modelID: 'gpt-5-mini',
          unset: undefined,
        });
      else expect(clientMocks.saveModelRouting).not.toHaveBeenCalled();
    }
  );

  it('refreshes inherited model tags after another window changes global configuration', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('[aria-label="Agent model: vision"]')).toBeNull();
    clientMocks.openCodeConfig.mockResolvedValue({
      smallModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
      agentModels: { vision: { providerID: 'openai', modelID: 'gpt-5' } },
      commitMessageModel: null,
      autoApproveModel: null,
    });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'providers/refresh' } }));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('[aria-label="Agent model: vision"]')).not.toBeNull();
    expect(container?.querySelector('[aria-label="Small model"]')).not.toBeNull();
    expect(clientMocks.openCodeConfig).toHaveBeenCalledTimes(2);
  });

  it('offers a global assignment even when the project already assigns that vision model', async () => {
    setState(storePath('providers', 0, 'models', 'gpt-5-mini', 'capabilities', 'vision', true));
    flushSolid();
    clientMocks.openCodeConfig.mockResolvedValue({
      smallModel: null,
      agentModels: { vision: { providerID: 'openai', modelID: 'gpt-5-mini' } },
      globalVisionModel: null,
      commitMessageModel: null,
      autoApproveModel: null,
    });
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const row = Array.from(
      container?.querySelectorAll<HTMLElement>('.models-model-row') ?? []
    ).find((item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5 mini');
    row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    const button = findButton(document, 'Use for vision agent');
    expect(button).not.toBeNull();
    button?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(clientMocks.saveModelRouting).toHaveBeenCalledWith({
      target: 'agent',
      agentName: 'vision',
      providerID: 'openai',
      modelID: 'gpt-5-mini',
      unset: undefined,
    });
  });

  it('does not overwrite refreshed tags with an older routing response', async () => {
    const oldRouting = {
      smallModel: null,
      agentModels: {},
      commitMessageModel: null,
      autoApproveModel: null,
    };
    let finishOldRead!: (value: typeof oldRouting) => void;
    clientMocks.openCodeConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldRead = resolve;
        })
    );
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    clientMocks.openCodeConfig.mockResolvedValue({
      ...oldRouting,
      agentModels: { vision: { providerID: 'openai', modelID: 'gpt-5' } },
    });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'providers/refresh' } }));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    finishOldRead(oldRouting);
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('[aria-label="Agent model: vision"]')).not.toBeNull();
  });

  it.each([
    [
      {
        available: false,
        reason: 'Prompt completion requires an API key, not a subscription or OAuth connection.',
      },
    ],
    [
      {
        available: false,
        reason: 'This provider has no supported direct completion API in Varro.',
      },
    ],
  ])('hides prompt completion actions for unsupported connections: %j', async (support) => {
    clientMocks.promptCompletionModels.mockResolvedValue({ 'openai/gpt-5-mini': support });
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const row = Array.from(
      container?.querySelectorAll<HTMLElement>('.models-model-row') ?? []
    ).find((item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5 mini');
    row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    const button = findButton(document, 'Use for prompt completion');
    expect(button).toBeUndefined();
    expect(findButton(document, 'Test prompt completion')).toBeUndefined();
    expect(clientMocks.saveModelRouting).not.toHaveBeenCalled();
    expect(findButton(document, 'Use for commit messages')?.disabled).toBe(false);
  });

  it('allows removing an existing unsupported prompt completion assignment', async () => {
    clientMocks.promptCompletionModels.mockResolvedValue({});
    clientMocks.openCodeConfig.mockResolvedValue({
      smallModel: null,
      commitMessageModel: null,
      autoApproveModel: null,
      agentModels: {},
      promptCompletionModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
    });
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const row = Array.from(
      container?.querySelectorAll<HTMLElement>('.models-model-row') ?? []
    ).find((item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5 mini');
    row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    const button = findButton(document, "Don't use for prompt completion");
    expect(button?.disabled).toBe(false);
    expect(findButton(document, 'Test prompt completion')).toBeUndefined();
    button?.click();
    flushSolid();
    expect(clientMocks.saveModelRouting).toHaveBeenCalledWith({
      target: 'prompt_completion',
      providerID: 'openai',
      modelID: 'gpt-5-mini',
      unset: true,
    });
  });

  it('fails closed while API support is loading or verification fails', async () => {
    clientMocks.promptCompletionModels.mockRejectedValue(new Error('Disconnected'));
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    const row = Array.from(
      container?.querySelectorAll<HTMLElement>('.models-model-row') ?? []
    ).find((item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5 mini');
    row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    const button = findButton(document, 'Use for prompt completion');
    expect(button).toBeUndefined();
    await Promise.resolve();
    flushSolid();
    expect(findButton(document, 'Use for prompt completion')).toBeUndefined();
    expect(findButton(document, 'Test prompt completion')).toBeUndefined();
  });

  it('does not restore eligibility from an obsolete provider connection response', async () => {
    let finishOldRead!: (value: { 'openai/gpt-5-mini': { available: boolean } }) => void;
    clientMocks.promptCompletionModels.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldRead = resolve;
        })
    );
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    clientMocks.promptCompletionModels.mockResolvedValue({
      'openai/gpt-5-mini': { available: false, reason: 'Requires an API key' },
    });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'providers/refresh' } }));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    finishOldRead({ 'openai/gpt-5-mini': { available: true } });
    await Promise.resolve();
    flushSolid();
    const row = Array.from(
      container?.querySelectorAll<HTMLElement>('.models-model-row') ?? []
    ).find((item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5 mini');
    row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    expect(findButton(document, 'Use for prompt completion')).toBeUndefined();
  });

  it.each([
    ['small_model', 'Use as small model', false, undefined],
    ['small_model', "Don't use as small model", true, undefined],
    ['commit_message', 'Use for commit messages', false, undefined],
    ['commit_message', "Don't use for commit messages", true, undefined],
    ['followups', 'Use for follow-ups', false, undefined],
    ['followups', 'Use session model for follow-ups', true, undefined],
    ['auto_approve', 'Use for auto-approve', false, undefined],
    ['auto_approve', "Don't use for auto-approve", true, undefined],
    ['prompt_completion', 'Use for prompt completion', false, undefined],
    ['prompt_completion', "Don't use for prompt completion", true, undefined],
    ['agent', 'Use for review agent', false, 'review'],
    ['agent', "Don't use for review agent", true, 'review'],
  ])('closes the menu immediately for %s: %s', async (target, label, unset, agentName) => {
    const route = unset ? { providerID: 'openai', modelID: 'gpt-5-mini' } : null;
    const savedRouting = {
      smallModel: route,
      commitMessageModel: route,
      autoApproveModel: route,
      promptCompletionModel: route,
      followupModel: route,
      agentModels: route ? { review: route } : {},
    };
    clientMocks.openCodeConfig.mockResolvedValue(savedRouting);
    setState(
      storePath('serverStatus', { state: 'running', url: 'mock://opencode', apiVersion: 2 })
    );
    flushSolid();
    let resolveSave!: (value: typeof savedRouting) => void;
    clientMocks.saveModelRouting.mockImplementation(
      () => new Promise<typeof savedRouting>((resolve) => (resolveSave = resolve))
    );
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const row = Array.from(
      container?.querySelectorAll<HTMLElement>('.models-model-row') ?? []
    ).find((item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5 mini');
    expect(row).toBeTruthy();

    row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    const button = findButton(document, label);
    expect(button).toBeTruthy();
    button?.click();
    flushSolid();

    expect(clientMocks.saveModelRouting).toHaveBeenCalledWith({
      target,
      providerID: 'openai',
      modelID: 'gpt-5-mini',
      unset: unset ? true : undefined,
      agentName,
    });
    expect(document.querySelector('.models-context-menu')).toBeNull();

    row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    const reopenedMenu = document.querySelector('.models-context-menu');
    expect(reopenedMenu).not.toBeNull();
    resolveSave(savedRouting);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(refreshRoutingStateMock).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.models-context-menu')).toBe(reopenedMenu);
  });

  it('keeps the model context menu inside the viewport', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(220);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(500);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(300);
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const row = container?.querySelector<HTMLElement>('.models-model-row');
    row?.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 490,
        clientY: 290,
      })
    );
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const menu = document.querySelector<HTMLElement>('.models-context-menu');
    expect(menu?.style.left).toBe('272px');
    expect(menu?.style.top).toBe('52px');
  });

  it('shows pinned models and pins or unpins them from the context menu', async () => {
    setState(storePath('pinnedModels', ['openai:gpt-5']));
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const row = Array.from(container?.querySelectorAll('.models-model-row') || []).find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5'
    ) as HTMLElement;
    expect(row.querySelector('[aria-label="Pinned model"]')).not.toBeNull();

    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
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
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(row.querySelector('[aria-label="Pinned model"]')).toBeNull();
    expect(document.querySelector('.models-context-menu')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.pinnedModels)!)).toEqual([]);

    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    const pinButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.models-context-menu-item')
    ).find((item) => item.textContent === 'Pin model');
    pinButton?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(row.querySelector('[aria-label="Pinned model"]')).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.pinnedModels)!)).toEqual([
      'openai:gpt-5',
    ]);
  });

  it('hides a model behind the model catalog and restores it', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const modelRows = () =>
      Array.from(container?.querySelectorAll<HTMLElement>('.models-model-row') ?? []);
    const gpt5Row = modelRows().find(
      (row) => row.querySelector('.models-model-name')?.textContent === 'GPT-5'
    );
    gpt5Row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    findButton(document, 'Hide model')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(modelRows()).toHaveLength(1);
    expect(modelRows()[0]?.textContent).toContain('GPT-5 mini');
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.addedModels)!)).toEqual([
      'openai:*',
      'openai:gpt-5-mini',
    ]);

    findButton(container, 'Add models')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const dialog = document.body.querySelector<HTMLElement>('.models-model-catalog-dialog');
    expect(dialog?.querySelectorAll('.models-model-catalog-row')).toHaveLength(2);
    expect(dialog?.querySelector('.models-model-catalog-id')?.textContent).toBe('(gpt-5-mini)');
    const hiddenModelRow = Array.from(
      dialog?.querySelectorAll<HTMLElement>('.models-model-catalog-row') ?? []
    ).find((row) => row.querySelector('.models-model-catalog-id')?.textContent === '(gpt-5)');
    const hiddenModelCheckbox = hiddenModelRow?.querySelector<HTMLInputElement>('.models-checkbox');
    expect(hiddenModelCheckbox?.checked).toBe(false);
    hiddenModelCheckbox?.click();
    flushSolid();
    findButton(dialog, 'Save changes')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(modelRows()).toHaveLength(2);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.addedModels)!)).toEqual([
      'openai:*',
      'openai:gpt-5-mini',
      'openai:gpt-5',
    ]);
  });

  it('preserves untoggled models when hiding another model', async () => {
    setState(storePath('hiddenModels', ['openai:gpt-5-mini']));
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const modelRows = () =>
      Array.from(container?.querySelectorAll<HTMLElement>('.models-model-row') ?? []);
    const gpt5Row = modelRows().find(
      (row) => row.querySelector('.models-model-name')?.textContent === 'GPT-5'
    );
    gpt5Row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    findButton(document, 'Hide model')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const remainingCheckbox = modelRows()[0]?.querySelector<HTMLInputElement>('.models-checkbox');
    expect(modelRows()).toHaveLength(1);
    expect(modelRows()[0]?.textContent).toContain('GPT-5 mini');
    expect(remainingCheckbox?.checked).toBe(false);
    expect(state.hiddenModels).toEqual(['openai:gpt-5-mini']);
  });

  it('renames and resets a model display name without changing its ID', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const row = Array.from(container?.querySelectorAll('.models-model-row') || []).find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5'
    ) as HTMLElement;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    findButton(document, 'Rename model')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const nameInput = dialog?.querySelector<HTMLInputElement>('[aria-label="Model display name"]');
    expect(dialog?.textContent).toContain('GPT-5');
    expect(nameInput?.value).toBe('GPT-5');
    if (nameInput) {
      nameInput.value = 'Primary coder';
    }
    findButton(dialog, 'Save')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

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
    flushSolid();
    findButton(document, 'Reset model name')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

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
    flushSolid();
    await Promise.resolve();
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const row = Array.from(container?.querySelectorAll('.models-model-row') || []).find(
      (item) => item.querySelector('.models-model-name')?.textContent === 'GPT-5 mini'
    ) as HTMLElement;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();

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
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(clientMocks.saveModelRouting).toHaveBeenCalledWith({
      target: 'small_model',
      providerID: 'openai',
      modelID: 'gpt-5-mini',
      unset: true,
    });
  });

  it('shows workspace status', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.textContent).toContain('Workspaces: ws-1 (connected)');
    expect(refreshRoutingStateMock).toHaveBeenCalled();
    expect(clientMocks.providerAuth).not.toHaveBeenCalled();
    expect(clientMocks.workspaceStatus).not.toHaveBeenCalled();
  });

  it('collapses hidden providers without routing tags by default', async () => {
    clientMocks.openCodeConfig.mockResolvedValue({});
    setState(storePath('hiddenProviders', ['openai']));
    flushSolid();

    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.models-provider-count')?.textContent).toBe('2/2');
    expect(container?.querySelector('.models-provider-hidden-marker')?.textContent).toBe('Hidden');
    expect(container?.querySelector('.models-chevron')?.classList.contains('expanded')).toBe(false);
    expect(container?.querySelector('.ui-icon.models-chevron')).toBeInstanceOf(HTMLSpanElement);
    expect(container?.querySelector('.models-model-row')).toBeNull();
  });

  it.each([
    ['smallModel', 'Small model'],
    ['commitMessageModel', 'Commit message model'],
    ['autoApproveModel', 'Auto-approve model'],
    ['promptCompletionModel', 'Prompt completion model'],
    ['followupModel', 'Follow-ups model'],
    ['agentModels', 'Agent model: vision'],
  ])('expands a hidden provider with a %s routing tag', async (target, label) => {
    const route = { providerID: 'openai', modelID: 'gpt-5-mini' };
    clientMocks.openCodeConfig.mockResolvedValue({
      [target]: target === 'agentModels' ? { vision: route } : route,
    });
    setState(storePath('hiddenProviders', ['openai']));
    flushSolid();
    setState(storePath('hiddenModels', ['openai:gpt-5', 'openai:gpt-5-mini']));
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const section = container?.querySelector<HTMLElement>('.models-provider');
    expect(section?.querySelector('.models-chevron')?.classList.contains('expanded')).toBe(true);
    expect(section?.querySelectorAll('.models-model-row')).toHaveLength(2);
    expect(section?.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    if (target === 'followupModel') {
      expect(section?.querySelector(`[aria-label="${label}"]`)?.textContent).toBe('followup');
    }
    expect(section?.querySelector('.models-provider-hidden-marker')?.textContent).toBe('Hidden');
    expect(state.hiddenProviders).toEqual(['openai']);
    expect(state.hiddenModels).toEqual(['openai:gpt-5', 'openai:gpt-5-mini']);

    section?.querySelector<HTMLButtonElement>('.models-provider-toggle')?.click();
    flushSolid();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'providers/refresh' } }));
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(clientMocks.openCodeConfig).toHaveBeenCalledTimes(2);
    expect(section?.querySelector('.models-chevron')?.classList.contains('expanded')).toBe(false);
    expect(section?.querySelector('.models-model-row')).toBeNull();
  });

  it('expands a hidden provider when a routing tag is added after loading', async () => {
    clientMocks.openCodeConfig.mockResolvedValue({});
    setState(storePath('hiddenProviders', ['openai']));
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('.models-model-row')).toBeNull();

    clientMocks.openCodeConfig.mockResolvedValue({
      promptCompletionModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
    });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'providers/refresh' } }));
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.models-chevron')?.classList.contains('expanded')).toBe(true);
    expect(container?.querySelector('[aria-label="Prompt completion model"]')).not.toBeNull();
    expect(state.hiddenProviders).toEqual(['openai']);
  });

  it('keeps a tagged provider expanded when it is hidden', async () => {
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    container
      ?.querySelector<HTMLElement>('.models-provider-header')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    findButton(document.body, 'Hide provider')?.click();
    flushSolid();

    expect(state.hiddenProviders).toEqual(['openai']);
    expect(container?.querySelector('.models-chevron')?.classList.contains('expanded')).toBe(true);
    expect(container?.querySelector('[aria-label="Small model"]')).not.toBeNull();
  });

  it('keeps a hidden provider expanded and hidden when a model is enabled', async () => {
    clientMocks.openCodeConfig.mockResolvedValue({});
    setState(storePath('hiddenProviders', ['openai']));
    flushSolid();
    setState(storePath('hiddenModels', ['openai:gpt-5-mini']));
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const section = container?.querySelector<HTMLElement>('.models-provider');
    section?.querySelector<HTMLButtonElement>('.models-provider-toggle')?.click();
    flushSolid();
    const modelCheckbox = Array.from(
      section?.querySelectorAll<HTMLInputElement>('.models-model-row .models-checkbox') ?? []
    ).find((checkbox) => !checkbox.checked);
    modelCheckbox?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.models-provider')).toBe(section);
    expect(section?.querySelector('.models-chevron')?.classList.contains('expanded')).toBe(true);
    expect(section?.querySelectorAll('.models-model-row')).toHaveLength(2);
    expect(modelCheckbox?.checked).toBe(true);
    expect(state.hiddenProviders).toEqual(['openai']);
    expect(state.hiddenModels).toEqual([]);
  });

  it('keeps a hidden provider expanded when its managed model set changes', async () => {
    clientMocks.openCodeConfig.mockResolvedValue({});
    setState(storePath('hiddenProviders', ['openai']));
    flushSolid();
    setState(storePath('addedModels', ['openai:*', 'openai:gpt-5', 'openai:gpt-5-mini']));
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const section = container?.querySelector<HTMLElement>('.models-provider');
    section?.querySelector<HTMLButtonElement>('.models-provider-toggle')?.click();
    flushSolid();
    findButton(section, 'Add models')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const dialog = document.body.querySelector<HTMLElement>('.models-model-catalog-dialog');
    const removedModelRow = Array.from(
      dialog?.querySelectorAll<HTMLElement>('.models-model-catalog-row') ?? []
    ).find((row) => row.querySelector('.models-model-catalog-id')?.textContent === '(gpt-5-mini)');

    expect(container?.querySelector('.models-provider')).toBe(section);
    expect(section?.querySelector('.models-chevron')?.classList.contains('expanded')).toBe(true);

    removedModelRow?.querySelector<HTMLInputElement>('.models-checkbox')?.click();
    flushSolid();
    findButton(dialog, 'Save changes')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.models-provider')).toBe(section);
    expect(section?.querySelector('.models-chevron')?.classList.contains('expanded')).toBe(true);
    expect(section?.querySelectorAll('.models-model-row')).toHaveLength(1);
    expect(section?.querySelector('.models-model-name')?.textContent).toBe('GPT-5');
    expect(state.hiddenProviders).toEqual(['openai']);
  });

  it('sorts hidden and fully disabled providers after enabled providers', async () => {
    setState(
      storePath('providers', [
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
      ])
    );
    flushSolid();
    setState(storePath('hiddenProviders', ['openai']));
    flushSolid();
    setState(storePath('hiddenModels', ['beta:beta']));
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

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
    flushSolid();
    findButton(document.body, 'Show provider')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(providerNames()).toEqual(['OpenAI', 'Alpha', 'Aardvark']);

    const disabledSection = Array.from(
      container?.querySelectorAll<HTMLElement>('.models-provider') ?? []
    ).find((section) => section.querySelector('.models-provider-name')?.textContent === 'Aardvark');
    disabledSection?.querySelector<HTMLButtonElement>('.models-provider-toggle')?.click();
    flushSolid();
    disabledSection
      ?.querySelector<HTMLInputElement>('.models-provider-header .models-checkbox')
      ?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(providerNames()).toEqual(['OpenAI', 'Aardvark', 'Alpha']);
    const movedSection = Array.from(
      container?.querySelectorAll<HTMLElement>('.models-provider') ?? []
    ).find((section) => section.querySelector('.models-provider-name')?.textContent === 'Aardvark');
    expect(movedSection).toBe(disabledSection);
    expect(movedSection?.querySelector('.models-chevron')?.classList.contains('expanded')).toBe(
      true
    );
  });

  it('reorders active providers by dragging and persists their order', async () => {
    setState(
      storePath('providers', [
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
      ])
    );
    flushSolid();
    setState(storePath('hiddenProviders', ['hidden']));
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

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
    flushSolid();
    dispatchDragEvent(sections[0]!, 'dragover', dataTransfer);
    flushSolid();
    expect(sections[1]?.classList.contains('is-dragging')).toBe(true);
    expect(sections[0]?.classList.contains('is-drag-over')).toBe(true);
    dispatchDragEvent(sections[0]!, 'drop', dataTransfer);
    flushSolid();

    expect(providerNames()).toEqual(['Alpha', 'OpenAI', 'Hidden']);
    expect(state.providerOrder).toEqual(['alpha', 'openai']);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.providerOrder)!)).toEqual([
      'alpha',
      'openai',
    ]);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Reorder provider: Alpha"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    flushSolid();
    expect(providerNames()).toEqual(['OpenAI', 'Alpha', 'Hidden']);
  });

  it('reorders models by dragging and persists their provider-scoped order', async () => {
    setState(storePath('hiddenModels', ['openai:gpt-5-mini']));
    flushSolid();
    cleanup = render(() => ModelsPanel(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

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
    flushSolid();
    dispatchDragEvent(rows[0]!, 'dragover', dataTransfer);
    flushSolid();
    expect(rows[1]?.classList.contains('is-dragging')).toBe(true);
    expect(rows[0]?.classList.contains('is-drag-over')).toBe(true);
    dispatchDragEvent(rows[0]!, 'drop', dataTransfer);
    flushSolid();

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
    flushSolid();
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
  flushSolid();
  return findButton(root, action);
}
