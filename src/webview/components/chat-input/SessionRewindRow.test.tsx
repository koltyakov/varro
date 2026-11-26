import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { render } from '@solidjs/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageEntry, Session } from '../../types';
import { setState } from '../../lib/app-state';
import { client } from '../../lib/client';

const mocks = vi.hoisted(() => ({ redoSession: vi.fn(async () => {}) }));

/* oxlint-disable anti-slop/no-module-mocking -- Restore delegates to the runtime's redo flow, which needs a live connection. */
vi.mock('../../hooks/useOpenCode', () => ({ redoSession: mocks.redoSession }));

import { SessionRewindRow } from './SessionRewindRow';

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

function session(revert?: Session['revert']): Session {
  const info: Session = {
    id: 'ses_one',
    projectID: 'project-1',
    directory: '/repo',
    title: 'Session',
    version: '1',
    time: { created: 0, updated: 0 },
  };
  if (revert) info.revert = revert;
  return info;
}

function message(id: string, role: 'user' | 'assistant'): MessageEntry {
  return {
    info:
      role === 'user'
        ? {
            id,
            sessionID: 'ses_one',
            role,
            time: { created: 0 },
            agent: 'build',
            model: { providerID: 'p', modelID: 'm' },
          }
        : {
            id,
            sessionID: 'ses_one',
            role,
            time: { created: 0 },
            parentID: 'msg_01',
            modelID: 'm',
            providerID: 'p',
            mode: 'build',
            agent: 'build',
            path: { cwd: '/repo', root: '/repo' },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
    parts: [],
  };
}

function apply(setter: Parameters<typeof setState>[0]) {
  setState(setter);
  flushSolid();
}

function button(label: string) {
  return container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
}

async function settle() {
  for (let index = 0; index < 4; index++) await Promise.resolve();
  flushSolid();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  mocks.redoSession.mockReset();
  mocks.redoSession.mockResolvedValue(undefined);
  apply(storePath('serverStatus', { state: 'running', apiVersion: 2 }));
  apply(
    storePath('messages', [
      message('msg_01', 'user'),
      message('msg_02', 'assistant'),
      message('msg_03', 'user'),
      message('msg_04', 'assistant'),
      message('msg_05', 'user'),
    ])
  );
  apply(storePath('sessions', [session()]));
});

afterEach(() => {
  cleanup?.();
  flushSolid();
  cleanup = undefined;
  container.remove();
  apply(storePath('sessions', []));
  apply(storePath('messages', []));
  vi.restoreAllMocks();
});

describe('SessionRewindRow', () => {
  it('appears only while a rewind is staged and counts the hidden prompts', () => {
    cleanup = render(() => <SessionRewindRow sessionID="ses_one" directory="/repo" />, container);
    flushSolid();
    expect(container.querySelector('.chat-session-rewind')).toBeNull();

    apply(storePath('sessions', [session({ messageID: 'msg_03' })]));
    expect(container.querySelector('.chat-queue-label')?.textContent).toBe('Rewound 2 prompts');
    expect(button('Restore rewound messages')).not.toBeNull();
    expect(button('Apply rewind')).not.toBeNull();

    apply(storePath('sessions', [session()]));
    expect(container.querySelector('.chat-session-rewind')).toBeNull();
  });

  it('restores through the redo flow and applies through the V2 commit route', async () => {
    const commitRevert = vi.spyOn(client.session, 'commitRevert').mockResolvedValue(session());
    apply(storePath('sessions', [session({ messageID: 'msg_05' })]));
    cleanup = render(() => <SessionRewindRow sessionID="ses_one" directory="/repo" />, container);
    flushSolid();
    expect(container.querySelector('.chat-queue-label')?.textContent).toBe('Rewound 1 prompt');

    button('Restore rewound messages')!.click();
    await settle();
    expect(mocks.redoSession).toHaveBeenCalledTimes(1);

    button('Apply rewind')!.click();
    await settle();
    expect(commitRevert).toHaveBeenCalledWith('ses_one', { directory: '/repo' });
  });

  it('offers only Restore on V1 and reports a failed apply inline', async () => {
    vi.spyOn(client.session, 'commitRevert').mockRejectedValue(new Error('409 busy'));
    apply(storePath('sessions', [session({ messageID: 'msg_03' })]));
    cleanup = render(() => <SessionRewindRow sessionID="ses_one" directory="/repo" />, container);
    flushSolid();

    button('Apply rewind')!.click();
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('409 busy');

    apply(storePath('serverStatus', { state: 'running', apiVersion: 1 }));
    expect(button('Apply rewind')).toBeNull();
    expect(button('Restore rewound messages')).not.toBeNull();
  });
});
