import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '../types';
import { setState } from '../lib/app-state';

// SAFETY: The fixture provides the permission-mode fields read by this statement.
const mocks = vi.hoisted(() => ({
  respondPermission: vi.fn(async () => {}),
  alwaysAllowPermissionForProject: vi.fn(async () => {}),
  alwaysAllowPermissionForSession: vi.fn(async () => {}),
  alwaysAllowPermissionForGlobal: vi.fn(async () => {}),
  permissionMode: 'default' as 'default' | 'auto' | 'full',
}));

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise permission prompt integration with hooks and mode state. */
vi.mock('../hooks/useOpenCode', () => ({
  respondPermission: mocks.respondPermission,
  alwaysAllowPermissionForProject: mocks.alwaysAllowPermissionForProject,
  alwaysAllowPermissionForSession: mocks.alwaysAllowPermissionForSession,
  alwaysAllowPermissionForGlobal: mocks.alwaysAllowPermissionForGlobal,
}));

vi.mock('../lib/state-permission-modes', () => ({
  getPermissionModeForSession: () => mocks.permissionMode,
}));

import { PermissionPrompt } from './PermissionPrompt';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

function createPermission(overrides: Partial<Permission> = {}): Permission {
  return {
    id: 'permission-1',
    type: 'bash',
    sessionID: 'session-1',
    messageID: 'message-1',
    title: 'bash npm run test',
    metadata: {},
    time: { created: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  mocks.respondPermission.mockReset();
  mocks.respondPermission.mockResolvedValue(undefined);
  mocks.alwaysAllowPermissionForProject.mockReset();
  mocks.alwaysAllowPermissionForProject.mockResolvedValue(undefined);
  mocks.alwaysAllowPermissionForSession.mockReset();
  mocks.alwaysAllowPermissionForSession.mockResolvedValue(undefined);
  mocks.permissionMode = 'default';
  mocks.alwaysAllowPermissionForGlobal.mockReset();
  setState('serverStatus', { state: 'running', apiVersion: 1 });
  setState('sessions', []);
  setState('messages', []);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

describe('PermissionPrompt', () => {
  it('shows the owning subagent and updates when its identity arrives', () => {
    setState('sessions', [
      {
        id: 'session-1',
        parentID: 'child-parent',
        projectID: 'project-1',
        directory: '/repo',
        title: 'Inspect code',
        version: '1',
        time: { created: 0, updated: 0 },
      },
    ]);
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

    expect(container?.querySelector('.permission-prompt-agent')?.textContent).toBe('@subagent');
    setState('sessions', 0, 'agent', 'explore');
    expect(container?.querySelector('.permission-prompt-agent')?.textContent).toBe('@explore');
    expect(container?.querySelector('.permission-prompt-agent')?.getAttribute('title')).toBe(
      'Requested by @explore'
    );
  });

  it('does not label a root session as a subagent', () => {
    setState('sessions', [
      {
        id: 'session-1',
        agent: 'build',
        projectID: 'project-1',
        directory: '/repo',
        title: 'Build',
        version: '1',
        time: { created: 0, updated: 0 },
      },
    ]);
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

    expect(container?.querySelector('.permission-prompt-agent')).toBeNull();
  });

  it.each([
    { metadata: { sessionId: 'session-1' }, input: { subagent_type: 'explore' } },
    { metadata: { sessionID: 'session-1' }, input: { subagent_type: 'explore' } },
    { metadata: {}, input: { subagent_type: 'explore', task_id: 'session-1' } },
  ])('uses the linked task before the child session is loaded: %j', ({ metadata, input }) => {
    setState('messages', [
      {
        info: {
          id: 'parent-message',
          sessionID: 'root-session',
          role: 'assistant',
          parentID: 'user-message',
          modelID: 'model',
          providerID: 'provider',
          mode: 'build',
          agent: 'build',
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0 },
        },
        parts: [
          {
            id: 'task-1',
            sessionID: 'root-session',
            messageID: 'parent-message',
            type: 'tool',
            tool: 'task',
            callID: 'call-1',
            state: {
              status: 'running',
              input,
              metadata,
              time: { start: 0 },
            },
          },
        ],
      },
    ]);
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

    expect(container?.querySelector('.permission-prompt-agent')?.textContent).toBe('@explore');

    // The requesting message takes precedence over the task's original agent.
    setState('messages', (entries) => [
      ...entries,
      {
        info: {
          ...entries[0]!.info,
          id: 'message-1',
          sessionID: 'session-1',
          agent: 'reviewer',
        },
        parts: [],
      },
    ]);
    expect(container?.querySelector('.permission-prompt-agent')?.textContent).toBe('@reviewer');
  });

  it('renders all permission response buttons', () => {
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

    const buttons = [...(container?.querySelectorAll('.permission-prompt-actions button') || [])];

    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Allow once',
      'Allow always',
      'Reject',
    ]);
    expect(
      buttons.map((button) => button.querySelector('.permission-action-label-short')?.textContent)
    ).toEqual(['Once', 'Always', 'Reject']);
    expect(buttons[0]?.classList).toContain('question-btn-primary');
    expect(buttons[1]?.classList).toContain('question-btn-secondary');
    expect(buttons[1]?.getAttribute('aria-haspopup')).toBe('menu');
    expect(buttons[1]?.getAttribute('aria-expanded')).toBe('false');
    expect(buttons[2]?.classList).toContain('question-btn-danger');
    expect(container?.querySelector('.permission-prompt')?.classList).not.toContain(
      'animate-fade-in'
    );
    expect(container?.querySelector('.permission-prompt-scope-note')).toBeNull();
  });

  it('allows only rejection when recovered details are incomplete', () => {
    cleanup = render(
      () =>
        PermissionPrompt({
          permission: createPermission({ recoveredIncomplete: true }),
        }),
      container!
    );

    expect(container?.querySelector<HTMLButtonElement>('[aria-label="Allow once"]')?.disabled).toBe(
      true
    );
    expect(
      container?.querySelector<HTMLButtonElement>('[aria-label="Allow always"]')?.disabled
    ).toBe(true);
    expect(container?.querySelector<HTMLButtonElement>('[aria-label="Reject"]')?.disabled).toBe(
      false
    );
    expect(container?.textContent).toContain('Approval details are incomplete after reload');
  });

  it('explains how always approval guides review in auto approve mode', () => {
    mocks.permissionMode = 'auto';
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

    expect(container?.querySelector('.permission-prompt-scope-note')?.textContent).toContain(
      'guides AI review toward similar non-destructive actions'
    );
  });

  it('explains the response scope for grouped requests', () => {
    cleanup = render(
      () =>
        PermissionPrompt({
          permission: createPermission({
            groupMembers: [
              { id: 'permission-1', sessionID: 'session-1', messageID: 'message-1' },
              { id: 'permission-2', sessionID: 'session-1', messageID: 'message-2' },
            ],
          }),
          queuePosition: 1,
          queueTotal: 2,
        }),
      container!
    );

    expect(container?.querySelector('.permission-prompt-step')?.textContent).toContain('1 / 2');
    const count = container?.querySelector('.permission-prompt-count');
    expect(count?.textContent).toBe('×2');
    expect(count?.getAttribute('title')).toBe('2 identical requests grouped');

    const note = container?.querySelector('.permission-prompt-group-note');
    expect(note?.textContent).toContain('Requested 2 times in parallel');
    expect(note?.textContent).toContain('Allow once handles one request');
    expect(note?.textContent).toContain('Reject handles all 2');
  });

  it('hides the group note for a single request', () => {
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

    expect(container?.querySelector('.permission-prompt-count')).toBeNull();
    expect(container?.querySelector('.permission-prompt-group-note')).toBeNull();
  });

  it('shows why the auto-approve judge deferred the request', () => {
    cleanup = render(
      () =>
        PermissionPrompt({
          permission: createPermission({
            autoApproveReason: 'The command needs manual confirmation.',
          }),
        }),
      container!
    );

    const reason = container?.querySelector('.permission-prompt-auto-reason');
    expect(reason?.textContent).toContain('AI check');
    expect(reason?.textContent).toContain('The command needs manual confirmation.');
  });

  it('renders a human-friendly action summary and the full command only once', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const command = 'x'.repeat(1_300);
    const title = `bash ${command}`;

    cleanup = render(
      () =>
        PermissionPrompt({
          permission: createPermission({
            title,
            actionSummary: 'Check installed tool versions',
            metadata: { command },
          }),
        }),
      container!
    );

    expect(container?.querySelector('.permission-prompt-text')?.textContent).toBe(
      'Check installed tool versions'
    );
    const value = container?.querySelector('.permission-meta-value');
    expect(value?.textContent).toBe(command);
    expect(value?.tagName).toBe('SPAN');
    expect(container?.textContent?.split(command)).toHaveLength(2);
    expect(container?.querySelector('.permission-prompt-text-shell button')).toBeNull();

    const copy = container?.querySelector<HTMLButtonElement>('.permission-meta-entry button');
    copy?.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(command);
  });

  it('uses a generic shell action name when no model summary is available', () => {
    cleanup = render(
      () =>
        PermissionPrompt({
          permission: createPermission({ metadata: { command: 'npm run test' } }),
        }),
      container!
    );

    expect(container?.querySelector('.permission-prompt-text')?.textContent).toBe('Run command');
    expect(container?.querySelector('.permission-meta-value')?.textContent).toBe('npm run test');
  });

  it.each([
    ['Reject', 'reject'],
    ['Allow once', 'once'],
  ] as const)('%s sends the %s response', (label, response) => {
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

    const buttons = [...(container?.querySelectorAll('button') || [])];
    const button = buttons.find((candidate) => candidate.getAttribute('aria-label') === label);
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(mocks.respondPermission).toHaveBeenCalledWith('session-1', 'permission-1', response);
  });

  it.each(['session', 'server', 'project'] as const)(
    'approves only the chosen %s scope',
    async (scope) => {
      cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

      const trigger = container?.querySelector<HTMLButtonElement>('[aria-label="Allow always"]');
      trigger?.click();
      await Promise.resolve();

      const menu = document.body.querySelector('[aria-label="Always allow scope"]');
      expect(menu?.textContent).toContain('For this session');
      expect(menu?.textContent).toContain('Until server restart');
      expect(menu?.textContent).toContain('For this project');
      expect(trigger?.getAttribute('aria-expanded')).toBe('true');
      expect(mocks.respondPermission).not.toHaveBeenCalled();
      expect(mocks.alwaysAllowPermissionForSession).not.toHaveBeenCalled();
      expect(mocks.alwaysAllowPermissionForProject).not.toHaveBeenCalled();

      menu
        ?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
        .item(['session', 'server', 'project'].indexOf(scope))
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(document.body.querySelector('[role="menu"]')).toBeNull();
      expect(mocks.respondPermission).toHaveBeenCalledTimes(scope === 'server' ? 1 : 0);
      expect(mocks.alwaysAllowPermissionForSession).toHaveBeenCalledTimes(
        scope === 'session' ? 1 : 0
      );
      expect(mocks.alwaysAllowPermissionForProject).toHaveBeenCalledTimes(
        scope === 'project' ? 1 : 0
      );
      if (scope === 'server') {
        expect(mocks.respondPermission).toHaveBeenCalledWith('session-1', 'permission-1', 'always');
      } else {
        const approve =
          scope === 'session'
            ? mocks.alwaysAllowPermissionForSession
            : mocks.alwaysAllowPermissionForProject;
        expect(approve).toHaveBeenCalledWith('session-1', 'permission-1');
      }
      await Promise.resolve();
      trigger?.click();
      expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
    }
  );

  it('reviews config-backed project approvals on V2 before submitting', async () => {
    setState('serverStatus', { state: 'running', apiVersion: 2 });
    cleanup = render(
      () => PermissionPrompt({ permission: createPermission({ always: ['git diff --stat'] }) }),
      container!
    );
    container?.querySelector<HTMLButtonElement>('[aria-label="Allow always"]')?.click();
    await Promise.resolve();

    const menu = document.body.querySelector('[aria-label="Always allow scope"]');
    expect(menu?.textContent).not.toContain('Until server restart');
    const choices = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    expect(choices.map((choice) => choice.querySelector('span')?.textContent)).toEqual([
      'For this session',
      'For this project',
      'Global',
    ]);
    choices[1]?.click();
    await Promise.resolve();
    expect(container!.querySelectorAll('.permission-prompt-actions')).toHaveLength(1);
    expect(
      [...container!.querySelectorAll('.permission-prompt-actions button')].map(
        (button) => button.textContent
      )
    ).toEqual(['Cancel', 'Save & allow']);
    expect(container!.querySelector('[aria-label="Allow once"]')).toBeNull();
    expect(container!.querySelector('[aria-label="Reject"]')).toBeNull();
    expect(container!.querySelector('.permission-approval-scope')?.textContent).toBe(
      'Project config'
    );
    expect(mocks.alwaysAllowPermissionForProject).not.toHaveBeenCalled();
    const patterns = container!.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(document.activeElement).toBe(patterns);
    expect(patterns.value).toBe('git diff --stat');
    patterns.value = 'git diff *';
    patterns.dispatchEvent(new InputEvent('input', { bubbles: true }));
    container!
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(mocks.alwaysAllowPermissionForProject).toHaveBeenCalledExactlyOnceWith(
      'session-1',
      'permission-1',
      ['git diff *']
    );
    expect(mocks.respondPermission).not.toHaveBeenCalled();
  });

  it('cancels the review with Escape and restores the original actions and keyboard focus', async () => {
    setState('serverStatus', { state: 'running', apiVersion: 2 });
    cleanup = render(
      () => PermissionPrompt({ permission: createPermission({ always: ['git *'] }) }),
      container!
    );
    container!.querySelector<HTMLButtonElement>('[aria-label="Allow always"]')!.click();
    await Promise.resolve();
    document.body.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    await Promise.resolve();
    const textarea = container!.querySelector<HTMLTextAreaElement>('textarea')!;
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);
    await Promise.resolve();
    expect(event.defaultPrevented).toBe(true);
    expect(container!.querySelector('form')).toBeNull();
    expect(container!.querySelectorAll('.permission-prompt-actions')).toHaveLength(1);
    expect(document.activeElement).toBe(container!.querySelector('[aria-label="Allow always"]'));
    expect(mocks.respondPermission).not.toHaveBeenCalled();
    expect(mocks.alwaysAllowPermissionForSession).not.toHaveBeenCalled();
    container!.querySelector<HTMLButtonElement>('[aria-label="Allow once"]')!.click();
    await Promise.resolve();
    expect(mocks.respondPermission).toHaveBeenCalledWith('session-1', 'permission-1', 'once');
  });

  it('expands and collapses the full child command without changing its copy value', async () => {
    const command = `git diff ${'some/long/path '.repeat(60)}\n--stat`;
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    cleanup = render(
      () => PermissionPrompt({ permission: createPermission({ metadata: { command } }) }),
      container!
    );
    const toggle = container!.querySelector<HTMLButtonElement>('.permission-command-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      container!.querySelector('.permission-command-expanded .permission-meta-value')?.textContent
    ).toBe(command);
    container!.querySelector<HTMLButtonElement>('[aria-label^="Copy command:"]')!.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(command);
    toggle.click();
    expect(container!.querySelector('.permission-command-expanded')).toBeNull();
  });

  it.each(['session', 'global'] as const)(
    'retains a failed reviewed %s draft and supports cancellation',
    async (scope) => {
      setState('serverStatus', { state: 'running', apiVersion: 2 });
      const approve =
        scope === 'session'
          ? mocks.alwaysAllowPermissionForSession
          : mocks.alwaysAllowPermissionForGlobal;
      approve.mockRejectedValueOnce(new Error('Save failed'));
      cleanup = render(
        () =>
          PermissionPrompt({
            permission: createPermission({
              always: ['git *'],
              metadata: { command: 'git diff --stat' },
            }),
          }),
        container!
      );
      container!.querySelector<HTMLButtonElement>('[aria-label="Allow always"]')!.click();
      await Promise.resolve();
      document.body
        .querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
        .item(scope === 'session' ? 0 : 2)
        .click();
      const textarea = container!.querySelector<HTMLTextAreaElement>('textarea')!;
      textarea.value = '';
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
      expect(container!.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
      expect(textarea.getAttribute('aria-invalid')).toBe('true');
      expect(container!.querySelector('.permission-approval-hint')?.textContent).toBe(
        'Enter at least one resource pattern.'
      );
      textarea.value = 'git diff *\ngit status *';
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
      container!
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(container!.textContent).toContain('Save failed'));
      expect(approve).toHaveBeenCalledWith('session-1', 'permission-1', [
        'git diff *',
        'git status *',
      ]);
      expect(textarea.value).toBe('git diff *\ngit status *');
      expect(container!.querySelector('.permission-meta-value')?.textContent).toBe(
        'git diff --stat'
      );
      [...container!.querySelectorAll<HTMLButtonElement>('form button')]
        .find((button) => button.textContent === 'Cancel')!
        .click();
      expect(container!.querySelector('form')).toBeNull();
      expect(container!.querySelectorAll('.permission-prompt-actions')).toHaveLength(1);
      expect(
        container!.querySelector<HTMLButtonElement>('[aria-label="Allow once"]')!.disabled
      ).toBe(false);
      expect(mocks.respondPermission).not.toHaveBeenCalled();
    }
  );

  it.each(['session', 'project'] as const)(
    'shows failed %s approval feedback and keeps Allow once usable',
    async (scope) => {
      const message = 'File-based OpenCode configuration is not supported in attach-only mode.';
      const approve =
        scope === 'project'
          ? mocks.alwaysAllowPermissionForProject
          : mocks.alwaysAllowPermissionForSession;
      approve.mockRejectedValueOnce(new Error(message));
      cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);
      container?.querySelector<HTMLButtonElement>('[aria-label="Allow always"]')?.click();
      await Promise.resolve();
      document.body
        .querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
        .item(scope === 'project' ? 2 : 0)
        .click();
      await Promise.resolve();
      await Promise.resolve();

      expect(container?.querySelector('[role="alert"]')?.textContent).toBe(message);
      expect(container?.querySelector('.permission-prompt')).not.toBeNull();
      expect(mocks.respondPermission).not.toHaveBeenCalled();
      const once = container?.querySelector<HTMLButtonElement>('[aria-label="Allow once"]');
      expect(once?.disabled).toBe(false);
      once?.click();
      await Promise.resolve();
      expect(mocks.respondPermission).toHaveBeenCalledWith('session-1', 'permission-1', 'once');
      expect(container?.querySelector('[role="alert"]')).toBeNull();
    }
  );

  it.each(['Escape', 'outside click', 'trigger click'])(
    'dismisses the scope menu with %s without responding',
    async (dismissal) => {
      cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

      const trigger = container?.querySelector<HTMLButtonElement>('[aria-label="Allow always"]');
      trigger?.click();
      await Promise.resolve();
      expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
      if (dismissal === 'Escape') {
        const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(trigger);
      } else if (dismissal === 'outside click') {
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      } else {
        trigger?.click();
      }
      expect(document.body.querySelector('[role="menu"]')).toBeNull();
      expect(trigger?.getAttribute('aria-expanded')).toBe('false');
      expect(container?.querySelector('.permission-prompt')).not.toBeNull();
      expect(mocks.respondPermission).not.toHaveBeenCalled();
      expect(mocks.alwaysAllowPermissionForSession).not.toHaveBeenCalled();
      expect(mocks.alwaysAllowPermissionForProject).not.toHaveBeenCalled();
    }
  );

  it('keeps a permission response locked across prompt remounts', async () => {
    let resolveResponse!: () => void;
    mocks.respondPermission.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveResponse = resolve;
        })
    );
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Allow once"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(
      [
        ...(container?.querySelectorAll<HTMLButtonElement>('.permission-prompt-actions button') ||
          []),
      ].every((button) => button.disabled)
    ).toBe(true);

    cleanup();
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);
    const remountedButtons = [
      ...(container?.querySelectorAll<HTMLButtonElement>('.permission-prompt-actions button') ||
        []),
    ];
    expect(remountedButtons.every((button) => button.disabled)).toBe(true);
    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Reject"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(mocks.respondPermission).toHaveBeenCalledTimes(1);

    resolveResponse();
    await Promise.resolve();
    await Promise.resolve();
    expect(remountedButtons.every((button) => !button.disabled)).toBe(true);
  });
});
