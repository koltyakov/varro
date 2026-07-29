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
    expect(container?.textContent).toContain('Install or update OpenCode if needed');

    const restartButton = Array.from(container?.querySelectorAll('button') || []).find(
      (button) => button.textContent?.trim() === 'Restart Server'
    );
    restartButton?.click();
    expect(postMessageMock).toHaveBeenCalledWith({ type: 'server/restart' });
  });

  it('renders trimmed generic errors', () => {
    setState('serverStatus', { state: 'error', message: '  failed to bind port  ' });

    renderServerStatus();

    expect(container?.textContent).toContain('OpenCode could not start');
    expect(container?.textContent).toContain('failed to bind port');
    expect(container?.textContent).not.toContain('  failed to bind port  ');

    const showOutput = Array.from(container?.querySelectorAll('button') || []).find(
      (button) => button.textContent?.trim() === 'Show Output'
    );
    showOutput?.click();
    expect(postMessageMock).toHaveBeenCalledWith({ type: 'vscode/show-output' });
  });

  it('shows install guidance for missing CLI errors and opens the docs links', () => {
    setState('serverStatus', { state: 'error', message: '  OpenCode CLI not found on PATH  ' });

    renderServerStatus();

    expect(container?.textContent).toContain('OpenCode is not installed');
    expect(container?.textContent).toContain('npm i -g opencode-ai');
    // Recovery is a button now, not an instruction to open the Command Palette.
    expect(container?.textContent).toContain('Restart Server');
    expect(container?.textContent).toContain('varro.server.command');

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

  it('runs the install command in a terminal from the missing CLI screen', () => {
    setState('serverStatus', { state: 'error', message: 'OpenCode CLI not found on PATH' });

    renderServerStatus();

    const installButton = Array.from(container?.querySelectorAll('button') || []).find(
      (button) => button.textContent?.trim() === 'Open terminal and install'
    );
    expect(installButton).toBeDefined();
    installButton?.click();

    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'terminal/run',
      payload: { command: 'npm i -g opencode-ai', title: 'OpenCode Install' },
    });
  });

  it('copies the setup command to the clipboard', async () => {
    setState('serverStatus', { state: 'error', message: 'OpenCode CLI not found on PATH' });
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });

    renderServerStatus();

    const copyButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy command: npm i -g opencode-ai"]'
    );
    expect(copyButton).not.toBeNull();
    copyButton?.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('npm i -g opencode-ai');
  });

  it('shows actionable guidance when OpenCode must be updated', () => {
    setState('serverStatus', {
      state: 'error',
      message:
        'OpenCode update required. Varro requires OpenCode 1.16.0 or newer, but the running server is 1.15.13.',
    });

    renderServerStatus();

    expect(container?.textContent).toContain('OpenCode update required');
    expect(container?.textContent).toContain('the running server is 1.15.13');
    expect(container?.textContent).toContain('opencode upgrade');
    expect(container?.textContent).toContain('Restart Server');
    expect(container?.textContent).not.toContain('OpenCode could not start');
  });

  it('recommends the install-specific command when an update has already failed', () => {
    setState('serverStatus', {
      state: 'error',
      message:
        'OpenCode update required. Varro requires OpenCode 1.16.0 or newer, but the installed CLI is 1.15.13. The automatic update failed. Windows could not replace opencode.exe because it is still running. Update it manually with: npm install -g opencode-ai@latest',
      detail: {
        kind: 'update-failed',
        installMethod: 'npm',
        suggestedCommand: 'npm install -g opencode-ai@latest',
      },
    });

    renderServerStatus();

    expect(container?.textContent).toContain('npm install -g opencode-ai@latest');
    // Offering `opencode upgrade` here would repeat the command that failed.
    expect(container?.textContent).not.toContain('Updateopencode upgrade');

    const updateButton = Array.from(container?.querySelectorAll('button') || []).find(
      (button) => button.textContent?.trim() === 'Open terminal and update'
    );
    updateButton?.click();

    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'terminal/run',
      payload: { command: 'npm install -g opencode-ai@latest', title: 'OpenCode Update' },
    });
  });

  it('presents an update deferred by active sessions as a wait, not a failure', () => {
    setState('serverStatus', {
      state: 'error',
      message:
        'OpenCode update required. Varro requires OpenCode 1.16.0 or newer, but the running server is 1.15.13. The old server has active sessions and was not stopped to avoid interrupting work.',
      detail: { kind: 'update-blocked', blockedBy: 'active-sessions' },
    });

    renderServerStatus();

    expect(container?.textContent).toContain('Waiting to update OpenCode');
    expect(container?.textContent).toContain('only restart after the server is idle');
    // Nothing for the user to run: the update proceeds on the next start.
    expect(container?.textContent).not.toContain('Open terminal and update');
    const checkAgain = Array.from(container?.querySelectorAll('button') || []).find(
      (button) => button.textContent?.trim() === 'Check Again'
    );
    expect(checkAgain).toBeDefined();
    checkAgain?.click();
    expect(postMessageMock).toHaveBeenCalledWith({ type: 'server/restart' });
  });

  it('names a failed update as failed rather than required', () => {
    setState('serverStatus', {
      state: 'error',
      message:
        'OpenCode update required. Varro requires OpenCode 1.16.0 or newer, but the installed CLI is 1.15.13. The automatic update failed.',
      detail: { kind: 'update-failed', installMethod: 'npm' },
    });

    renderServerStatus();

    expect(container?.textContent).toContain('OpenCode update failed');
  });

  it('offers the setting to change when an update is blocked by configuration', () => {
    setState('serverStatus', {
      state: 'error',
      message:
        'OpenCode update required. Varro requires OpenCode 1.16.0 or newer, but the installed CLI is 1.15.13. Automatic updates are disabled.',
      detail: {
        kind: 'update-blocked',
        blockedBy: 'auto-update-disabled',
        settingId: 'varro.server.autoUpdate',
        installMethod: 'brew',
        suggestedCommand: 'brew upgrade opencode',
      },
    });

    renderServerStatus();

    const settingsButton = Array.from(container?.querySelectorAll('button') || []).find(
      (button) => button.textContent?.trim() === 'Open Settings'
    );
    expect(settingsButton).toBeDefined();
    settingsButton?.click();

    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'vscode/open-settings',
      payload: { query: 'varro.server.autoUpdate' },
    });
    expect(container?.textContent).toContain('brew upgrade opencode');

    const updateButton = Array.from(container?.querySelectorAll('button') || []).find(
      (button) => button.textContent?.trim() === 'Open terminal and update'
    );
    updateButton?.click();
    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'terminal/run',
      payload: { command: 'brew upgrade opencode', title: 'OpenCode Update' },
    });
  });

  it('does not offer update or restart actions while another host owns the server', () => {
    setState('serverStatus', {
      state: 'error',
      message: 'The running server is actively owned by another Varro extension host.',
      detail: {
        kind: 'update-blocked',
        blockedBy: 'foreign-owner',
        suggestedCommand: 'opencode upgrade',
      },
    });

    renderServerStatus();

    expect(container?.textContent).not.toContain('Open terminal and update');
    expect(container?.textContent).not.toContain('Restart Server');
    expect(container?.textContent).toContain('Show Output');
  });

  it('uses a scrollable status surface and wraps long commands', () => {
    setState('serverStatus', {
      state: 'error',
      message: 'OpenCode CLI not found at the configured path.',
      detail: {
        kind: 'cli-path-invalid',
        configuredCommand: '/a/very/long/path/that/must/remain/readable/opencode',
      },
    });

    renderServerStatus();

    expect(container?.firstElementChild?.classList).toContain('overflow-y-auto');
    expect(container?.querySelector('code')?.classList).toContain('break-all');
  });

  it('distinguishes a bad configured path from a missing install', () => {
    setState('serverStatus', {
      state: 'error',
      message:
        'OpenCode CLI not found at the configured path: /opt/nope/opencode. Update varro.server.command to point at your OpenCode executable, or clear it to let Varro search PATH.',
      detail: {
        kind: 'cli-path-invalid',
        configuredCommand: '/opt/nope/opencode',
        settingId: 'varro.server.command',
      },
    });

    renderServerStatus();

    expect(container?.textContent).toContain('Configured OpenCode path not found');
    expect(container?.textContent).toContain('/opt/nope/opencode');
    // Telling someone with a configured path to reinstall via npm is the wrong fix.
    expect(container?.textContent).not.toContain('OpenCode is not installed');
    expect(container?.textContent).not.toContain('npm i -g opencode-ai');
  });

  it('restarts the server from any error state', () => {
    setState('serverStatus', { state: 'error', message: 'failed to bind port' });

    renderServerStatus();

    const restartButton = Array.from(container?.querySelectorAll('button') || []).find(
      (button) => button.textContent?.trim() === 'Restart Server'
    );
    expect(restartButton).toBeDefined();
    restartButton?.click();

    expect(postMessageMock).toHaveBeenCalledWith({ type: 'server/restart' });
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
