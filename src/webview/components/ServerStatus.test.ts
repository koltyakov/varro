import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { resetDefaultAppState, setState } from '../lib/state';

const postMessageMock = vi.hoisted(() => vi.fn());
const openProviderSetupMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/bridge', () => ({
  postMessage: postMessageMock,
  onMessage: vi.fn(),
}));

vi.mock('../lib/provider-setup', () => ({
  openProviderSetup: openProviderSetupMock,
}));

import { ServerStatus } from './ServerStatus';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

function renderServerStatus() {
  cleanup = render(() => ServerStatus(), container!);
}

describe('ServerStatus', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    resetDefaultAppState();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    container?.remove();
    container = null;
    resetDefaultAppState();
  });

  it('renders the starting state copy', () => {
    setState('serverStatus', { state: 'starting' });

    renderServerStatus();

    expect(container?.textContent).toContain('Starting OpenCode...');
    expect(container?.textContent).toContain('Spawning the local server');
  });

  it('renders the stopped state copy', () => {
    setState('serverStatus', { state: 'stopped' });

    renderServerStatus();

    expect(container?.textContent).toContain('Server not running');
    expect(container?.textContent).toContain('Waiting to connect...');
  });

  it('renders trimmed generic errors', () => {
    setState('serverStatus', { state: 'error', message: '  failed to bind port  ' });

    renderServerStatus();

    expect(container?.textContent).toContain('OpenCode could not start');
    expect(container?.textContent).toContain('failed to bind port');
    expect(container?.textContent).not.toContain('  failed to bind port  ');
  });

  it('shows install guidance for missing CLI errors and opens the docs links', () => {
    setState('serverStatus', { state: 'error', message: '  OpenCode CLI not found on PATH  ' });

    renderServerStatus();

    expect(container?.textContent).toContain('OpenCode is not installed');
    expect(container?.textContent).toContain('npm i -g opencode-ai');

    const buttons = Array.from(container?.querySelectorAll('button') || []);
    const inlineLink = buttons.find((button) => button.textContent?.includes('OpenCode'));
    const footerLink = buttons.find((button) => button.textContent?.includes('Learn more'));

    inlineLink?.click();
    footerLink?.click();

    expect(postMessageMock).toHaveBeenNthCalledWith(1, {
      type: 'vscode/open-external',
      payload: { url: 'https://opencode.ai' },
    });
    expect(postMessageMock).toHaveBeenNthCalledWith(2, {
      type: 'vscode/open-external',
      payload: { url: 'https://opencode.ai' },
    });
  });

  it('shows provider setup actions when the server is running without configured providers', () => {
    setState('serverStatus', { state: 'running', url: 'http://127.0.0.1:4096' });
    setState('providersLoaded', true);
    setState('providers', []);
    setState('providerAuthMethods', { openai: [{ type: 'api', label: 'API key' }] });

    renderServerStatus();

    expect(container?.textContent).toContain('No providers configured');
    expect(container?.textContent).toContain('opencode auth login');

    const buttons = Array.from(container?.querySelectorAll('button') || []);
    const setupButton = buttons.find((button) => button.textContent?.includes('Open terminal'));
    const docsButton = buttons.find((button) =>
      button.textContent?.includes('Provider setup docs')
    );

    setupButton?.click();
    docsButton?.click();

    expect(openProviderSetupMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://opencode.ai/docs/providers' },
    });
  });
});
