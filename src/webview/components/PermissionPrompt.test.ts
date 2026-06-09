import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '../types';

const mocks = vi.hoisted(() => ({
  respondPermission: vi.fn(async () => {}),
  getPermissionModeForSession: vi.fn(() => 'default'),
}));

vi.mock('../hooks/useOpenCode', () => ({
  respondPermission: mocks.respondPermission,
}));

vi.mock('../lib/stores/permissions-store', () => ({
  permissionsStore: {
    getPermissionModeForSession: mocks.getPermissionModeForSession,
  },
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
  mocks.getPermissionModeForSession.mockReset();
  mocks.getPermissionModeForSession.mockReturnValue('default');
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
});

describe('PermissionPrompt', () => {
  it('keeps broad Always approval available outside auto mode', () => {
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

    const buttons = [...(container?.querySelectorAll('button') || [])].map((button) =>
      button.textContent?.trim()
    );

    expect(buttons).toEqual(['Reject', 'Once', 'Always']);
  });

  it('uses one-shot manual approval in auto mode', () => {
    mocks.getPermissionModeForSession.mockReturnValue('auto');
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

    const buttons = [...(container?.querySelectorAll('button') || [])];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Reject',
      'Once',
      'Always',
    ]);

    buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(mocks.respondPermission).toHaveBeenCalledWith('session-1', 'permission-1', 'once');
  });

  it('keeps broad Always approval available in auto mode', () => {
    mocks.getPermissionModeForSession.mockReturnValue('auto');
    cleanup = render(() => PermissionPrompt({ permission: createPermission() }), container!);

    const buttons = [...(container?.querySelectorAll('button') || [])];
    buttons[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(mocks.respondPermission).toHaveBeenCalledWith('session-1', 'permission-1', 'always');
  });
});
