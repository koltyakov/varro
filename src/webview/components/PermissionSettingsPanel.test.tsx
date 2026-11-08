import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenCodePermissionConfig } from '../../shared/protocol';
import type { PermissionRule } from '../../shared/opencode-types';
import { getSessionPermissionRulesForMode } from '../../shared/permission-rules';
import { setState } from '../lib/state';
import { PermissionSettingsPanel } from './PermissionSettingsPanel';

const mocks = vi.hoisted(() => ({
  load: vi.fn<() => Promise<OpenCodePermissionConfig>>(),
  save: vi.fn<
    (rules: OpenCodePermissionConfig['projectRules']) => Promise<OpenCodePermissionConfig>
  >(),
  loadSessionRules: vi.fn(),
  saveSessionRules: vi.fn(),
  loadServerMemory: vi.fn(),
  removeServerMemory: vi.fn(),
  updateServerMemory: vi.fn(),
  loadGlobal: vi.fn(),
  saveGlobal: vi.fn(),
}));

/* oxlint-disable anti-slop/no-module-mocking -- This test exercises the panel against the typed client boundary. */
vi.mock('../lib/client', () => ({
  client: {
    session: {
      getPermissionRulesForSession: mocks.loadSessionRules,
      savePermissionRulesForSession: mocks.saveSessionRules,
    },
    varro: {
      openCodePermissionConfig: mocks.load,
      saveOpenCodePermissionConfig: mocks.save,
      serverMemoryPermissions: mocks.loadServerMemory,
      removeServerMemoryPermission: mocks.removeServerMemory,
      updateServerMemoryPermission: mocks.updateServerMemory,
      openCodeGlobalPermissionConfig: mocks.loadGlobal,
      saveOpenCodeGlobalPermissionConfig: mocks.saveGlobal,
    },
  },
}));

