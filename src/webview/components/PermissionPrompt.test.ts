import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '../types';

const mocks = vi.hoisted(() => ({
  respondPermission: vi.fn(async () => {}),
}));

vi.mock('../hooks/useOpenCode', () => ({
  respondPermission: mocks.respondPermission,
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
      'Reject',
    ]);
    expect(
      buttons.map((button) => button.querySelector('.permission-action-label-short')?.textContent)
    ).toEqual(['Once', 'Always', 'Reject']);
    expect(buttons[0]?.classList).toContain('question-btn-primary');
    expect(buttons[1]?.classList).toContain('question-btn-secondary');
    expect(buttons[2]?.classList).toContain('question-btn-danger');
    expect(container?.querySelector('.permission-prompt')?.classList).not.toContain(
      'animate-fade-in'
    );
    expect(buttons[1]?.getAttribute('title')).toContain('matching future requests');
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

  it('renders single-line title and metadata values with full-text copy controls', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const parameters = { command: 'x'.repeat(1_300) };
    const text = JSON.stringify(parameters);
    const title = `external_directory ${'/tmp/'.repeat(100)}*`;

    cleanup = render(
      () =>
        PermissionPrompt({
          permission: createPermission({ title, metadata: { parameters } }),
        }),
      container!
    );

    const value = container?.querySelector('.permission-meta-value');
    expect(value?.textContent).toBe(text);
    expect(value?.tagName).toBe('SPAN');

    const titleCopy = container?.querySelector<HTMLButtonElement>(
      '.permission-prompt-text-shell button'
    );
    titleCopy?.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(title);

    const copy = container?.querySelector<HTMLButtonElement>('.permission-meta-entry button');
    copy?.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(text);
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
