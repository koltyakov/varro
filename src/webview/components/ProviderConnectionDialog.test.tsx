import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import type { Provider } from '../types';
import {
  markProviderAuthFailure,
  providerRequiresReconnection,
  resetProviderConnectionState,
} from '../lib/provider-connection-state';
import { resetDefaultAppState, setState } from '../lib/state';
import { ProviderConnectionDialog } from './ProviderConnectionDialog';

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

type DialogProps = Parameters<typeof ProviderConnectionDialog>[0];

const clientMocks = vi.hoisted(() => ({
  authorizeProvider: vi.fn(),
  completeProviderAuth: vi.fn(),
  connectApiProvider: vi.fn(),
}));
const postMessageMock = vi.hoisted(() => vi.fn());
const openProviderSetupMock = vi.hoisted(() => vi.fn());

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise provider-dialog integration with bridge and client modules. */
vi.mock('../lib/bridge', () => ({ postMessage: postMessageMock }));
vi.mock('../lib/client', () => ({
  client: {
    config: {
      authorizeProvider: clientMocks.authorizeProvider,
      completeProviderAuth: clientMocks.completeProviderAuth,
      connectApiProvider: clientMocks.connectApiProvider,
    },
  },
}));
vi.mock('../lib/provider-setup', () => ({ openProviderSetup: openProviderSetupMock }));

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;

