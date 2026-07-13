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
  mocks.respondPermission.mockClear();
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
});

describe('PermissionPrompt', () => {
  it('renders all permission response buttons', () => {
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

    const buttons = [...(container?.querySelectorAll('button') || [])].map((button) =>
      button.textContent?.trim()
    );

    expect(buttons).toEqual(['Reject', 'Once', 'Always']);
  });

  it.each([
    ['Reject', 'reject'],
    ['Once', 'once'],
    ['Always', 'always'],
  ] as const)('%s sends the %s response', (label, response) => {
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

    const buttons = [...(container?.querySelectorAll('button') || [])];
    const button = buttons.find((candidate) => candidate.textContent?.trim() === label);
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(mocks.respondPermission).toHaveBeenCalledWith('session-1', 'permission-1', response);
  });
});
