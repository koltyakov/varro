import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { render } from '@solidjs/web';
import { cableTagIcon, folderIcon, gitIcon } from '../../lib/ui-icons';
import { toCssUrl } from '../UiIcon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types';
import type { SessionDiffSummary, WebviewMessage } from '../../../shared/protocol';
import { client } from '../../lib/client';
import {
  setManualWorkspaceSelection,
  setShowSessionPicker,
  setState,
  showSessionPicker,
  setIsLoading,
} from '../../lib/state';
import { ActiveChatHeader, SessionPickerHeader } from './ChatHeader';
import { SessionActionFeedback } from './SessionActionFeedback';
import { closeSideQuestion, sideQuestionView } from '../../lib/side-question';
import * as locationActions from '../../lib/session-location-actions';

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
  options: { showActions?: boolean; onCreateSession?: () => void; failedCount?: number } = {}
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
          failedCount={options.failedCount ?? 0}
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
          onOpenPendingSessions={vi.fn()}
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
  setState(storePath('sessions', [session()]));
  flushSolid();
  setState(storePath('activeSessionId', 'session-1'));
  flushSolid();
  setState(storePath('pinnedSessionIds', []));
  flushSolid();
  setState(storePath('siblingWorkspaceAlerts', []));
  flushSolid();
  setShowSessionPicker(false);
  flushSolid();
  setManualWorkspaceSelection(false);
  flushSolid();
  setState(storePath('pendingWorkspaceSelectionPath', null));
  flushSolid();
  deleteSessionMock.mockReset();
  deleteSessionMock.mockResolvedValue(undefined);
  renameSessionMock.mockReset();
  renameSessionMock.mockResolvedValue(true);
  vi.spyOn(client.varro.session, 'location').mockResolvedValue({
    directory: '/repo',
    isGitWorktree: false,
  });
});

afterEach(() => {
  cleanup?.();
  flushSolid();
  cleanup = undefined;
  container.remove();
  flushSolid();
  setState(storePath('sessions', []));
  flushSolid();
  setState(storePath('activeSessionId', null));
  flushSolid();
  setState(storePath('pinnedSessionIds', []));
  flushSolid();
  setState(storePath('siblingWorkspaceAlerts', []));
  flushSolid();
  setShowSessionPicker(false);
  flushSolid();
  setManualWorkspaceSelection(false);
  flushSolid();
  setState(storePath('pendingWorkspaceSelectionPath', null));
  flushSolid();
  Reflect.deleteProperty(window, '__sendToExtension');
  flushSolid();
  setState(storePath('serverStatus', { state: 'stopped' }));
  flushSolid();
  vi.restoreAllMocks();
  flushSolid();
  closeSideQuestion();
  flushSolid();
});

describe('SessionActionFeedback icon state', () => {
  it('uses an exclamation mark for errors and preserves dismissal behavior', () => {
    const onDismissError = vi.fn();
    cleanup = render(
      () => (
        <SessionActionFeedback error={() => 'Session failed'} onDismissError={onDismissError} />
      ),
      container
    );
    flushSolid();

    const feedback = document.body.querySelector<HTMLElement>('.session-action-feedback');
    expect(feedback?.classList).toContain('is-error');
    expect(feedback?.getAttribute('role')).toBe('alert');

    expect(feedback?.querySelector('.session-action-feedback-attention-glyph')?.textContent).toBe(
      '!'
    );
    expect(feedback?.querySelector('.session-action-feedback-glyph')).toBeNull();

    const dismissIcon = feedback?.querySelector<HTMLElement>(
      '.session-action-feedback-dismiss-icon'
    );
    expect(dismissIcon?.classList).toContain('ui-icon');
    expect(dismissIcon?.style.getPropertyValue('--ui-icon-width')).toBe('13px');

    feedback?.querySelector<HTMLButtonElement>('.session-action-feedback-dismiss')?.click();
    flushSolid();
    expect(onDismissError).toHaveBeenCalledOnce();
  });
});

