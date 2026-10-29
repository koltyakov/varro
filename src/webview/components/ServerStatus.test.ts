import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { resetDefaultAppState, setState } from '../lib/state';
import { statusIcons } from '../lib/status-icons';
import { terminalIcon } from '../lib/ui-icons';
import { toCssUrl } from './UiIcon';
import { client } from '../lib/client';

const postMessageMock = vi.hoisted(() => vi.fn());

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise ServerStatus's bridge and provider-setup integrations. */
vi.mock('../lib/bridge', () => ({
  postMessage: postMessageMock,
  onMessage: vi.fn(),
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

  it('renders connection progress without assuming a server is being spawned', () => {
    setState('serverStatus', { state: 'starting' });

    renderServerStatus();

    expect(container?.textContent).toContain('Connecting to OpenCode...');
    expect(container?.textContent).not.toContain('Starting OpenCode...');
    expect(container?.textContent).not.toContain('Spawning the local server');
    expect(container?.querySelectorAll('.loading-dot')).toHaveLength(3);
  });

  it('shows a pulsing Varro logo while server detection is pending', () => {
    setState('serverStatus', { state: 'stopped' });
    setState('emptyStateLogoUri', 'https://example.test/varro.png');

    renderServerStatus();

    const status = container?.querySelector('[role="status"]');
    const logo = status?.querySelector<HTMLImageElement>('img');
    expect(status?.getAttribute('aria-label')).toBe('Detecting OpenCode server');
    expect(logo?.src).toBe('https://example.test/varro.png');
    expect(logo?.alt).toBe('Varro');
    expect(logo?.classList).toContain('animate-pulse-soft');
    expect(container?.textContent).not.toContain('Server not running');
    expect(
      Array.from(container?.querySelectorAll('button') || []).find(
        (button) => button.textContent?.trim() === 'Restart Server'
      )
    ).toBeUndefined();
  });

  it('renders trimmed generic errors', () => {
    setState('serverStatus', { state: 'error', message: '  failed to bind port  ' });

    renderServerStatus();

    expect(container?.textContent).toContain('OpenCode is unavailable');
    expect(container?.textContent).toContain('failed to bind port');
    expect(container?.textContent).not.toContain('  failed to bind port  ');
    expect(
      container
        ?.querySelector<HTMLElement>('.ui-icon.text-vscode-error')
        ?.style.getPropertyValue('--ui-icon-mask')
    ).toBe(toCssUrl(statusIcons.warningCircle));

    const showOutput = Array.from(container?.querySelectorAll('button') || []).find(
      (button) => button.textContent?.trim() === 'Show Output'
    );
    showOutput?.click();
    expect(postMessageMock).toHaveBeenCalledWith({ type: 'vscode/show-output' });
    const settings = Array.from(container?.querySelectorAll('button') || []).find(
      (button) => button.textContent?.trim() === 'Open Settings'
    );
    expect(settings?.parentElement).toBe(showOutput?.parentElement);
    settings?.click();
    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'vscode/open-settings',
      payload: { query: 'varro.server' },
    });
  });

  it('puts the server connection failure reason on its own line', () => {
    setState('serverStatus', {
      state: 'error',
      message:
        'Could not connect to OpenCode at http://127.0.0.1:4096. The server did not respond before the connection timed out.',
    });

    renderServerStatus();

    expect(container?.querySelector('.whitespace-pre-line')?.textContent).toBe(
      'Could not connect to OpenCode at http://127.0.0.1:4096.\nThe server did not respond before the connection timed out.'
    );
  });

  it.each([
    { name: 'missing CLI', status: { state: 'error', message: 'OpenCode CLI not found' } },
    {
      name: 'invalid path',
      status: { state: 'error', message: 'OpenCode CLI not found at the configured path.' },
    },
    {
      name: 'required update',
      status: { state: 'error', message: 'OpenCode update required. Install a newer version.' },
    },
    {
      name: 'waiting update',
      status: {
        state: 'error',
        message: 'OpenCode update required. The server has active sessions.',
        detail: { kind: 'update-blocked', blockedBy: 'active-sessions' },
      },
    },
    { name: 'generic error', status: { state: 'error', message: 'Connection failed' } },
    { name: 'provider setup', status: { state: 'running', url: 'http://127.0.0.1:4096' } },
  ] as const)('uses a standalone 24px icon for $name', ({ status }) => {
    setState('serverStatus', status);
    if (status.state === 'running') {
      setState('providersLoaded', true);
      setState('providers', []);
    }

    renderServerStatus();

    const icon = container?.querySelector<HTMLElement>('.server-status-heading > .ui-icon');
    expect(icon).not.toBeNull();
    expect(icon?.style.getPropertyValue('--ui-icon-width')).toBe('24px');
    expect(icon?.style.getPropertyValue('--ui-icon-height')).toBe('24px');
    expect(container?.querySelector('.rounded-full')).toBeNull();
  });

  it.each(['legacy', 'structured'])(
    'shows simplified install guidance for %s missing CLI errors',
    (format) => {
      setState('serverStatus', {
        state: 'error',
        message: '  OpenCode CLI not found on PATH  ',
        detail: format === 'structured' ? { kind: 'cli-missing' } : undefined,
      });

      renderServerStatus();

      expect(container?.textContent).toContain('OpenCode is not installed');
      expect(
        container
          ?.querySelector<HTMLElement>('.ui-icon.text-vscode-warning')
          ?.style.getPropertyValue('--ui-icon-mask')
      ).toBe(toCssUrl(statusIcons.warningTriangle));
      expect(container?.querySelector('.rounded-full')).toBeNull();
      expect(container?.textContent).not.toContain('Install OpenCode to get started.');
      expect(container?.textContent).toContain('npm i -g @opencode/cli');
      expect(container?.textContent).not.toMatch(/v1|v2/i);
      expect(container?.textContent).not.toContain('npm i -g opencode-ai');
      expect(container?.textContent).not.toContain('Restart Server');
      expect(container?.textContent).not.toContain('varro.server.command');
      expect(container?.textContent).not.toContain('Varro gives');
      expect(container?.textContent).not.toContain('Use npm on');
      expect(container?.querySelector('details')).toBeNull();

      const buttons = Array.from(container?.querySelectorAll('button') || []);
      const footerLink = buttons.find((button) => button.textContent?.includes('Learn more'));

      expect(footerLink).toBeDefined();
      footerLink?.click();

      expect(postMessageMock).toHaveBeenCalledExactlyOnceWith({
        type: 'vscode/open-external',
        payload: { url: 'https://opencode.ai/v2/docs/' },
      });
    }
  );

  it('runs install from the inline play button without a separate terminal install button', () => {
    setState('serverStatus', { state: 'error', message: 'OpenCode CLI not found on PATH' });

    renderServerStatus();

    const installButton = Array.from(container?.querySelectorAll('button') || []).find(
      (button) => button.textContent?.trim() === 'Open terminal and install'
    );
    expect(installButton).toBeUndefined();
    const playButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Run install command in terminal"]'
    );
    expect(playButton).not.toBeNull();
    expect(postMessageMock).not.toHaveBeenCalled();
    playButton?.click();
    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'terminal/run',
      payload: { command: 'npm i -g @opencode/cli', title: 'OpenCode Install' },
    });
  });

  it('copies the setup command to the clipboard', async () => {
    setState('serverStatus', { state: 'error', message: 'OpenCode CLI not found on PATH' });
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });

    renderServerStatus();

    const copyButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy command: npm i -g @opencode/cli"]'
    );
    expect(copyButton).not.toBeNull();
    copyButton?.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('npm i -g @opencode/cli');
  });

  it('shows actionable guidance when OpenCode must be updated', () => {
    setState('serverStatus', {
      state: 'error',
      message:
        'OpenCode update required. Varro requires OpenCode 1.16.0 or newer, but the running server is 1.15.13.',
    });

    renderServerStatus();

    expect(container?.textContent).toContain('OpenCode update required');
    expect(container?.textContent).toContain('Varro requires OpenCode 1.16.0 or newer.');
    expect(container?.textContent).not.toContain('the running server is 1.15.13');
    expect(container?.textContent).not.toContain('OpenCode update required. Varro requires');
    expect(container?.textContent).toContain('opencode upgrade');
    expect(container?.textContent).toContain('Restart Server');
    expect(container?.textContent).not.toContain('OpenCode is unavailable');
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

    expect(container?.textContent).not.toContain('but the installed CLI is');
    expect(container?.textContent).toContain('The automatic update failed.');
    expect(container?.textContent).not.toContain('Varro requires OpenCode');
    expect(container?.textContent).not.toContain('Windows could not replace opencode.exe');
    expect(container?.textContent).not.toContain('Open terminal and update');
    expect(container?.textContent).toContain('(run in terminal)');
    const updateButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Run update command in terminal"]'
    );
    const copyButton = container?.querySelector('[aria-label^="Copy command:"]');
    expect(updateButton).not.toBeNull();
    expect(updateButton?.closest('.server-status-command')).not.toBeNull();
    expect(updateButton?.parentElement).toBe(copyButton?.parentElement);
    const field = container?.querySelector('.server-status-command-field');
    expect(updateButton?.closest('.server-status-command-field')).toBe(field);
    expect(copyButton?.closest('.server-status-command-field')).toBe(field);
    expect(
      field
        ?.querySelector<HTMLElement>(':scope > .ui-icon')
        ?.style.getPropertyValue('--ui-icon-mask')
    ).toBe(toCssUrl(terminalIcon));
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
    expect(container?.textContent).not.toContain('Varro requires OpenCode');
    expect(container?.textContent).toContain('The server has active sessions');
    expect(container?.textContent).not.toContain('Varro will check again');
    // Nothing for the user to run: the update proceeds on the next start.
    expect(container?.textContent).not.toContain('Open terminal and update');
    expect(container?.querySelector('[aria-label="Run update command in terminal"]')).toBeNull();
    const checkAgain = Array.from(container?.querySelectorAll('button') || []).find(
      (button) => button.textContent?.trim() === 'Check Again'
    );
    expect(checkAgain).toBeDefined();
    const output = Array.from(container?.querySelectorAll('button') || []).find(
      (button) => button.textContent?.trim() === 'Show Output'
    );
    expect(checkAgain?.parentElement).toBe(output?.parentElement);
    expect(checkAgain?.className).toBe(output?.className);
    expect(container?.textContent).not.toContain('Restart Server');
    expect(container?.textContent).not.toContain('OpenCode update required.');
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
    expect(container?.textContent).not.toContain('OpenCode update required.');
  });

  it('offers manual update without a settings button when automatic updates are disabled', () => {
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
    expect(settingsButton).toBeUndefined();
    expect(container?.textContent).toContain('brew upgrade opencode');
    expect(
      container?.querySelector('.server-status-heading .whitespace-pre-line')?.textContent
    ).toBe('Varro requires OpenCode 1.16.0 or newer.\nAutomatic updates are disabled.');

    const updateButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Run update command in terminal"]'
    );
    updateButton?.click();
    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'terminal/run',
      payload: { command: 'brew upgrade opencode', title: 'OpenCode Update' },
    });
  });

  it('allows restart from a different Varro host without offering a duplicate update', () => {
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
    expect(container?.querySelector('[aria-label="Run update command in terminal"]')).toBeNull();
    expect(container?.textContent).toContain('Restart Server');
    expect(container?.textContent).toContain('Show Output');
  });

  it('uses a scrollable status surface and keeps long commands in a single command field', () => {
    setState('serverStatus', {
      state: 'error',
      message: 'OpenCode CLI not found at the configured path.',
      detail: {
        kind: 'cli-path-invalid',
        configuredCommand: '/a/very/long/path/that/must/remain/readable/opencode',
      },
    });

    renderServerStatus();

    expect(container?.firstElementChild?.classList).toContain('server-status-surface');
    expect(container?.querySelector('pre')?.classList).toContain('server-status-command-text');
    expect(container?.querySelector('pre')?.title).toBe(
      '/a/very/long/path/that/must/remain/readable/opencode'
    );
    expect(container?.querySelector('pre')?.closest('.server-status-command')).not.toBeNull();
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
    expect(container?.textContent).not.toContain('OpenCode CLI not found at the configured path');
    expect(container?.textContent).toContain(
      'Update the configured path or clear it to search PATH.'
    );
    // Telling someone with a configured path to reinstall via npm is the wrong fix.
    expect(container?.textContent).not.toContain('OpenCode is not installed');
    expect(container?.textContent).not.toContain('npm i -g @opencode/cli');
    expect(container?.textContent).not.toContain('Restart Server');

    const settingsButton = Array.from(container?.querySelectorAll('button') || []).find(
      (button) => button.textContent?.trim() === 'Open Settings'
    );
    const actions = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('.server-status-secondary-button') || []
    );
    expect(actions.map((button) => button.textContent?.trim())).toEqual([
      'Open Settings',
      'Show Output',
    ]);
    expect(actions[0]?.parentElement).toBe(actions[1]?.parentElement);
    const playButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Run configured path command in terminal"]'
    );
    expect(playButton?.closest('.server-status-command-field')).not.toBeNull();
    playButton?.click();
    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'terminal/run',
      payload: { command: '/opt/nope/opencode', title: 'OpenCode Command' },
    });
    settingsButton?.click();
    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'vscode/open-settings',
      payload: { query: 'varro.server.command' },
    });
  });

  it('restarts the server from a generic error state', () => {
    setState('serverStatus', { state: 'error', message: 'failed to bind port' });

    renderServerStatus();

    const restartButton = Array.from(container?.querySelectorAll('button') || []).find(
      (button) => button.textContent?.trim() === 'Restart Server'
    );
    expect(restartButton).toBeDefined();
    restartButton?.click();

    expect(postMessageMock).toHaveBeenCalledWith({ type: 'server/restart' });
  });

  it('opens native provider setup without terminal commands or documentation links', async () => {
    const catalog = vi.spyOn(client.config, 'providerCatalog').mockResolvedValue({
      all: [{ id: 'openai', name: 'OpenAI', source: 'api', models: {} }],
      default: {},
      connected: [],
    });
    setState('serverStatus', { state: 'running', url: 'http://127.0.0.1:4096' });
    setState('providersLoaded', true);
    setState('providers', []);
    setState('providerAuthMethods', { openai: [{ type: 'api', label: 'API key' }] });

    renderServerStatus();

    expect(container?.textContent).toContain('No providers configured');
    expect(container?.textContent).not.toContain('automatically when setup completes');
    expect(container?.querySelector('.server-status-content br')).toBeNull();
    expect(container?.textContent).not.toContain('opencode auth login');
    expect(container?.textContent).not.toContain('Provider setup docs');

    const buttons = Array.from(container?.querySelectorAll('button') || []);
    const setupButton = buttons.find((button) => button.textContent?.trim() === 'Open Providers');
    expect(setupButton).toBeDefined();
    setupButton?.click();
    await vi.waitFor(() => {
      expect(document.body.querySelector('.provider-connect-option-name')?.textContent).toContain(
        'OpenAI'
      );
    });
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(postMessageMock).not.toHaveBeenCalled();
    catalog.mockRestore();
  });
});
