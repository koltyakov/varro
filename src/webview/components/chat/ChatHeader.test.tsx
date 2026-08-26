import { render } from 'solid-js/web';
import { cableTagIcon } from '../../lib/ui-icons';
import { toCssUrl } from '../UiIcon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types';
import type { WebviewMessage } from '../../../shared/protocol';
import { client } from '../../lib/client';
import { setShowSessionPicker, setState, showSessionPicker } from '../../lib/state';
import { ActiveChatHeader, SessionPickerHeader } from './ChatHeader';
import { SessionActionFeedback } from './SessionActionFeedback';

const deleteSessionMock = vi.hoisted(() => vi.fn());
const renameSessionMock = vi.hoisted(() => vi.fn());

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise ChatHeader's useOpenCode module integration. */
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

function renderHeader(
  activeSubagentRootId: string | null = null,
  options: { showActions?: boolean; onCreateSession?: () => void } = {}
) {
  cleanup = render(
    () => (
      <>
        <ActiveChatHeader
          title="Session one"
          showBackButton={false}
          backTitle="Back"
          showActions={options.showActions ?? false}
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
          onCreateSession={options.onCreateSession ?? vi.fn()}
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

describe('SessionActionFeedback icon state', () => {
  it('uses sized adapter icons for errors and preserves dismissal behavior', () => {
    const onDismissError = vi.fn();
    cleanup = render(
      () => (
        <SessionActionFeedback error={() => 'Session failed'} onDismissError={onDismissError} />
      ),
      container
    );

    const feedback = document.body.querySelector<HTMLElement>('.session-action-feedback');
    expect(feedback?.classList).toContain('is-error');
    expect(feedback?.getAttribute('role')).toBe('alert');

    const glyph = feedback?.querySelector<HTMLElement>('.session-action-feedback-glyph');
    expect(glyph?.classList).toContain('ui-icon');
    expect(glyph?.style.getPropertyValue('--ui-icon-width')).toBe('11px');

    const dismissIcon = feedback?.querySelector<HTMLElement>(
      '.session-action-feedback-dismiss-icon'
    );
    expect(dismissIcon?.classList).toContain('ui-icon');
    expect(dismissIcon?.style.getPropertyValue('--ui-icon-width')).toBe('13px');

    feedback?.querySelector<HTMLButtonElement>('.session-action-feedback-dismiss')?.click();
    expect(onDismissError).toHaveBeenCalledOnce();
  });
});

describe('ActiveChatHeader', () => {
  it('renders a plain new-chat tooltip without a modifier shortcut', async () => {
    vi.useFakeTimers();
    try {
      renderHeader(null, { showActions: true });
      container
        .querySelector<HTMLButtonElement>('[aria-label="New chat"]')!
        .dispatchEvent(new MouseEvent('mouseenter'));
      vi.advanceTimersByTime(1000);
      await Promise.resolve();

      const tooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]');
      expect(tooltip?.textContent).toBe('New chat');
      expect(tooltip?.textContent).not.toContain('click to open in editor');
    } finally {
      vi.useRealTimers();
    }
  });

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
    expect(menu!.textContent).toContain('Pin session');
    expect(menu!.textContent).toContain('Copy session ID');
    expect(menu!.textContent).toContain('Open in Editor');
    expect(menu!.textContent).toContain('Open in terminal');
    expect(menu!.textContent).toContain('Share session');
    expect(menu!.textContent).not.toContain('Unshare session');
    expect(menu!.textContent).toContain('Move to Recycle Bin');
    expect(
      Array.from(menu!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map((button) =>
        button.textContent?.trim()
      )
    ).toEqual([
      'Open in Editor',
      'Open in terminal',
      'Rename',
      'Pin session',
      'Copy session ID',
      'Share session',
      'Move to Recycle Bin',
    ]);
    expect(menu!.querySelectorAll('[role="separator"]')).toHaveLength(3);
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
    expect(menu?.textContent).toContain('Open in Editor');
    expect(menu?.textContent).toContain('Open in terminal');
    expect(menu?.textContent).toContain('Share session');
  });

  it('opens the active session as an editor and returns the panel to the sessions list', () => {
    const send = vi.fn<(message: WebviewMessage) => void>();
    // SAFETY: The fixture provides the bridge callback used by postMessage.
    (window as { __sendToExtension?: (message: WebviewMessage) => void }).__sendToExtension = send;
    renderHeader();
    container
      .querySelector<HTMLElement>('.chat-header-session-title')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Open in Editor')!
      .click();

    expect(send).toHaveBeenCalledWith({
      type: 'session/open-in-editor',
      payload: {
        sessionId: 'session-1',
        title: 'Session one',
        model: undefined,
      },
    });
    expect(showSessionPicker()).toBe(true);
  });

  it('keeps all plus clicks local and offers new-chat actions from the context menu', () => {
    const send = vi.fn<(message: WebviewMessage) => void>();
    const createActiveSession = vi.fn();
    const createPickerSession = vi.fn();
    // SAFETY: The fixture provides the bridge callback used by postMessage.
    (window as { __sendToExtension?: (message: WebviewMessage) => void }).__sendToExtension = send;
    renderHeader(null, { showActions: true, onCreateSession: createActiveSession });

    const activePlus = container.querySelector<HTMLButtonElement>('[aria-label="New chat"]')!;
    activePlus.click();
    activePlus.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));

    expect(createActiveSession).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.some(([message]) => message.type === 'chat/new-editor')).toBe(false);

    activePlus.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 30,
        clientY: 40,
      })
    );
    let menu = document.body.querySelector<HTMLElement>('[aria-label="New chat actions"]')!;
    expect(
      Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map((button) =>
        button.textContent?.trim()
      )
    ).toEqual(['New Chat', 'New Chat in Editor']);
    expect(menu.style.left).toBe('30px');
    expect(menu.style.top).toBe('40px');
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    expect(createActiveSession).toHaveBeenCalledTimes(3);

    activePlus.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    menu = document.body.querySelector<HTMLElement>('[aria-label="New chat actions"]')!;
    Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'New Chat in Editor')!
      .click();
    expect(send).toHaveBeenCalledWith({ type: 'chat/new-editor' });

    cleanup?.();
    cleanup = render(
      () => (
        <SessionPickerHeader
          filterLabel={null}
          filterPrefix="Filtered:"
          primarySessionsCount={1}
          showFailedBadge={false}
          showAttentionBadge={false}
          showPlanReadyBadge={false}
          showCompletedBadge={false}
          showRunningBadge={false}
          failedCount={0}
          attentionCount={0}
          planReadyCount={0}
          completedCount={0}
          runningCount={0}
          showNewChatButton
          onClearFilter={vi.fn()}
          onOpenFailedSessions={vi.fn()}
          onOpenAttentionSessions={vi.fn()}
          onOpenPlanReadySessions={vi.fn()}
          onOpenCompletedSessions={vi.fn()}
          onOpenRunningSessions={vi.fn()}
          onCreateSession={createPickerSession}
        />
      ),
      container
    );
    const pickerPlus = container.querySelector<HTMLButtonElement>('[aria-label="New chat"]')!;
    pickerPlus.click();
    pickerPlus.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));

    expect(createPickerSession).toHaveBeenCalledTimes(2);
    pickerPlus.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(document.body.querySelector('[aria-label="New chat actions"]')).not.toBeNull();
    expect(send.mock.calls.filter(([message]) => message.type === 'chat/new-editor')).toEqual([
      [{ type: 'chat/new-editor' }],
    ]);
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

    const pinnedIcon = container.querySelector<HTMLElement>(
      '[aria-label="Pinned session"] .session-item-pinned-icon'
    );
    expect(pinnedIcon?.classList).toContain('ui-icon');
    expect(pinnedIcon?.style.getPropertyValue('--ui-icon-width')).toBe('12px');
    container
      .querySelector<HTMLElement>('.chat-header-session-title')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const unpin = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ).find((button) => button.textContent === 'Unpin session');
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
        expect(feedback?.querySelector('.session-action-feedback-glyph')?.classList).toContain(
          'ui-icon'
        );
      });
      const sharedMarker = container.querySelector('[aria-label="Session is shared"]');
      expect(sharedMarker?.getAttribute('aria-label')).toBe('Session is shared');
      expect(sharedMarker?.getAttribute('title')).toBeNull();
      const sharedIcon = sharedMarker?.querySelector<HTMLElement>('.shared-session-icon');
      expect(sharedIcon?.classList).toContain('ui-icon');
      expect(sharedIcon?.style.getPropertyValue('--ui-icon-width')).toBe('12px');
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
    const subagentIcon = container.querySelector<HTMLElement>('.session-item-subagents-icon');
    expect(subagentIcon?.classList).toContain('ui-icon');
    expect(subagentIcon?.style.getPropertyValue('--ui-icon-width')).toBe('16px');
    expect(subagentIcon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(cableTagIcon));
  });
});