const config: OpenCodePermissionConfig = {
  targetPath: '/repo/opencode.jsonc',
  projectRules: [{ permission: 'bash', pattern: 'git status*', action: 'allow' }],
  inheritedSources: [
    {
      path: '/repo/opencode.json',
      rules: [{ permission: 'webfetch', pattern: '*', action: 'ask' }],
      scope: 'global',
    },
  ],
  effectiveRules: [
    { permission: 'bash', pattern: '*', action: 'ask' },
    { permission: 'bash', pattern: 'git status*', action: 'allow' },
  ],
};

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  mocks.load.mockResolvedValue(config);
  mocks.loadGlobal.mockResolvedValue({
    targetPath: '/isolated/global/opencode.json',
    supportsPatterns: true,
    rules: [{ permission: 'webfetch', pattern: '*', action: 'ask' }],
  });
  mocks.save.mockResolvedValue(config);
  mocks.loadSessionRules.mockResolvedValue([]);
  mocks.saveSessionRules.mockResolvedValue([]);
  mocks.loadServerMemory.mockResolvedValue({ supported: true, rules: [] });
  mocks.removeServerMemory.mockResolvedValue({ supported: true, rules: [] });
  setState('sessions', []);
  setState('activeSessionId', null);
  setState('sessionPermissionModes', {});
  setState('serverStatus', { state: 'running', apiVersion: 1, url: 'http://localhost:4096' });
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('PermissionSettingsPanel', () => {
  it('edits native WebFetch patterns in project and global config independently', async () => {
    setState('serverStatus', { state: 'running', apiVersion: 2 });
    mocks.load.mockResolvedValue({
      ...config,
      supportsPatterns: true,
      projectRules: [{ permission: 'webfetch', pattern: '*', action: 'ask' }],
    });
    mocks.saveGlobal.mockRejectedValueOnce(new Error('Global write failed'));
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();
    const global = container.querySelector('.permission-global-section')!;
    const pattern = global.querySelector<HTMLInputElement>('[aria-label="Pattern"]')!;
    expect(pattern.disabled).toBe(false);
    pattern.value = 'https://example.com/*';
    pattern.dispatchEvent(new InputEvent('input', { bubbles: true }));
    const save = global.querySelector<HTMLButtonElement>('.permission-settings-save')!;
    save.click();
    await flush();
    expect(global.textContent).toContain('Global write failed');
    expect(pattern.value).toBe('https://example.com/*');
    expect(mocks.saveGlobal).toHaveBeenCalledWith([
      { permission: 'webfetch', pattern: 'https://example.com/*', action: 'ask' },
    ]);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.saveSessionRules).not.toHaveBeenCalled();
    const projectPattern = [
      ...container.querySelectorAll<HTMLInputElement>('[aria-label="Pattern"]'),
    ].find((input) => !global.contains(input))!;
    expect(projectPattern.disabled).toBe(false);
    expect(projectPattern.value).toBe('*');
    mocks.saveGlobal.mockResolvedValue({
      targetPath: '/isolated/global/opencode.json',
      supportsPatterns: true,
      rules: [],
    });
    global.querySelector<HTMLButtonElement>('[aria-label="Remove rule"]')!.click();
    save.click();
    await flush();
    expect(mocks.saveGlobal).toHaveBeenLastCalledWith([]);
    expect(global.textContent).toContain('No rules in this global config file');
  });

  it('shows editable, inherited, and effective rules', async () => {
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();

    expect(container.textContent).toContain('opencode.jsonc');
    expect(container.querySelector('.permission-config-source')?.getAttribute('title')).toBe(
      '/repo/opencode.jsonc'
    );
    expect(container.textContent).toContain('Global rules');
    expect(container.textContent).toContain('Effective Default rules');
    expect(container.textContent).toContain('todowrite');
    expect(container.textContent).toContain('question');
    expect(container.querySelectorAll('.permission-rule-overview')).toHaveLength(2);
    expect(container.querySelectorAll('.permission-config-rule')).toHaveLength(1);
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Permission name"]')?.value
    ).toBe('bash');
  });

  it('hides inherited layers that are unchanged in the effective rules', async () => {
    mocks.load.mockResolvedValue({
      ...config,
      inheritedSources: [
        {
          path: '/home/user/.config/opencode/opencode.json',
          rules: [
            { permission: 'edit', pattern: '*', action: 'allow' },
            { permission: 'question', pattern: '*', action: 'allow' },
          ],
          scope: 'global',
        },
      ],
      effectiveRules: [
        { permission: 'edit', pattern: '*', action: 'allow' },
        { permission: 'question', pattern: '*', action: 'allow' },
      ],
    });
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();

    expect(container.textContent).not.toContain('Global rules');
    expect(container.textContent).toContain('Effective Default rules');
    expect(container.querySelectorAll('.permission-rule-overview')).toHaveLength(1);
  });

  it('shows and retracts server-memory rules without an active session', async () => {
    mocks.loadServerMemory.mockResolvedValue({
      supported: true,
      rules: [
        {
          id: 'saved-1',
          projectID: 'project-1',
          permission: 'bash',
          pattern: 'opencode *',
        },
      ],
    });
    mocks.removeServerMemory.mockResolvedValue({ supported: true, rules: [] });
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();

    expect(container.textContent).not.toContain('Current session rules');
    expect(container.textContent).toContain('Server memory');
    expect(container.textContent).toContain('opencode *');
    expect(mocks.loadServerMemory).toHaveBeenCalledWith(null, { directory: undefined });

    container.querySelector<HTMLButtonElement>('[aria-label="Retract server allowance"]')?.click();
    await flush();

    expect(mocks.removeServerMemory).toHaveBeenCalledWith(null, 'saved-1', {
      directory: undefined,
    });
  });

  it('shows legacy server-memory rules as restart-only', async () => {
    mocks.loadServerMemory.mockResolvedValue({
      supported: true,
      rules: [
        {
          id: 'legacy:perm-1:0',
          projectID: 'project-1',
          permission: 'bash',
          pattern: 'opencode *',
          retractable: false,
        },
      ],
    });
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();

    expect(container.textContent).toContain('opencode *');
    expect(container.textContent).toContain('Restart to clear');
    expect(container.querySelector('[aria-label="Retract server allowance"]')).toBeNull();
    expect(container.querySelector('[aria-label="Edit server allowance"]')).toBeNull();
  });

  it('shows V2 approvals as durable and requires confirmation to revoke an untracked rule', async () => {
    setState('serverStatus', { state: 'running', apiVersion: 2, url: 'http://localhost:4096' });
    mocks.loadServerMemory.mockResolvedValue({
      supported: true,
      rules: [],
      untrackedRules: [
        { id: 'untracked-1', projectID: 'project-1', permission: 'bash', pattern: 'printf *' },
      ],
    });
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();
    expect(container.textContent).toContain('Saved project approvals');
    expect(container.textContent).toContain('Persistent');
    expect(container.textContent).not.toContain('Until restart');
    expect(container.textContent).not.toContain('No saved project approvals.');
    expect(container.textContent).toContain('Other saved approvals');
    expect(container.textContent).toContain('Origin unknown');
    expect(container.textContent).toContain('printf *');
    expect(container.querySelector('[aria-label="Edit server allowance"]')).toBeNull();
    container.querySelector<HTMLButtonElement>('[aria-label="Retract server allowance"]')!.click();
    expect(mocks.removeServerMemory).not.toHaveBeenCalled();
    const confirmation = container.querySelector('.permission-memory-confirm')!;
    expect(confirmation.textContent).toContain('Its origin is unknown');
    confirmation.querySelectorAll<HTMLButtonElement>('button')[1]!.click();
    expect(container.querySelector('.permission-memory-confirm')).toBeNull();
    expect(mocks.removeServerMemory).not.toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>('[aria-label="Retract server allowance"]')!.click();
    container.querySelector<HTMLButtonElement>('.permission-memory-confirm button')!.click();
    await flush();
    expect(mocks.removeServerMemory).toHaveBeenCalledExactlyOnceWith(null, 'untracked-1', {
      directory: undefined,
    });
    expect(container.textContent).toContain('No saved project approvals.');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.saveSessionRules).not.toHaveBeenCalled();
  });

  it('labels cached V2 data stale, disables mutation, and refreshes without clearing a project draft', async () => {
    setState('serverStatus', { state: 'running', apiVersion: 2, url: 'http://localhost:4096' });
    const rule = {
      id: 'saved-1',
      projectID: 'project-1',
      permission: 'bash',
      pattern: 'echo *',
      editable: true,
    };
    mocks.loadServerMemory.mockResolvedValue({
      supported: true,
      rules: [rule],
      stale: '401 Unauthorized',
    });
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();
    expect(container.textContent).toContain('Cached approvals only');
    expect(container.textContent).toContain('401 Unauthorized');
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Edit server allowance"]')!.disabled
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Retract server allowance"]')!
        .disabled
    ).toBe(true);
    const draft = container.querySelector<HTMLInputElement>('[aria-label="Pattern"]')!;
    draft.value = 'git diff *';
    draft.dispatchEvent(new InputEvent('input', { bubbles: true }));
    mocks.loadServerMemory.mockResolvedValue({ supported: true, rules: [rule] });
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh saved approvals"]')!.click();
    await flush();
    expect(container.textContent).not.toContain('Cached approvals only');
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Retract server allowance"]')!
        .disabled
    ).toBe(false);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Pattern"]')!.value).toBe(
      'git diff *'
    );
    expect(mocks.load).toHaveBeenCalledOnce();
  });

  it('keeps visible rows marked stale if a refresh fails instead of claiming there are no approvals', async () => {
    const rule = { id: 'saved-1', projectID: 'project-1', permission: 'bash', pattern: 'echo *' };
    mocks.loadServerMemory.mockResolvedValue({ supported: true, rules: [rule] });
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();
    mocks.loadServerMemory.mockRejectedValue(new Error('Refresh failed'));
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh saved approvals"]')!.click();
    await flush();
    expect(container.textContent).toContain('echo *');
    expect(container.textContent).toContain('Cached approvals only');
    expect(container.textContent).toContain('Refresh failed');
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Retract server allowance"]')!
        .disabled
    ).toBe(true);
  });

  it('keeps a failed untracked removal visible and actionable for retry', async () => {
    mocks.loadServerMemory.mockResolvedValue({
      supported: true,
      rules: [],
      untrackedRules: [
        { id: 'untracked-1', projectID: 'project-1', permission: 'bash', pattern: 'printf *' },
      ],
    });
    mocks.removeServerMemory.mockRejectedValueOnce(
      new Error('Removal was sent, but could not be verified.')
    );
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();
    container.querySelector<HTMLButtonElement>('[aria-label="Retract server allowance"]')!.click();
    container.querySelector<HTMLButtonElement>('.permission-memory-confirm button')!.click();
    await flush();
    expect(container.textContent).toContain('printf *');
    expect(container.textContent).toContain('could not be verified');
    expect(
      container.querySelector<HTMLButtonElement>('.permission-memory-confirm button')!.disabled
    ).toBe(false);
  });

  it('refreshes after reconnect and ignores an earlier in-flight snapshot', async () => {
    setState('serverStatus', { state: 'running', apiVersion: 2, url: 'http://localhost:4096' });
    let resolveOld!: (value: { supported: true; rules: [] }) => void;
    mocks.loadServerMemory.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      })
    );
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();
    mocks.loadServerMemory.mockResolvedValue({
      supported: true,
      rules: [],
      untrackedRules: [
        {
          id: 'reconnected',
          projectID: 'project-1',
          permission: 'bash',
          pattern: 'echo recovered *',
        },
      ],
    });
    setState('serverStatus', { state: 'starting' });
    setState('serverStatus', { state: 'running', apiVersion: 2, url: 'http://localhost:4097' });
    await flush();
    expect(container.textContent).toContain('echo recovered *');
    resolveOld({ supported: true, rules: [] });
    await flush();
    expect(container.textContent).toContain('echo recovered *');
    expect(mocks.loadServerMemory).toHaveBeenCalledTimes(2);
  });

  it('hides saved-rule editing on servers without that capability', async () => {
    mocks.loadServerMemory.mockResolvedValue({
      supported: true,
      rules: [
        { id: 'saved-1', projectID: 'project-1', permission: 'bash', pattern: 'git status *' },
      ],
    });
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();
    expect(container.querySelector('[aria-label="Edit server allowance"]')).toBeNull();
    expect(container.querySelector('[aria-label="Retract server allowance"]')).not.toBeNull();
  });

  it('edits saved action/resource patterns without changing the project or session layers', async () => {
    const rule = {
      id: 'saved-1',
      projectID: 'project-1',
      permission: 'bash',
      pattern: 'git status *',
      editable: true,
    };
    mocks.loadServerMemory.mockResolvedValue({ supported: true, rules: [rule] });
    mocks.updateServerMemory.mockResolvedValue({
      supported: true,
      rules: [{ ...rule, pattern: 'git diff *' }],
    });
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();
    container.querySelector<HTMLButtonElement>('[aria-label="Edit server allowance"]')!.click();
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="Saved resource pattern"]'
    )!;
    input.value = 'git diff *';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    container.querySelector<HTMLButtonElement>('[aria-label="Save server allowance"]')!.click();
    await flush();
    expect(mocks.updateServerMemory).toHaveBeenCalledWith(
      null,
      'saved-1',
      { permission: 'bash', pattern: 'git diff *' },
      { directory: undefined }
    );
    expect(container.textContent).toContain('git diff *');
    expect(container.querySelector('[aria-label="Saved resource pattern"]')).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.saveSessionRules).not.toHaveBeenCalled();
  });

  it('keeps a failed saved-rule draft and lets the user retry or cancel', async () => {
    mocks.loadServerMemory.mockResolvedValue({
      supported: true,
      rules: [
        {
          id: 'saved-1',
          projectID: 'project-1',
          permission: 'bash',
          pattern: 'git status *',
          editable: true,
        },
      ],
    });
    mocks.updateServerMemory.mockRejectedValue(new Error('409 duplicate saved allowance'));
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();
    container.querySelector<HTMLButtonElement>('[aria-label="Edit server allowance"]')!.click();
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="Saved resource pattern"]'
    )!;
    input.value = 'git diff *';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    container.querySelector<HTMLButtonElement>('[aria-label="Save server allowance"]')!.click();
    await flush();
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Saved resource pattern"]')?.value
    ).toBe('git diff *');
    expect(container.textContent).toContain('409 duplicate saved allowance');
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Save server allowance"]')?.disabled
    ).toBe(false);
    container
      .querySelector<HTMLButtonElement>('[aria-label="Cancel server allowance edit"]')!
      .click();
    expect(container.textContent).toContain('git status *');
    expect(container.querySelector('[aria-label="Saved resource pattern"]')).toBeNull();
  });

  it('disables duplicate saved-rule submissions and ignores a save after the session changes', async () => {
    mocks.loadServerMemory.mockResolvedValue({
      supported: true,
      rules: [
        {
          id: 'saved-1',
          projectID: 'project-1',
          permission: 'bash',
          pattern: 'git status *',
          editable: true,
        },
      ],
    });
    let resolveSave: ((value: { supported: true; rules: [] }) => void) | undefined;
    mocks.updateServerMemory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        })
    );
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();
    container.querySelector<HTMLButtonElement>('[aria-label="Edit server allowance"]')!.click();
    container.querySelector<HTMLButtonElement>('[aria-label="Save server allowance"]')!.click();
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Save server allowance"]')?.disabled
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Cancel server allowance edit"]')
        ?.disabled
    ).toBe(true);
    expect(mocks.updateServerMemory).toHaveBeenCalledOnce();
    mocks.loadServerMemory.mockResolvedValue({
      supported: true,
      rules: [
        {
          id: 'saved-2',
          projectID: 'project-2',
          permission: 'read',
          pattern: 'new workspace',
          editable: true,
        },
      ],
    });
    setState('sessions', [
      {
        id: 'session-2',
        projectID: 'project-2',
        directory: '/other',
        title: 'Other session',
        version: '2',
        time: { created: 1, updated: 1 },
      },
    ]);
    setState('activeSessionId', 'session-2');
    await flush();
    resolveSave?.({ supported: true, rules: [] });
    await flush();
    expect(container.textContent).toContain('new workspace');
    expect(container.textContent).not.toContain('git status *');
  });

  it('shows and independently retracts current-session and server-memory rules', async () => {
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/repo',
        title: 'Session',
        version: '1',
        time: { created: 1, updated: 1 },
      },
    ]);
    setState('activeSessionId', 'session-1');
    mocks.loadSessionRules.mockResolvedValue([
      { permission: 'bash', pattern: 'npm test *', action: 'allow' },
    ]);
    mocks.loadServerMemory.mockResolvedValue({
      supported: true,
      rules: [
        {
          id: 'saved-1',
          projectID: 'project-1',
          permission: 'bash',
          pattern: 'git status *',
        },
      ],
    });
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();

    expect(container.textContent).toContain('Current session rules');
    expect(container.textContent).toContain('Server memory');
    expect(
      [...container.querySelectorAll('.permission-config-heading h2')].map(
        (heading) => heading.textContent
      )
    ).toEqual([
      'Current session rules',
      'Server memory',
      'Project rules',
      'Global rules',
      'Effective Default rules',
    ]);
    const sessionSection = [
      ...container.querySelectorAll<HTMLElement>('.permission-config-section'),
    ].find((section) => section.querySelector('h2')?.textContent === 'Current session rules')!;
    const sessionPattern = sessionSection.querySelector<HTMLInputElement>(
      'input[aria-label="Pattern"]'
    )!;
    sessionPattern.value = 'npm run test *';
    sessionPattern.dispatchEvent(new InputEvent('input', { bubbles: true }));
    sessionSection.querySelector<HTMLButtonElement>('.permission-settings-save')?.click();
    await flush();

    expect(mocks.saveSessionRules).toHaveBeenCalledWith(
      'session-1',
      [{ permission: 'bash', pattern: 'npm run test *', action: 'allow' }],
      { directory: '/repo' }
    );
    expect(mocks.save).not.toHaveBeenCalled();

    container.querySelector<HTMLButtonElement>('[aria-label="Retract server allowance"]')?.click();
    await flush();

    expect(mocks.removeServerMemory).toHaveBeenCalledWith('session-1', 'saved-1', {
      directory: '/repo',
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('keeps the newly selected session rules when an older save resolves', async () => {
    setState('sessions', [
      {
        id: 'session-a',
        projectID: 'project-1',
        directory: '/repo/a',
        title: 'Session A',
        version: '1',
        time: { created: 1, updated: 1 },
      },
      {
        id: 'session-b',
        projectID: 'project-1',
        directory: '/repo/b',
        title: 'Session B',
        version: '1',
        time: { created: 2, updated: 2 },
      },
    ]);
    setState('activeSessionId', 'session-a');
    mocks.loadSessionRules.mockImplementation(async (sessionId: string) => [
      {
        permission: 'bash',
        pattern: sessionId === 'session-a' ? 'session-a rule' : 'session-b rule',
        action: 'allow',
      },
    ]);
    let resolveSave: ((rules: PermissionRule[]) => void) | undefined;
    mocks.saveSessionRules.mockImplementationOnce(
      () =>
        new Promise<PermissionRule[]>((resolve) => {
          resolveSave = resolve;
        })
    );
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();

    const sessionSection = [
      ...container.querySelectorAll<HTMLElement>('.permission-config-section'),
    ].find((section) => section.querySelector('h2')?.textContent === 'Current session rules')!;
    const patternInput = sessionSection.querySelector<HTMLInputElement>(
      'input[aria-label="Pattern"]'
    )!;
    patternInput.value = 'session-a edited';
    patternInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
    sessionSection.querySelector<HTMLButtonElement>('.permission-settings-save')?.click();
    await flush();

    setState('activeSessionId', 'session-b');
    await vi.waitFor(() =>
      expect(
        sessionSection.querySelector<HTMLInputElement>('input[aria-label="Pattern"]')?.value
      ).toBe('session-b rule')
    );
    resolveSave?.([{ permission: 'bash', pattern: 'session-a saved', action: 'allow' }]);
    await flush();

    expect(
      sessionSection.querySelector<HTMLInputElement>('input[aria-label="Pattern"]')?.value
    ).toBe('session-b rule');
  });

  it('infers hidden mode rules and keeps only the latest session override', async () => {
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/repo',
        title: 'Session',
        version: '1',
        time: { created: 1, updated: 1 },
      },
    ]);
    setState('activeSessionId', 'session-1');
    setState('sessionPermissionModes', { 'session-1': 'default' });
    mocks.loadSessionRules.mockResolvedValue([
      ...getSessionPermissionRulesForMode('auto', 'update'),
      { permission: 'bash', pattern: 'npm *', action: 'ask' },
      { permission: 'bash', pattern: 'npm *', action: 'allow' },
    ]);
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();

    const sessionSection = [
      ...container.querySelectorAll<HTMLElement>('.permission-config-section'),
    ].find((section) => section.querySelector('h2')?.textContent === 'Current session rules')!;
    expect(sessionSection.querySelectorAll('.permission-config-rule')).toHaveLength(1);
    expect(
      sessionSection.querySelector<HTMLInputElement>('input[aria-label="Permission name"]')?.value
    ).toBe('bash');
    expect(
      sessionSection.querySelector<HTMLInputElement>('input[aria-label="Pattern"]')?.value
    ).toBe('npm *');
    expect(sessionSection.querySelector('.permission-config-action-button')?.textContent).toContain(
      'Allow'
    );
  });

  it('does not hide generated-looking session rules with different actions', async () => {
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/repo',
        title: 'Session',
        version: '1',
        time: { created: 1, updated: 1 },
      },
    ]);
    setState('activeSessionId', 'session-1');
    setState('sessionPermissionModes', { 'session-1': 'auto' });
    const autoRules = getSessionPermissionRulesForMode('auto', 'update');
    mocks.loadSessionRules.mockResolvedValue([
      { ...autoRules[0]!, action: 'allow' },
      ...autoRules.slice(1),
    ]);
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();

    const sessionSection = [
      ...container.querySelectorAll<HTMLElement>('.permission-config-section'),
    ].find((section) => section.querySelector('h2')?.textContent === 'Current session rules')!;
    expect(sessionSection.querySelectorAll('.permission-config-rule')).toHaveLength(
      autoRules.length
    );
  });

  it('adds and saves a project permission rule', async () => {
    const saved = {
      ...config,
      projectRules: [
        ...config.projectRules,
        { permission: 'websearch', pattern: '*', action: 'allow' as const },
      ],
    };
    mocks.save.mockResolvedValue(saved);
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();

    container.querySelector<HTMLButtonElement>('.permission-config-add')?.click();
    const names = container.querySelectorAll<HTMLInputElement>(
      'input[aria-label="Permission name"]'
    );
    names[1]!.value = 'websearch';
    names[1]!.dispatchEvent(new InputEvent('input', { bubbles: true }));
    const patterns = container.querySelectorAll<HTMLInputElement>('input[aria-label="Pattern"]');
    expect(patterns[1]?.value).toBe('*');
    expect(patterns[1]?.disabled).toBe(true);
    const actions = container.querySelectorAll<HTMLButtonElement>(
      '.permission-config-action-button'
    );
    actions[1]!.click();
    actions[1]!.parentElement?.querySelector<HTMLButtonElement>('[data-action="allow"]')?.click();
    container.querySelector<HTMLButtonElement>('.permission-settings-save')?.click();
    await flush();

    expect(mocks.save).toHaveBeenCalledWith([
      { permission: 'bash', pattern: 'git status*', action: 'allow' },
      { permission: 'websearch', pattern: '*', action: 'allow' },
    ]);
  });

  it('suggests known permission names while preserving free text entry', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(500);
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();

    const permission = container.querySelector<HTMLInputElement>(
      'input[aria-label="Permission name"]'
    )!;
    permission.value = 'ed';
    permission.dispatchEvent(new InputEvent('input', { bubbles: true }));

    const editOption = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (option) => option.textContent === 'edit'
    );
    expect(editOption).toBeInstanceOf(HTMLButtonElement);
    editOption?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(container.querySelector('.permission-name-details')?.classList).toContain('right');
    expect(container.querySelector('.permission-name-details')?.textContent).toContain(
      'Creates, updates, or removes files.'
    );
    editOption?.click();
    expect(permission.value).toBe('edit');

    permission.value = 'mcp_custom_permission';
    permission.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(permission.value).toBe('mcp_custom_permission');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('shows permission descriptions when hovering policy chips', async () => {
    vi.useFakeTimers();
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();

    const bashChip = [
      ...container.querySelectorAll<HTMLElement>('.permission-rule-chips code'),
    ].find((chip) => chip.textContent === 'bash');
    bashChip?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Runs commands in a shell.'
    );
  });

  it('uses a custom action dropdown', async () => {
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();

    expect(container.querySelector('select[aria-label="Action"]')).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>('.permission-config-action-button')!;
    trigger.click();
    const options = trigger.parentElement?.querySelectorAll<HTMLButtonElement>('[data-action]');
    expect([...options!].map((option) => option.textContent?.trim())).toEqual([
      'Allow',
      'Ask',
      'Deny',
    ]);
    trigger.parentElement?.querySelector<HTMLButtonElement>('[data-action="ask"]')?.click();
    expect(trigger.textContent?.trim()).toBe('Ask');
  });
});
