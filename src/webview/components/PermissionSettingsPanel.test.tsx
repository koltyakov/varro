import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenCodePermissionConfig } from '../../shared/protocol';
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
  mocks.save.mockResolvedValue(config);
  mocks.loadSessionRules.mockResolvedValue([]);
  mocks.saveSessionRules.mockResolvedValue([]);
  mocks.loadServerMemory.mockResolvedValue({ supported: true, rules: [] });
  mocks.removeServerMemory.mockResolvedValue({ supported: true, rules: [] });
  setState('sessions', []);
  setState('activeSessionId', null);
  setState('sessionPermissionModes', {});
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
  it('shows editable, inherited, effective, and auto-accept rules', async () => {
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();

    expect(container.textContent).toContain('opencode.jsonc');
    expect(container.querySelector('.permission-config-source')?.getAttribute('title')).toBe(
      '/repo/opencode.jsonc'
    );
    expect(container.textContent).toContain('Global rules');
    expect(container.textContent).toContain('Effective Default rules');
    expect(container.textContent).toContain('Edit-mode addition');
    expect(container.textContent).toContain('todowrite');
    expect(container.textContent).toContain('question');
    expect(container.querySelectorAll('.permission-rule-overview')).toHaveLength(3);
    expect(container.querySelectorAll('.permission-config-rule')).toHaveLength(1);
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Permission name"]')?.value
    ).toBe('bash');
  });

  it('hides the edit-mode addition when Default already allows all edits', async () => {
    mocks.load.mockResolvedValue({
      ...config,
      effectiveRules: [
        ...config.effectiveRules,
        { permission: 'edit', pattern: '*', action: 'allow' },
      ],
    });
    cleanup = render(() => <PermissionSettingsPanel />, container);
    await flush();

    expect(container.textContent).not.toContain('Edit-mode addition');
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
      'Edit-mode addition',
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
      ...getSessionPermissionRulesForMode('edits', 'update'),
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

    const editChip = [
      ...container.querySelectorAll<HTMLElement>('.permission-rule-chips code'),
    ].find((chip) => chip.textContent === 'edit');
    editChip?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Creates, updates, or removes files.'
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
