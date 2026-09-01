import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '../types';

// SAFETY: The fixture provides the 'default' | 'edits' | 'auto' | 'full' fields read by this statement.
const mocks = vi.hoisted(() => ({
  respondPermission: vi.fn(async () => {}),
  alwaysAllowPermissionForProject: vi.fn(async () => {}),
  alwaysAllowPermissionForSession: vi.fn(async () => {}),
  permissionMode: 'default' as 'default' | 'edits' | 'auto' | 'full',
}));

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise permission prompt integration with hooks and mode state. */
vi.mock('../hooks/useOpenCode', () => ({
  respondPermission: mocks.respondPermission,
  alwaysAllowPermissionForProject: mocks.alwaysAllowPermissionForProject,
  alwaysAllowPermissionForSession: mocks.alwaysAllowPermissionForSession,
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
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

describe('PermissionPrompt', () => {
  it('renders all permission response buttons', () => {
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

    const buttons = [...(container?.querySelectorAll('.permission-prompt-actions button') || [])];

    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Allow once',
      'Allow always',
      'Always allow options',
      'Reject',
    ]);
    expect(
      buttons.map((button) => button.querySelector('.permission-action-label-short')?.textContent)
    ).toEqual(['Once', 'Always', undefined, 'Reject']);
    expect(buttons[0]?.classList).toContain('question-btn-primary');
    expect(buttons[1]?.classList).toContain('question-btn-secondary');
    expect(buttons[2]?.classList).toContain('permission-always-menu-trigger');
    expect(buttons[3]?.classList).toContain('question-btn-danger');
    expect(container?.querySelector('.permission-prompt')?.classList).not.toContain(
      'animate-fade-in'
    );
    const scopeNote = container?.querySelector('.permission-prompt-scope-note')?.textContent;
    expect(scopeNote).toContain('matching requests in this session, until OpenCode restarts');
    expect(scopeNote).not.toContain('guides AI review');
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
    expect(
      container?.querySelector<HTMLButtonElement>('[aria-label="Always allow options"]')?.disabled
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
    ['Allow always', 'always'],
  ] as const)('%s sends the %s response', (label, response) => {
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

    const buttons = [...(container?.querySelectorAll('button') || [])];
    const button = buttons.find((candidate) => candidate.getAttribute('aria-label') === label);
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(mocks.respondPermission).toHaveBeenCalledWith('session-1', 'permission-1', response);
  });

  it('offers session, server-memory, and project scopes for always allow', async () => {
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

    container?.querySelector<HTMLButtonElement>('[aria-label="Always allow options"]')?.click();
    await Promise.resolve();

    const menu = document.body.querySelector('[aria-label="Always allow scope"]');
    expect(menu?.textContent).toContain('Always allow for this session');
    expect(menu?.textContent).toContain('Always allow in server memory');
    expect(menu?.textContent).toContain('Always allow for this project');

    menu
      ?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      .item(0)
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(mocks.alwaysAllowPermissionForSession).toHaveBeenCalledWith('session-1', 'permission-1');
  });

  it('persists project always allow before responding', async () => {
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

    container?.querySelector<HTMLButtonElement>('[aria-label="Always allow options"]')?.click();
    await Promise.resolve();
    document.body
      .querySelectorAll<HTMLButtonElement>('[aria-label="Always allow scope"] [role="menuitem"]')
      .item(2)
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(mocks.alwaysAllowPermissionForProject).toHaveBeenCalledWith('session-1', 'permission-1');
  });

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
