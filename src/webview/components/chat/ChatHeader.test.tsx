import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types';
import { client } from '../../lib/client';
import { setShowSessionPicker, setState, showSessionPicker } from '../../lib/state';
import { ActiveChatHeader } from './ChatHeader';
import { SessionActionFeedback } from './SessionActionFeedback';

const deleteSessionMock = vi.hoisted(() => vi.fn());
const renameSessionMock = vi.hoisted(() => vi.fn());

vi.mock('../../hooks/useOpenCode', () => ({
  deleteSession: deleteSessionMock,
  renameSession: renameSessionMock,
}));

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    projectID: 'project-1',
    directory: '/repo',
    title: 'Session one',
    version: '1',
    time: { created: 1, updated: 2 },
    ...overrides,
  };
}

function renderHeader(activeSubagentRootId: string | null = null) {
  cleanup = render(
    () => (
      <>
        <ActiveChatHeader
          title="Session one"
          showBackButton={false}
          backTitle="Back"
          showActions={false}
          activeSubagentRootId={activeSubagentRootId}
          activeSubagentCount={activeSubagentRootId ? 2 : 0}
          activeSubagentLabel="Subagents"
          failedCount={0}
          attentionCount={0}
          planReadyCount={0}
          completedCount={0}
          runningCount={0}
          onBack={vi.fn()}
          onOpenSubagents={vi.fn()}
          onOpenFailedSessions={vi.fn()}
          onOpenAttentionSessions={vi.fn()}
          onOpenPlanReadySessions={vi.fn()}
          onOpenCompletedSessions={vi.fn()}
          onOpenRunningSessions={vi.fn()}
          onCreateSession={vi.fn()}
        />
        <SessionActionFeedback />
      </>
    ),
    container
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  setState('sessions', [session()]);
  setState('activeSessionId', 'session-1');
  setState('pinnedSessionIds', []);
  setShowSessionPicker(false);
  deleteSessionMock.mockReset();
  deleteSessionMock.mockResolvedValue(undefined);
  renameSessionMock.mockReset();
  renameSessionMock.mockResolvedValue(true);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
  setState('sessions', []);
  setState('activeSessionId', null);
  setState('pinnedSessionIds', []);
  setShowSessionPicker(false);
  vi.restoreAllMocks();
});

describe('ActiveChatHeader', () => {
  it('opens the session context menu from the title', () => {
    renderHeader();

    container.querySelector<HTMLElement>('.chat-header-session-title')!.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 50,
      })
    );

    const menu = document.body.querySelector<HTMLElement>('[aria-label="Session actions"]');
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain('Rename');
    expect(menu!.textContent).toContain('Pin');
    expect(menu!.textContent).toContain('Copy session ID');
    expect(menu!.textContent).toContain('Open in OpenCode');
    expect(menu!.textContent).toContain('Share session');
    expect(menu!.textContent).not.toContain('Unshare session');
    expect(menu!.textContent).toContain('Move to Recycle Bin');
    expect(menu!.style.left).toBe('40px');
    expect(menu!.style.top).toBe('50px');
  });

  it('hides rename and recycle-bin actions for an active sub-agent session', () => {
    setState('sessions', [session({ parentID: 'parent' })]);
    renderHeader();

    container
      .querySelector<HTMLElement>('.chat-header-session-title')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    const menu = document.body.querySelector<HTMLElement>('[aria-label="Session actions"]');
    expect(menu?.textContent).not.toContain('Rename');
    expect(menu?.textContent).not.toContain('Move to Recycle Bin');
    expect(menu?.textContent).toContain('Copy session ID');
    expect(menu?.textContent).toContain('Open in OpenCode');
    expect(menu?.textContent).toContain('Share session');
  });

  it('returns to the sessions list after deleting from the header menu', async () => {
    renderHeader();
    container
      .querySelector<HTMLElement>('.chat-header-session-title')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Move to Recycle Bin')!
      .click();

    await vi.waitFor(() => {
      expect(deleteSessionMock).toHaveBeenCalledWith('session-1');
      expect(showSessionPicker()).toBe(true);
    });
  });

  it('shows the pinned marker and toggles pinning from the context menu', async () => {
    setState('pinnedSessionIds', ['session-1']);
    const setPinned = vi.spyOn(client.varro.session, 'setPinned').mockResolvedValueOnce([]);
    renderHeader();

    expect(container.querySelector('[aria-label="Pinned session"]')).not.toBeNull();
    container
      .querySelector<HTMLElement>('.chat-header-session-title')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const unpin = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ).find((button) => button.textContent === 'Unpin');
    unpin!.click();

    await vi.waitFor(() => expect(setPinned).toHaveBeenCalledWith('session-1', false));
    await vi.waitFor(() => {
      expect(container.querySelector('[aria-label="Pinned session"]')).toBeNull();
    });
  });

  it('shows copied feedback after sharing from the header menu', async () => {
    vi.spyOn(client.session, 'share').mockResolvedValue(
      session({ share: { url: 'https://share.test/session-1' } })
    );
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });

    try {
      renderHeader();
      container
        .querySelector<HTMLElement>('.chat-header-session-title')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        .find((button) => button.textContent?.trim() === 'Share session')!
        .click();

      await vi.waitFor(() => {
        const feedback = document.body.querySelector<HTMLElement>('.session-action-feedback');
        expect(feedback?.textContent?.trim()).toBe('Share link copied');
      });
      const sharedMarker = container.querySelector('[aria-label="Session is shared"]');
      expect(sharedMarker?.getAttribute('aria-label')).toBe('Session is shared');
      expect(sharedMarker?.getAttribute('title')).toBeNull();
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    }
  });

  it('shows cumulative worked duration next to the title', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 65_000,
      activeStartedAt: null,
    });
    renderHeader('session-root');

    await vi.waitFor(() => {
      const duration = container.querySelector('.chat-header-session-duration');
      expect(duration?.textContent).toBe('1m 5s');
    });
    const duration = container.querySelector('.chat-header-session-duration');
    expect(duration?.previousElementSibling?.classList).toContain('chat-header-subagents');
  });
});