function catalogProvider(id: string, name = id): Provider {
  return { id, name, source: 'api', models: {} };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderDialog(overrides: Partial<DialogProps> = {}) {
  const onClose = vi.fn();
  const props: DialogProps = {
    catalogProviders: [
      catalogProvider('anthropic', 'Anthropic'),
      catalogProvider('openai', 'OpenAI'),
    ],
    providerLoadError: '',
    isLoadingProviders: false,
    onClose,
    ...overrides,
  };
  cleanup = render(() => ProviderConnectionDialog(props), container!);
  return onClose;
}

function dialog() {
  return document.body.querySelector<HTMLElement>('.provider-connect-dialog');
}

function optionElements() {
  return Array.from(dialog()!.querySelectorAll<HTMLButtonElement>('.provider-connect-option'));
}

function optionByName(name: string) {
  const match = optionElements().find(
    (option) => option.querySelector('.provider-connect-option-name')?.textContent === name
  );
  if (!match) throw new Error(`No provider option named ${name}`);
  return match;
}

function searchInput() {
  return dialog()!.querySelector<HTMLInputElement>('[aria-label="Search providers"]');
}

function methodButton(label: string) {
  return Array.from(dialog()!.querySelectorAll<HTMLButtonElement>('.provider-connect-method')).find(
    (button) => button.textContent?.includes(label)
  );
}

function findButton(text: string) {
  return Array.from(dialog()!.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === text
  );
}

function primaryButton() {
  return dialog()!.querySelector<HTMLButtonElement>('.provider-connect-primary')!;
}

function alertText() {
  return dialog()!.querySelector('[role="alert"]')?.textContent ?? '';
}

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressKey(element: HTMLElement, key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

async function flush(count = 6) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function chooseProvider(name: string) {
  optionByName(name).click();
}

function chooseMethod(label: string) {
  const button = methodButton(label);
  if (!button) throw new Error(`No auth method labelled ${label}`);
  button.click();
}

async function startApiFlow() {
  chooseProvider('OpenAI');
  chooseMethod('API key');
  const keyInput = dialog()!.querySelector<HTMLInputElement>('input[type="password"]');
  if (!keyInput) throw new Error('No API key input');
  return keyInput;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  resetDefaultAppState();
  resetProviderConnectionState();
  originalResizeObserver = globalThis.ResizeObserver;
  // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
  postMessageMock.mockReset();
  openProviderSetupMock.mockReset();
  clientMocks.authorizeProvider.mockReset();
  clientMocks.completeProviderAuth.mockReset();
  clientMocks.connectApiProvider.mockReset();
  clientMocks.authorizeProvider.mockResolvedValue({
    url: 'https://auth.example.com/oauth',
    method: 'auto',
    instructions: 'Approve access in your browser',
  });
  clientMocks.completeProviderAuth.mockResolvedValue(true);
  clientMocks.connectApiProvider.mockResolvedValue(true);
  setState('providerAuthMethods', {
    anthropic: [{ type: 'oauth', label: 'Claude subscription' }],
    openai: [{ type: 'api', label: 'API key' }],
  });
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  resetDefaultAppState();
  resetProviderConnectionState();
  if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
  else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  vi.restoreAllMocks();
});

describe('ProviderConnectionDialog provider list', () => {
  it('renders sorted provider options with method counts', () => {
    renderDialog();

    expect(dialog()?.getAttribute('aria-labelledby')).toBe('provider-connect-title');
    expect(dialog()?.textContent).toContain('Connect provider');
    expect(dialog()?.textContent).toContain('Choose a provider to connect to OpenCode.');
    expect(optionElements().map((option) => option.textContent)).toEqual([
      expect.stringContaining('Anthropic'),
      expect.stringContaining('OpenAI'),
    ]);
    expect(optionByName('Anthropic').textContent).toContain('1 method');
    expect(optionByName('Anthropic').querySelector('.provider-connect-option-id')).toBeNull();
    expect(searchInput()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('includes auth-plugin-only providers named from configured state or a formatted id', () => {
    setState(
      'providerAuthMethods',
      reconcile({
        'auth-only': [{ type: 'oauth', label: 'Auth only login' }],
        'zendesk-chat': [{ type: 'oauth', label: 'Zendesk login' }],
      })
    );
    setState('providers', [catalogProvider('zendesk-chat', 'Zendesk Support')]);

    renderDialog({ catalogProviders: [] });

    expect(
      optionElements().map(
        (option) => option.querySelector('.provider-connect-option-name')?.textContent
      )
    ).toEqual(['Auth Only', 'Zendesk Support']);
  });

  it('shows a skeleton instead of the picker while providers load', () => {
    renderDialog({ isLoadingProviders: true });

    expect(dialog()?.querySelector('.provider-connect-skeleton')).toBeInstanceOf(HTMLElement);
    expect(searchInput()).toBeNull();
    expect(optionElements()).toHaveLength(0);
  });

  it('surfaces catalog load errors next to the auth-plugin fallbacks', () => {
    renderDialog({
      catalogProviders: [],
      providerLoadError: 'Catalog request failed (503)',
    });

    expect(alertText()).toContain('Could not load the full provider catalog');
    expect(alertText()).toContain('Catalog request failed (503)');
    expect(optionByName('Openai')).toBeInstanceOf(HTMLButtonElement);
  });

  it('filters providers by name or id and reports empty results', () => {
    renderDialog({
      catalogProviders: [
        catalogProvider('anthropic', 'Anthropic'),
        catalogProvider('custom-cloud', 'Custom Cloud'),
        catalogProvider('openai', 'OpenAI'),
      ],
    });

    type(searchInput()!, 'custom');

    expect(optionElements()).toHaveLength(1);
    expect(
      optionByName('Custom Cloud').querySelector('.provider-connect-option-id')?.textContent
    ).toBe('custom-cloud');

    type(searchInput()!, 'no-such-provider');

    expect(optionElements()).toHaveLength(0);
    expect(dialog()?.textContent).toContain('No matching providers.');
  });

  it('moves the active option with arrow keys and selects it with Enter', () => {
    renderDialog();

    const search = searchInput()!;
    expect(search.getAttribute('aria-activedescendant')).toBe('provider-connect-option-0');

    pressKey(search, 'ArrowDown');
    expect(search.getAttribute('aria-activedescendant')).toBe('provider-connect-option-1');

    pressKey(search, 'ArrowUp');
    expect(search.getAttribute('aria-activedescendant')).toBe('provider-connect-option-0');

    pressKey(search, 'ArrowDown');
    const enter = pressKey(search, 'Enter');

    expect(enter.defaultPrevented).toBe(true);
    expect(searchInput()).toBeNull();
    expect(dialog()?.querySelector('.provider-connect-subtitle')?.textContent).toBe('OpenAI');
  });
});

describe('ProviderConnectionDialog method selection', () => {
  it('preselects a trimmed initial provider id', () => {
    renderDialog({ initialProviderID: ' openai ' });

    expect(searchInput()).toBeNull();
    expect(dialog()?.querySelector('.provider-connect-subtitle')?.textContent).toBe('OpenAI');
    expect(methodButton('API key')).toBeInstanceOf(HTMLButtonElement);
  });

  it('ignores initial provider ids that are not offered', () => {
    renderDialog({ initialProviderID: 'unknown-provider' });

    expect(searchInput()).toBeInstanceOf(HTMLInputElement);
  });

  it('locks onto the initial provider for re-authentication', () => {
    renderDialog({
      initialProviderID: 'anthropic',
      lockProvider: true,
      reauthentication: true,
    });

    expect(dialog()?.textContent).toContain('Re-authenticate provider');
    expect(dialog()?.querySelector('.provider-connect-subtitle')?.textContent).toBe('Anthropic');
    expect(findButton('Back to providers')).toBeUndefined();
    expect(methodButton('Claude subscription')).toBeInstanceOf(HTMLButtonElement);
  });

  it('lists each auth method with its label and type, then opens the OAuth handoff', () => {
    setState('providerAuthMethods', {
      openai: [
        { type: 'oauth', label: 'ChatGPT subscription' },
        { type: 'api', label: 'API key' },
      ],
    });
    renderDialog();

    chooseProvider('OpenAI');

    expect(dialog()?.textContent).toContain('Choose how you want to authenticate.');
    const methods = Array.from(dialog()!.querySelectorAll('.provider-connect-method'));
    expect(methods[0]?.textContent).toContain('ChatGPT subscription');
    expect(methods[0]?.textContent).toContain('OAuth');
    expect(methods[1]?.textContent).toContain('API key');
    expect(findButton('Back to providers')).toBeInstanceOf(HTMLButtonElement);

    chooseMethod('ChatGPT subscription');

    expect(dialog()?.textContent).toContain('Continue with OpenAI');
    expect(dialog()?.textContent).toContain('Your browser will open to complete authorization.');
    expect(primaryButton().textContent).toBe('Continue in browser');
  });

  it('falls back to a generic API key method for catalog providers without plugins', () => {
    renderDialog({
      catalogProviders: [catalogProvider('grok', 'Grok')],
    });

    chooseProvider('Grok');

    expect(methodButton('API key')).toBeInstanceOf(HTMLButtonElement);
  });

  it('directs providers without embedded methods to terminal setup', () => {
    setState('providerAuthMethods', { 'legacy-idp': [] });
    renderDialog({ catalogProviders: [catalogProvider('legacy-idp', 'Legacy')] });

    chooseProvider('Legacy');

    expect(dialog()?.textContent).toContain(
      'This provider has no embedded authentication methods. Use terminal setup instead.'
    );
    expect(findButton('Use terminal setup')).toBeInstanceOf(HTMLButtonElement);
  });

  it('returns to the provider list from the methods step', () => {
    renderDialog();

    chooseProvider('OpenAI');
    expect(findButton('Back to providers')).toBeInstanceOf(HTMLButtonElement);
    findButton('Back to providers')!.click();

    expect(searchInput()).toBeInstanceOf(HTMLInputElement);
    expect(dialog()?.querySelector('.provider-connect-method')).toBeNull();
  });
});

describe('ProviderConnectionDialog API key flow', () => {
  it('keeps Connect disabled until a non-blank API key is entered', async () => {
    renderDialog();
    const keyInput = await startApiFlow();

    expect(primaryButton().textContent).toBe('Connect');
    expect(primaryButton().disabled).toBe(true);

    type(keyInput, '   ');

    expect(primaryButton().disabled).toBe(true);

    type(keyInput, 'sk-test');

    expect(primaryButton().disabled).toBe(false);
  });

  it('connects with the trimmed key, refreshes providers, and clears failure notices', async () => {
    markProviderAuthFailure('openai', 'message-1');
    expect(providerRequiresReconnection('openai')).toBe(true);
    const onClose = renderDialog();
    const keyInput = await startApiFlow();

    type(keyInput, '  sk-test  ');
    primaryButton().click();
    await flush();

    expect(clientMocks.connectApiProvider).toHaveBeenCalledWith(
      { providerID: 'openai', key: 'sk-test', metadata: {} },
      { signal: expect.any(AbortSignal) }
    );
    expect(postMessageMock).toHaveBeenCalledWith({ type: 'providers/refresh' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(providerRequiresReconnection('openai')).toBe(false);
  });

  it('posts providers/reauthenticated when reconnecting a locked provider', async () => {
    const onClose = renderDialog({
      initialProviderID: 'openai',
      lockProvider: true,
      reauthentication: true,
    });
    chooseMethod('API key');
    const keyInput = dialog()!.querySelector<HTMLInputElement>('input[type="password"]')!;

    type(keyInput, 'sk-again');
    primaryButton().click();
    await flush();

    expect(postMessageMock).toHaveBeenCalledWith({ type: 'providers/reauthenticated' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the failure and stays open when connecting is rejected', async () => {
    clientMocks.connectApiProvider.mockRejectedValue(new Error('Invalid API key'));
    const onClose = renderDialog();
    const keyInput = await startApiFlow();

    type(keyInput, 'sk-bad');
    primaryButton().click();
    await flush();

    expect(alertText()).toContain('Invalid API key');
    expect(onClose).not.toHaveBeenCalled();
    expect(primaryButton().disabled).toBe(false);
    expect(primaryButton().textContent).toBe('Connect');
  });

  it('disables inputs and shows Connecting while the request is pending', async () => {
    const completion = deferred<boolean>();
    clientMocks.connectApiProvider.mockImplementation(() => completion.promise);
    const onClose = renderDialog();
    const keyInput = await startApiFlow();

    type(keyInput, 'sk-slow');
    primaryButton().click();
    await flush();

    expect(primaryButton().textContent).toBe('Connecting...');
    expect(primaryButton().disabled).toBe(true);
    expect(keyInput.disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    completion.resolve(true);
    await flush();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('sends visible text prompt inputs as trimmed metadata', async () => {
    setState('providerAuthMethods', {
      openai: [
        {
          type: 'api',
          label: 'Azure OpenAI',
          prompts: [
            { type: 'text', key: 'resourceName', message: 'Resource name', placeholder: 'my-org' },
          ],
        },
      ],
    });
    renderDialog();
    chooseProvider('OpenAI');
    chooseMethod('Azure OpenAI');

    const promptInput = dialog()!.querySelectorAll<HTMLInputElement>('.provider-connect-input')[0]!;
    expect(promptInput.getAttribute('placeholder')).toBe('my-org');
    const keyInput = dialog()!.querySelector<HTMLInputElement>('input[type="password"]')!;

    type(keyInput, 'sk-azure');
    expect(primaryButton().disabled).toBe(true);

    type(promptInput, ' my-org ');
    expect(primaryButton().disabled).toBe(false);

    primaryButton().click();
    await flush();

    expect(clientMocks.connectApiProvider).toHaveBeenCalledWith(
      {
        providerID: 'openai',
        key: 'sk-azure',
        metadata: { resourceName: 'my-org' },
      },
      { signal: expect.any(AbortSignal) }
    );
  });

  it('renders select prompts as a listbox and reveals conditional prompts', async () => {
    setState('providerAuthMethods', {
      gitlab: [
        {
          type: 'api',
          label: 'Self-hosted GitLab',
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
            {
              type: 'text',
              key: 'baseUrl',
              message: 'GitLab URL',
              placeholder: 'https://git.example.com',
              when: { key: 'deployment', op: 'eq', value: 'self-managed' },
            },
          ],
        },
      ],
    });
    renderDialog({ catalogProviders: [catalogProvider('gitlab', 'GitLab')] });
    chooseProvider('GitLab');
    chooseMethod('Self-hosted GitLab');

    expect(dialog()?.querySelector('select')).toBeNull();
    const trigger = dialog()!.querySelector<HTMLButtonElement>('.provider-connect-select-trigger')!;
    expect(trigger.textContent).toContain('Select an option');
    expect(dialog()?.textContent).not.toContain('GitLab URL');

    trigger.click();

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(dialog()?.querySelector('.provider-connect-body')?.classList).toContain(
      'has-open-select'
    );
    expect(dialog()?.textContent).toContain('Hosted by GitLab');

    const selfManaged = Array.from(
      dialog()!.querySelectorAll<HTMLButtonElement>('.provider-connect-select-option')
    ).find((option) => option.textContent?.trim() === 'Self-managed')!;
    selfManaged.click();

    expect(trigger.textContent).toContain('Self-managed');
    expect(dialog()?.querySelector('.provider-connect-body')?.classList).not.toContain(
      'has-open-select'
    );

    const baseUrlInput = dialog()!.querySelector<HTMLInputElement>(
      '.provider-connect-input[placeholder="https://git.example.com"]'
    );
    expect(baseUrlInput).toBeInstanceOf(HTMLInputElement);

    type(baseUrlInput!, 'https://git.example.com');
    const keyInput = dialog()!.querySelector<HTMLInputElement>('input[type="password"]')!;
    type(keyInput, 'glpat-token');
    primaryButton().click();
    await flush();

    expect(clientMocks.connectApiProvider).toHaveBeenCalledWith(
      {
        providerID: 'gitlab',
        key: 'glpat-token',
        metadata: { deployment: 'self-managed', baseUrl: 'https://git.example.com' },
      },
      { signal: expect.any(AbortSignal) }
    );
  });
});

describe('ProviderConnectionDialog OAuth flow', () => {
  it('authorizes, opens the browser, and completes an automatic exchange', async () => {
    const completion = deferred<boolean>();
    clientMocks.completeProviderAuth.mockImplementation(() => completion.promise);
    const onClose = renderDialog();

    chooseProvider('Anthropic');
    chooseMethod('Claude subscription');
    primaryButton().click();
    await flush();

    expect(clientMocks.authorizeProvider).toHaveBeenCalledWith(
      { providerID: 'anthropic', method: 0, inputs: {} },
      { signal: expect.any(AbortSignal) }
    );
    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://auth.example.com/oauth' },
    });
    expect(clientMocks.completeProviderAuth).toHaveBeenCalledWith(
      { providerID: 'anthropic', method: 0 },
      { signal: expect.any(AbortSignal) }
    );
    expect(dialog()?.textContent).toContain('Approve access in your browser');
    expect(primaryButton().textContent).toBe('Waiting for authorization...');
    expect(primaryButton().disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    completion.resolve(true);
    await flush();

    expect(postMessageMock).toHaveBeenCalledWith({ type: 'providers/refresh' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('aborts a pending authorization exchange when the dialog closes', async () => {
    let capturedSignal: AbortSignal | undefined;
    clientMocks.completeProviderAuth.mockImplementation(
      (_body: TestRuntimeValue, options?: { signal?: AbortSignal }) => {
        capturedSignal = options?.signal;
        return new Promise<boolean>(() => {});
      }
    );
    const onClose = renderDialog();

    chooseProvider('Anthropic');
    chooseMethod('Claude subscription');
    primaryButton().click();
    await flush();

    expect(capturedSignal?.aborted).toBe(false);

    dialog()!.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click();

    expect(capturedSignal?.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('collects and submits an authorization code for manual exchanges', async () => {
    clientMocks.authorizeProvider.mockResolvedValue({
      url: 'https://auth.example.com/device',
      method: 'code',
      instructions: 'Enter code ABCD-1234 in your browser',
    });
    const onClose = renderDialog();

    chooseProvider('Anthropic');
    chooseMethod('Claude subscription');
    primaryButton().click();
    await flush();

    expect(dialog()?.textContent).toContain('Enter code ABCD-1234 in your browser');
    expect(
      dialog()!.querySelector('[aria-label="Copy authorization code: ABCD-1234"]')
    ).toBeInstanceOf(HTMLButtonElement);

    findButton('Open authorization page')!.click();
    expect(postMessageMock).toHaveBeenLastCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://auth.example.com/device' },
    });

    const codeInput = dialog()!.querySelector<HTMLInputElement>(
      '.provider-connect-authorization .provider-connect-input'
    )!;
    expect(primaryButton().textContent).toBe('Complete connection');

    primaryButton().click();
    await flush();
    expect(clientMocks.completeProviderAuth).not.toHaveBeenCalled();

    type(codeInput, 'GHIJ-7890');
    expect(primaryButton().disabled).toBe(false);
    primaryButton().click();
    await flush();

    expect(clientMocks.completeProviderAuth).toHaveBeenCalledWith(
      { providerID: 'anthropic', method: 0, code: 'GHIJ-7890' },
      { signal: expect.any(AbortSignal) }
    );
    expect(postMessageMock).toHaveBeenCalledWith({ type: 'providers/refresh' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surfaces authorization failures without closing', async () => {
    clientMocks.authorizeProvider.mockRejectedValue(new Error('Browser blocked the redirect'));
    const onClose = renderDialog();

    chooseProvider('Anthropic');
    chooseMethod('Claude subscription');
    primaryButton().click();
    await flush();

    expect(alertText()).toContain('Browser blocked the redirect');
    expect(onClose).not.toHaveBeenCalled();
    expect(primaryButton().textContent).toBe('Continue in browser');
    expect(primaryButton().disabled).toBe(false);
  });
});

describe('ProviderConnectionDialog closing and cancellation', () => {
  it('renders the close control with the shared icon sizing', () => {
    renderDialog();

    const closeIcon = dialog()?.querySelector<HTMLElement>('.provider-connect-close .ui-icon');
    expect(closeIcon?.style.getPropertyValue('--ui-icon-width')).toBe('16px');
    expect(closeIcon?.style.getPropertyValue('--ui-icon-height')).toBe('16px');
    expect(closeIcon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('closes on Escape from anywhere in the dialog', () => {
    const onClose = renderDialog();

    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns to the methods step from credential entry without closing', async () => {
    const onClose = renderDialog();
    const keyInput = await startApiFlow();
    type(keyInput, 'sk-discarded');

    findButton('Cancel')!.click();

    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()!.querySelector('input[type="password"]')).toBeNull();
    expect(methodButton('API key')).toBeInstanceOf(HTMLButtonElement);

    chooseMethod('API key');
    expect(dialog()!.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
  });

  it('hands off to terminal setup and closes', () => {
    const onClose = renderDialog();

    findButton('Use terminal setup')!.click();

    expect(openProviderSetupMock).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