describe('ActiveChatHeader', () => {
  it.each([false, true])(
    'offers Copy folder path for moved folders and worktrees, worktree=%s',
    async (worktree) => {
      const copy = vi.spyOn(locationActions, 'copySessionFolderPath').mockResolvedValue();
      setState(
        storePath('sessions', [
          session({
            directory: '/outside',
            isGitWorktree: worktree,
            transfer: { originDirectory: '/repo', available: true },
          }),
        ])
      );
      flushSolid();
      renderHeader();
      flushSolid();
      container.querySelector<HTMLButtonElement>('.chat-header-location')!.click();
      flushSolid();
      const items = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      );
      expect(items.some((item) => item.textContent?.trim() === 'Merge changes')).toBe(worktree);
      items.find((item) => item.textContent?.trim() === 'Copy folder path')!.click();
      flushSolid();
      expect(copy).toHaveBeenCalledExactlyOnceWith('/outside');
    }
  );

  it.each([false, true])(
    'dispatches worktree merging only when writable, readOnly=%s',
    (readOnly) => {
      const merge = vi.spyOn(locationActions, 'mergeSessionWorktree').mockResolvedValue(true);
      const move = vi.spyOn(locationActions, 'moveSessionWorktreeResults').mockResolvedValue(true);
      setState(
        storePath('sessions', [
          session({
            directory: '/worktrees/feature',
            isGitWorktree: true,
            transfer: { originDirectory: '/repo', available: !readOnly },
          }),
        ])
      );
      flushSolid();
      renderHeader();
      flushSolid();
      container.querySelector<HTMLButtonElement>('.chat-header-location')!.click();
      flushSolid();
      const action = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      ).find((item) => item.textContent?.trim() === 'Merge changes')!;
      expect(action.disabled).toBe(readOnly);
      action.click();
      flushSolid();
      expect(merge).toHaveBeenCalledTimes(readOnly ? 0 : 1);
      if (!readOnly) expect(merge).toHaveBeenCalledWith('session-1', '/worktrees/feature');
      if (!readOnly) container.querySelector<HTMLButtonElement>('.chat-header-location')!.click();
      flushSolid();
      const moveAction = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      ).find((item) => item.textContent?.trim() === 'Migrate changes')!;
      expect(moveAction.disabled).toBe(readOnly);
      moveAction.click();
      flushSolid();
      expect(move).toHaveBeenCalledTimes(readOnly ? 0 : 1);
      if (!readOnly) expect(move).toHaveBeenCalledWith('session-1', '/worktrees/feature');
    }
  );

  it.each([false, true])(
    'does not add a folder icon to an ordinary chat, returnedToOrigin=%s',
    async (returnedToOrigin) => {
      if (returnedToOrigin)
        setState(
          storePath('sessions', [
            session({ transfer: { originDirectory: '/repo', available: true } }),
          ])
        );
      flushSolid();
      renderHeader();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(container.querySelector('.chat-header-location')).toBeNull();
    }
  );

  it.each([false, true])(
    'shows the session path in a custom tooltip with worktree=%s',
    async (isGitWorktree) => {
      const directory = isGitWorktree ? '/worktrees/feature' : '/repo';
      setState(
        storePath('sessions', [
          session({
            directory,
            isGitWorktree,
            transfer: isGitWorktree ? undefined : { originDirectory: '/origin', available: true },
          }),
        ])
      );
      flushSolid();
      vi.mocked(client.varro.session.location).mockResolvedValue({ directory, isGitWorktree });
      renderHeader();
      flushSolid();
      const indicator = container.querySelector<HTMLButtonElement>('.chat-header-location')!;
      expect(
        indicator.previousElementSibling?.classList.contains('chat-header-session-title')
      ).toBe(true);
      expect(indicator.hasAttribute('title')).toBe(false);
      await vi.waitFor(() =>
        expect(indicator.getAttribute('aria-label')).toBe(
          isGitWorktree ? 'Session Git worktree' : 'Session folder'
        )
      );
      flushSolid();
      expect(
        indicator.querySelector<HTMLElement>('.ui-icon')?.style.getPropertyValue('--ui-icon-mask')
      ).toBe(toCssUrl(isGitWorktree ? gitIcon : folderIcon));
      vi.useFakeTimers();
      try {
        indicator.dispatchEvent(new MouseEvent('mouseenter'));
        flushSolid();
        vi.advanceTimersByTime(1000);
        flushSolid();
        await Promise.resolve();
        flushSolid();
        expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(directory);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('opens the current session folder from the location context menu without opening session actions', async () => {
    const send = vi.fn<(message: WebviewMessage) => void>();
    // SAFETY: The fixture owns the bridge callback and removes it after each test.
    (window as { __sendToExtension?: (message: WebviewMessage) => void }).__sendToExtension = send;
    setState(
      storePath('sessions', [
        session({ transfer: { originDirectory: '/origin', available: true } }),
      ])
    );
    flushSolid();
    renderHeader();
    flushSolid();
    const indicator = container.querySelector<HTMLButtonElement>('.chat-header-location')!;
    indicator.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 42, clientY: 51 })
    );
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const menu = document.body.querySelector<HTMLElement>('[aria-label="Session folder actions"]')!;
    expect(menu.style.left).toBe('42px');
    expect(menu.style.top).toBe('51px');
    expect(document.body.querySelector('[aria-label="Session actions"]')).toBeNull();
    expect(document.activeElement).toBe(menu.querySelector('[role="menuitem"]'));
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    flushSolid();
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-folder',
      payload: { sessionId: 'session-1', directory: '/repo' },
    });
    expect(document.body.querySelector('[aria-label="Session folder actions"]')).toBeNull();
  });

  it('closes the location menu on Escape, outside interaction, and session change', async () => {
    setState(
      storePath('sessions', [
        session({ transfer: { originDirectory: '/origin', available: true } }),
      ])
    );
    flushSolid();
    renderHeader();
    flushSolid();
    const indicator = () => container.querySelector<HTMLButtonElement>('.chat-header-location')!;
    indicator().click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    document.body
      .querySelector('[aria-label="Session folder actions"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSolid();
    expect(document.body.querySelector('[aria-label="Session folder actions"]')).toBeNull();
    expect(document.activeElement).toBe(indicator());
    indicator().click();
    flushSolid();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    flushSolid();
    expect(document.body.querySelector('[aria-label="Session folder actions"]')).toBeNull();
    indicator().click();
    flushSolid();
    setState(storePath('sessions', [session({ directory: '/other' })]));
    flushSolid();
    expect(document.body.querySelector('[aria-label="Session folder actions"]')).toBeNull();
  });

  it('ignores stale worktree metadata after the session location changes', async () => {
    let resolve!: (value: { directory: string; isGitWorktree: boolean }) => void;
    vi.mocked(client.varro.session.location).mockReturnValueOnce(
      new Promise((next) => {
        resolve = next;
      })
    );
    renderHeader();
    flushSolid();
    setState(storePath('sessions', [session({ directory: '/other' })]));
    flushSolid();
    resolve({ directory: '/repo', isGitWorktree: true });
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container.querySelector('.chat-header-location')).toBeNull();
  });

  it.each([false, true])('opens the V2 side-question form with busy=%s', (busy) => {
    setState(
      storePath('serverStatus', { state: 'running', url: 'http://localhost:4096', apiVersion: 2 })
    );
    flushSolid();
    setState(storePath('sessionStatus', busy ? { 'session-1': { type: 'busy' } } : {}));
    flushSolid();
    setIsLoading(busy);
    flushSolid();
    renderHeader();
    flushSolid();
    container
      .querySelector<HTMLElement>('.chat-header-session-title')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    const action = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (button) => button.textContent?.trim() === 'Ask side-question'
    );
    expect(action?.disabled).toBe(false);
    action!.click();
    flushSolid();
    expect(sideQuestionView()).toMatchObject({
      sessionID: 'session-1',
      directory: '/repo',
      question: '',
    });
    expect(document.activeElement).toBe(container.querySelector('.chat-header-session-title'));
    setState(storePath('serverStatus', { state: 'stopped' }));
    flushSolid();
    setIsLoading(false);
    flushSolid();
    setState(storePath('sessionStatus', {}));
    flushSolid();
  });

  it('opens a single sibling workspace alert directly before status indicators', () => {
    const send = vi.fn<(message: WebviewMessage) => void>();
    // SAFETY: The fixture provides the bridge callback used by postMessage.
    (window as { __sendToExtension?: (message: WebviewMessage) => void }).__sendToExtension = send;
    setState(
      storePath('siblingWorkspaceAlerts', [
        { name: 'Repo B', path: '/repo-b', kinds: ['error'], count: 1 },
      ])
    );
    flushSolid();
    renderHeader(null, { showActions: true, failedCount: 1 });
    flushSolid();

    const actions = container.querySelector('.chat-header-actions')!;
    const alertButton = actions.querySelector<HTMLButtonElement>('.chat-header-sibling-alerts')!;
    expect(
      alertButton.querySelector('.chat-header-sibling-alert-icon')?.getAttribute('data-kind')
    ).toBe('error');
    expect(actions.firstElementChild).toBe(alertButton);
    alertButton.click();
    flushSolid();

    expect(send).toHaveBeenCalledWith({
      type: 'workspace/select',
      payload: { path: '/repo-b', requestId: expect.any(Number) },
    });
    expect(showSessionPicker()).toBe(true);
    expect(document.body.querySelector('.sibling-workspace-alerts-menu')).toBeNull();
  });

  it('offers a workspace dropdown when sibling events span multiple workspaces', async () => {
    const send = vi.fn<(message: WebviewMessage) => void>();
    // SAFETY: The fixture provides the bridge callback used by postMessage.
    (window as { __sendToExtension?: (message: WebviewMessage) => void }).__sendToExtension = send;
    setState(
      storePath('siblingWorkspaceAlerts', [
        { name: 'Repo B', path: '/repo-b', kinds: ['attention'], count: 2 },
        { name: 'Repo C', path: '/repo-c', kinds: ['plan-ready'], count: 1 },
      ])
    );
    flushSolid();
    renderHeader(null, { showActions: true });
    flushSolid();

    container.querySelector<HTMLButtonElement>('.chat-header-sibling-alerts')!.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const menu = document.body.querySelector<HTMLElement>('.sibling-workspace-alerts-menu');
    expect(menu?.getAttribute('role')).toBe('menu');
    const repoC = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []
    ).find((button) => button.textContent?.includes('Repo C'))!;
    menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    flushSolid();
    expect(document.activeElement).toBe(repoC);
    menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    flushSolid();
    expect(document.activeElement).toBe(menu?.querySelector('[role="menuitem"]'));
    menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    flushSolid();
    expect(document.activeElement).toBe(repoC);
    repoC.click();
    flushSolid();

    expect(send).toHaveBeenCalledWith({
      type: 'workspace/select',
      payload: { path: '/repo-c', requestId: expect.any(Number) },
    });
    expect(document.body.querySelector('.sibling-workspace-alerts-menu')).toBeNull();
  });

  it('animates the sibling workspace notification icon every 10 seconds', () => {
    vi.useFakeTimers();
    try {
      renderHeader(null, { showActions: true });
      flushSolid();

      setState(
        storePath('siblingWorkspaceAlerts', [
          { name: 'Repo B', path: '/repo-b', kinds: ['attention'], count: 1 },
        ])
      );
      flushSolid();

      const icon = container.querySelector('.chat-header-sibling-alert-icon')!;
      expect(icon.classList.contains('is-ringing')).toBe(true);

      icon.classList.remove('is-ringing');
      flushSolid();
      vi.advanceTimersByTime(9_999);
      flushSolid();
      expect(icon.classList.contains('is-ringing')).toBe(false);
      vi.advanceTimersByTime(1);
      flushSolid();
      expect(icon.classList.contains('is-ringing')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cycles the sibling workspace notification color through distinct event kinds', () => {
    vi.useFakeTimers();
    try {
      setState(
        storePath('siblingWorkspaceAlerts', [
          {
            name: 'Repo B',
            path: '/repo-b',
            kinds: ['attention', 'error'],
            count: 2,
          },
          {
            name: 'Repo C',
            path: '/repo-c',
            kinds: ['completed', 'error', 'plan-ready'],
            count: 3,
          },
        ])
      );
      flushSolid();
      renderHeader(null, { showActions: true });
      flushSolid();

      const icon = container.querySelector('.chat-header-sibling-alert-icon')!;
      expect(icon.getAttribute('data-kind')).toBe('attention');
      vi.advanceTimersByTime(2_000);
      flushSolid();
      expect(icon.getAttribute('data-kind')).toBe('completed');
      vi.advanceTimersByTime(2_000);
      flushSolid();
      expect(icon.getAttribute('data-kind')).toBe('error');
      vi.advanceTimersByTime(2_000);
      flushSolid();
      expect(icon.getAttribute('data-kind')).toBe('plan-ready');
      vi.advanceTimersByTime(2_000);
      flushSolid();
      expect(icon.getAttribute('data-kind')).toBe('attention');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a plain new-chat tooltip without a modifier shortcut', async () => {
    vi.useFakeTimers();
    try {
      renderHeader(null, { showActions: true });
      flushSolid();
      container
        .querySelector<HTMLButtonElement>('[aria-label="New chat"]')!
        .dispatchEvent(new MouseEvent('mouseenter'));
      flushSolid();
      vi.advanceTimersByTime(1000);
      flushSolid();
      await Promise.resolve();
      flushSolid();

      const tooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]');
      expect(tooltip?.textContent).toBe('New chat');
      expect(tooltip?.textContent).not.toContain('click to open in editor');
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the session context menu from the title', () => {
    renderHeader();
    flushSolid();

    container.querySelector<HTMLElement>('.chat-header-session-title')!.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 50,
      })
    );
    flushSolid();

    const menu = document.body.querySelector<HTMLElement>('[aria-label="Session actions"]');
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain('Rename');
    expect(menu!.textContent).toContain('Pin session');
    expect(menu!.textContent).toContain('Copy session ID');
    expect(menu!.textContent).toContain('Open in Editor');
    expect(menu!.textContent).toContain('Open in Terminal');
    expect(menu!.textContent).not.toContain('Share session');
    expect(menu!.textContent).not.toContain('Unshare session');
    expect(menu!.textContent).toContain('Move to Recycle Bin');
    expect(
      Array.from(menu!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map((button) =>
        button.textContent?.trim()
      )
    ).toEqual([
      'Open in Editor',
      'Open in Window',
      'Open in Terminal',
      'Rename',
      'Pin session',
      'Copy session ID',
      'Move to Recycle Bin',
    ]);
    expect(menu!.querySelectorAll('[role="separator"]')).toHaveLength(3);
    expect(menu!.style.left).toBe('40px');
    expect(menu!.style.top).toBe('50px');
  });

  it.each([false, true])(
    'sets Rename availability for a moved session, available=%s',
    (available) => {
      setState(
        storePath('sessions', [
          session({
            directory: '/outside',
            transfer: { originDirectory: '/repo', available },
          }),
        ])
      );
      flushSolid();
      renderHeader();
      flushSolid();
      container
        .querySelector<HTMLElement>('.chat-header-session-title')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      flushSolid();

      const rename = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      ).find((button) => button.textContent?.trim() === 'Rename')!;
      expect(rename.disabled).toBe(!available);
      rename.click();
      flushSolid();

      expect(document.querySelector('.session-item-rename-form') !== null).toBe(available);
      expect(renameSessionMock).not.toHaveBeenCalled();
    }
  );

  it('blocks a rename if the conversation becomes a read-only moved link while editing', () => {
    renderHeader();
    flushSolid();
    container
      .querySelector<HTMLElement>('.chat-header-session-title')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Rename')!
      .click();
    flushSolid();
    const input = document.querySelector<HTMLInputElement>('[id^="header-session-rename-"]')!;
    input.value = 'New title';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    flushSolid();

    setState(
      storePath('sessions', [
        session({
          directory: '/outside',
          transfer: { originDirectory: '/repo', available: false },
        }),
      ])
    );
    flushSolid();

    const form = document.querySelector<HTMLFormElement>('.session-item-rename-form')!;
    expect(form.querySelector<HTMLInputElement>('input')?.disabled).toBe(true);
    expect(form.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true);
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    flushSolid();
    expect(renameSessionMock).not.toHaveBeenCalled();
    form.querySelector<HTMLButtonElement>('[type="button"]')!.click();
    flushSolid();
    expect(document.querySelector('.session-item-rename-form')).toBeNull();
  });

  it('hides rename and recycle-bin actions for an active sub-agent session', () => {
    setState(storePath('sessions', [session({ parentID: 'parent' })]));
    flushSolid();
    renderHeader();
    flushSolid();

    container
      .querySelector<HTMLElement>('.chat-header-session-title')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();

    const menu = document.body.querySelector<HTMLElement>('[aria-label="Session actions"]');
    expect(menu?.textContent).not.toContain('Rename');
    expect(menu?.textContent).not.toContain('Move to Recycle Bin');
    expect(menu?.textContent).toContain('Copy session ID');
    expect(menu?.textContent).toContain('Open in Editor');
    expect(menu?.textContent).toContain('Open in Terminal');
    expect(menu?.textContent).not.toContain('Share session');
  });

  it('opens the active session as an editor and returns the panel to the sessions list', () => {
    const send = vi.fn<(message: WebviewMessage) => void>();
    // SAFETY: The fixture provides the bridge callback used by postMessage.
    (window as { __sendToExtension?: (message: WebviewMessage) => void }).__sendToExtension = send;
    renderHeader();
    flushSolid();
    container
      .querySelector<HTMLElement>('.chat-header-session-title')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();

    Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Open in Editor')!
      .click();
    flushSolid();

    expect(send).toHaveBeenCalledWith({
      type: 'session/open-in-editor',
      payload: {
        sessionId: 'session-1',
        directory: '/repo',
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
    flushSolid();

    const activePlus = container.querySelector<HTMLButtonElement>('[aria-label="New chat"]')!;
    activePlus.click();
    flushSolid();
    activePlus.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    flushSolid();

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
    flushSolid();
    let menu = document.body.querySelector<HTMLElement>('[aria-label="New chat actions"]')!;
    expect(
      Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map((button) =>
        button.textContent?.trim()
      )
    ).toEqual(['New Chat', 'New Chat Editor', 'New Chat Window']);
    expect(menu.style.left).toBe('30px');
    expect(menu.style.top).toBe('40px');
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    flushSolid();
    expect(createActiveSession).toHaveBeenCalledTimes(3);

    activePlus.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    menu = document.body.querySelector<HTMLElement>('[aria-label="New chat actions"]')!;
    Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'New Chat Editor')!
      .click();
    flushSolid();
    expect(send).toHaveBeenCalledWith({ type: 'chat/new-editor' });

    activePlus.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    menu = document.body.querySelector<HTMLElement>('[aria-label="New chat actions"]')!;
    Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'New Chat Window')!
      .click();
    flushSolid();
    expect(send).toHaveBeenCalledWith({ type: 'chat/new-window' });
    expect(document.body.querySelector('[aria-label="New chat actions"]')).toBeNull();

    cleanup?.();
    flushSolid();
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
          onOpenPendingSessions={vi.fn()}
          onCreateSession={createPickerSession}
        />
      ),
      container
    );
    flushSolid();
    const pickerPlus = container.querySelector<HTMLButtonElement>('[aria-label="New chat"]')!;
    pickerPlus.click();
    flushSolid();
    pickerPlus.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    flushSolid();

    expect(createPickerSession).toHaveBeenCalledTimes(2);
    pickerPlus.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    expect(document.body.querySelector('[aria-label="New chat actions"]')).not.toBeNull();
    expect(send.mock.calls.filter(([message]) => message.type === 'chat/new-editor')).toEqual([
      [{ type: 'chat/new-editor' }],
    ]);
  });

  it('returns to the sessions list after deleting from the header menu', async () => {
    renderHeader();
    flushSolid();
    container
      .querySelector<HTMLElement>('.chat-header-session-title')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();

    Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Move to Recycle Bin')!
      .click();
    flushSolid();

    await vi.waitFor(() => {
      expect(deleteSessionMock).toHaveBeenCalledWith('session-1');
      expect(showSessionPicker()).toBe(true);
    });
    flushSolid();
  });

  it('shows the pinned marker and toggles pinning from the context menu', async () => {
    setState(storePath('pinnedSessionIds', ['session-1']));
    flushSolid();
    const setPinned = vi.spyOn(client.varro.session, 'setPinned').mockResolvedValueOnce([]);
    renderHeader();
    flushSolid();

    const pinnedIcon = container.querySelector<HTMLElement>(
      '[aria-label="Pinned session"] .session-item-pinned-icon'
    );
    expect(pinnedIcon?.classList).toContain('ui-icon');
    expect(pinnedIcon?.style.getPropertyValue('--ui-icon-width')).toBe('12px');
    container
      .querySelector<HTMLElement>('.chat-header-session-title')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    const unpin = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ).find((button) => button.textContent === 'Unpin session');
    unpin!.click();
    flushSolid();

    await vi.waitFor(() =>
      expect(setPinned).toHaveBeenCalledWith('session-1', false, { directory: '/repo' })
    );
    flushSolid();
    await vi.waitFor(() => {
      expect(container.querySelector('[aria-label="Pinned session"]')).toBeNull();
    });
    flushSolid();
  });

  it('shows feedback after clearing an existing v1 share link from the header menu', async () => {
    setState(storePath('sessions', [session({ share: { url: 'https://share.test/session-1' } })]));
    flushSolid();
    const unshare = vi.spyOn(client.session, 'unshare').mockResolvedValue(session());
    renderHeader();
    flushSolid();
    const sharedMarker = container.querySelector('[aria-label="Session is shared"]');
    expect(sharedMarker?.getAttribute('title')).toBeNull();
    const sharedIcon = sharedMarker?.querySelector<HTMLElement>('.shared-session-icon');
    expect(sharedIcon?.classList).toContain('ui-icon');
    expect(sharedIcon?.style.getPropertyValue('--ui-icon-width')).toBe('12px');
    container
      .querySelector<HTMLElement>('.chat-header-session-title')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Unshare session')!
      .click();
    flushSolid();

    await vi.waitFor(() => {
      expect(unshare).toHaveBeenCalledWith('session-1', { directory: '/repo' });
      const feedback = document.body.querySelector<HTMLElement>('.session-action-feedback');
      expect(feedback?.textContent?.trim()).toBe('Session unshared');
      expect(feedback?.querySelector('.session-action-feedback-glyph')?.classList).toContain(
        'ui-icon'
      );
      expect(container.querySelector('[aria-label="Session is shared"]')).toBeNull();
    });
    flushSolid();
  });

  it('hides share cleanup when the backend does not support it', () => {
    setState(
      storePath('sessions', [
        session({ sharingSupported: false, share: { url: 'https://share.test/old' } }),
      ])
    );
    flushSolid();
    renderHeader();
    flushSolid();
    container
      .querySelector<HTMLElement>('.chat-header-session-title')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    const menu = document.body.querySelector<HTMLElement>('[aria-label="Session actions"]');
    expect(menu?.textContent).not.toContain('Share session');
    expect(menu?.textContent).not.toContain('Unshare session');
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
    flushSolid();

    await vi.waitFor(() => {
      const duration = container.querySelector('.chat-header-session-duration');
      expect(duration?.textContent).toBe('1m 5s');
    });
    flushSolid();
    const duration = container.querySelector('.chat-header-session-duration');
    expect(duration?.previousElementSibling?.classList).toContain('chat-header-subagents');
    const subagentIcon = container.querySelector<HTMLElement>('.session-item-subagents-icon');
    expect(subagentIcon?.classList).toContain('ui-icon');
    expect(subagentIcon?.style.getPropertyValue('--ui-icon-width')).toBe('16px');
    expect(subagentIcon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(cableTagIcon));
  });

  it('refreshes paused timing, holds it while idle, and counts only the resumed work period', async () => {
    const summary: SessionDiffSummary = {
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 10_000,
      activeStartedAt: null,
    };
    const request = vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue(summary);
    setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
    flushSolid();
    renderHeader();
    flushSolid();
    await vi.waitFor(() =>
      expect(container.querySelector('.chat-header-session-duration')?.textContent).toBe('10s')
    );
    flushSolid();
    vi.useFakeTimers();
    try {
      const pausedAt = Date.now();
      setState(
        storePath('sessions', 0, 'metadata', {
          varro: { pauses: [{ messageId: 'paused', pausedAt }] },
        })
      );
      flushSolid();
      await vi.advanceTimersByTimeAsync(3_600_000);
      flushSolid();
      expect(request).toHaveBeenLastCalledWith('session-1', pausedAt, { directory: '/repo' });
      expect(container.querySelector('.chat-header-session-duration')?.textContent).toBe('10s');
      request.mockResolvedValue({ ...summary, activeStartedAt: Date.now() });
      setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
      flushSolid();
      await vi.advanceTimersByTimeAsync(5_000);
      flushSolid();
      expect(container.querySelector('.chat-header-session-duration')?.textContent).toBe('15s');
    } finally {
      setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
      flushSolid();
      vi.useRealTimers();
    }
  });
});
