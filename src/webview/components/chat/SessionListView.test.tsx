import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types';
import { client } from '../../lib/client';
import { setSessions, setState } from '../../lib/state';
import { selectSession } from '../../hooks/useOpenCode';
import {
  getSessionDiffSummaryStateForTests,
  resetSessionDiffSummaryStateForTests,
  SessionListView,
} from './SessionListView';

const renameSessionMock = vi.hoisted(() => vi.fn());

vi.mock('../../hooks/useOpenCode', () => ({
  deleteSession: vi.fn(),
  deleteSessionPermanently: vi.fn(),
  emptyRecycleBin: vi.fn(),
  restoreSession: vi.fn(),
  renameSession: renameSessionMock,
  selectSession: vi.fn(),
}));

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

function session(id: string, updated: number, overrides: Partial<Session> = {}): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: id,
    version: '1',
    time: { created: updated - 1_000, updated },
    summary: { files: 0, additions: 0, deletions: 0 },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function openSessionActions(row: HTMLElement, x = 40, y = 50) {
  row.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    })
  );
}

beforeEach(() => {
  resetSessionDiffSummaryStateForTests();
  setState('sessions', []);
  setState('pinnedSessionIds', []);
  setState('activeSessionId', null);
  setState('sessionStatus', {});
  renameSessionMock.mockReset();
  renameSessionMock.mockResolvedValue(true);
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
  setState('sessions', []);
  setState('pinnedSessionIds', []);
  setState('sessionStatus', {});
  vi.restoreAllMocks();
  resetSessionDiffSummaryStateForTests();
});

describe('SessionListView diff summaries', () => {
  it('uses the aggregate session diff response instead of loading full diffs or messages', async () => {
    const diffSummarySpy = vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 2,
      additions: 6,
      deletions: 4,
      tokens: 12_345,
      durationMs: 65_000,
      activeStartedAt: null,
    });
    const diffSpy = vi.spyOn(client.session, 'diff').mockResolvedValue([]);
    const messagesSpy = vi.spyOn(client.session, 'messages').mockResolvedValue([]);
    setState('sessions', [session('session-1', Date.now())]);

    cleanup = render(() => <SessionListView />, container);

    await vi.waitFor(() => expect(diffSummarySpy).toHaveBeenCalledWith('session-1'));
    await vi.waitFor(() => {
      expect(container.querySelector('.session-item-meta')?.textContent).toContain('2 files');
    });
    expect(container.querySelector('.session-item-meta')?.textContent).toContain('+6');
    expect(container.querySelector('.session-item-meta')?.textContent).toContain('-4');
    expect(container.querySelector('.session-item-meta')?.textContent).toContain('12k tokens');
    expect(container.querySelector('.session-item-meta')?.textContent).toContain('1m 5s');
    expect(container.querySelector('[title="12,345 tokens spent"]')).not.toBeNull();
    expect(container.querySelector('[title="1m 5s total time worked"]')).not.toBeNull();
    expect(diffSpy).not.toHaveBeenCalled();
    expect(messagesSpy).not.toHaveBeenCalled();
  });

  it('uses loaded diff counts when stale edit counts already exist on the session', async () => {
    const diffSummarySpy = vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 2,
      additions: 6,
      deletions: 4,
      tokens: 900,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState('sessions', [
      session('session-1', Date.now(), {
        summary: { files: 1, additions: 3, deletions: 2 },
      }),
    ]);

    cleanup = render(() => <SessionListView />, container);

    await vi.waitFor(() => expect(diffSummarySpy).toHaveBeenCalledWith('session-1'));
    await vi.waitFor(() => {
      const meta = container.querySelector('.session-item-meta')?.textContent;
      expect(meta).toContain('2 files');
      expect(meta).toContain('+6');
      expect(meta).toContain('-4');
      expect(meta).toContain('900 tokens');
    });
  });

  it('updates the duration of a running session every second', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 100,
      durationMs: 5_000,
      activeStartedAt: 90_000,
    });
    setState('sessionStatus', { 'session-1': { type: 'busy' } });
    setState('sessions', [session('session-1', 100_000)]);

    try {
      cleanup = render(() => <SessionListView />, container);
      await vi.advanceTimersByTimeAsync(0);
      expect(container.querySelector('.session-item-meta')?.textContent).toContain('15s');

      await vi.advanceTimersByTimeAsync(2_000);
      expect(container.querySelector('.session-item-meta')?.textContent).toContain('17s');
    } finally {
      cleanup?.();
      cleanup = undefined;
      vi.useRealTimers();
    }
  });

  it('caps and drops queued work when sessions are no longer visible', async () => {
    const pending = deferred<{
      files: number;
      additions: number;
      deletions: number;
      tokens: number;
      durationMs: number;
      activeStartedAt: number | null;
    }>();
    vi.spyOn(client.varro.session, 'diffSummary').mockReturnValue(pending.promise);
    setState(
      'sessions',
      Array.from({ length: 160 }, (_, index) => session(`session-${index}`, Date.now() - index))
    );

    cleanup = render(() => <SessionListView />, container);

    expect(getSessionDiffSummaryStateForTests()).toMatchObject({ active: 4, queued: 100 });

    setState('sessions', []);
    expect(getSessionDiffSummaryStateForTests().queued).toBe(0);

    pending.resolve({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    await vi.waitFor(() => expect(getSessionDiffSummaryStateForTests().active).toBe(0));
  });

  it('bounds cached summaries across changing visible session sets', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    cleanup = render(() => <SessionListView />, container);

    for (let batch = 0; batch < 3; batch += 1) {
      setState(
        'sessions',
        Array.from({ length: 90 }, (_, index) =>
          session(`batch-${batch}-session-${index}`, Date.now() - index)
        )
      );
      await vi.waitFor(() => {
        const state = getSessionDiffSummaryStateForTests();
        expect(state.active).toBe(0);
        expect(state.queued).toBe(0);
      });
    }

    const state = getSessionDiffSummaryStateForTests();
    expect(state.cached).toBe(state.cacheLimit);
  });

  it('settles failures for a revision instead of immediately retrying', async () => {
    const diffSummarySpy = vi
      .spyOn(client.varro.session, 'diffSummary')
      .mockRejectedValue(new Error('server unavailable'));
    const updated = Date.now();
    setState('sessions', [session('session-1', updated)]);

    cleanup = render(() => <SessionListView />, container);

    await vi.waitFor(() => expect(getSessionDiffSummaryStateForTests().active).toBe(0));
    expect(diffSummarySpy).toHaveBeenCalledTimes(1);

    setState('sessions', [session('session-1', updated)]);
    await Promise.resolve();
    expect(diffSummarySpy).toHaveBeenCalledTimes(1);

    setState('sessions', [session('session-1', updated + 1)]);
    await vi.waitFor(() => expect(diffSummarySpy).toHaveBeenCalledTimes(2));
  });

  it('refreshes a root summary when a descendant session updates', async () => {
    const diffSummarySpy = vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 100,
      durationMs: 0,
      activeStartedAt: null,
    });
    setSessions([
      session('session-1', 100_000),
      session('child-1', 100_000, { parentID: 'session-1' }),
    ]);

    cleanup = render(() => <SessionListView />, container);
    await vi.waitFor(() => expect(diffSummarySpy).toHaveBeenCalledTimes(1));

    setSessions([
      session('session-1', 100_000),
      session('child-1', 100_001, {
        parentID: 'session-1',
        tokens: {
          input: 200,
          output: 20,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    ]);

    await vi.waitFor(() => expect(diffSummarySpy).toHaveBeenCalledTimes(2));
    expect(diffSummarySpy).toHaveBeenNthCalledWith(2, 'session-1');
  });
});

describe('SessionListView pins', () => {
  it('pins and unpins a session from its row menu and highlights it', async () => {
    const setPinned = vi
      .spyOn(client.varro.session, 'setPinned')
      .mockResolvedValueOnce(['session-1'])
      .mockResolvedValueOnce([]);
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState('sessions', [session('session-1', Date.now())]);
    cleanup = render(() => <SessionListView />, container);

    const row = () => container.querySelector<HTMLElement>('.session-item')!;
    expect(row().querySelector('.session-item-pin')).toBeNull();
    expect(row().querySelector('.session-item-archive')).toBeNull();

    expect(row().querySelector('[aria-label="Session actions"]')).toBeNull();
    openSessionActions(row());
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Pin')!
      .click();

    await vi.waitFor(() => expect(setPinned).toHaveBeenCalledWith('session-1', true));
    await vi.waitFor(() => {
      expect(row().classList.contains('is-pinned')).toBe(true);
      expect(row().querySelector('[aria-label="Pinned session"]')).not.toBeNull();
    });
    openSessionActions(row());
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Unpin')!
      .click();

    await vi.waitFor(() => expect(setPinned).toHaveBeenLastCalledWith('session-1', false));
    await vi.waitFor(() => {
      expect(row().classList.contains('is-pinned')).toBe(false);
      expect(row().querySelector('[aria-label="Pinned session"]')).toBeNull();
    });
  });
});

describe('SessionListView selection', () => {
  it('does not highlight the active session', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState('sessions', [session('session-1', Date.now())]);
    setState('activeSessionId', 'session-1');

    cleanup = render(() => <SessionListView />, container);

    expect(container.querySelector('.session-item')?.classList.contains('active')).toBe(false);
  });

  it('navigates, wraps, scrolls, and selects sessions with the keyboard', async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    setState('sessions', [session('session-1', Date.now()), session('session-2', Date.now() - 1)]);

    try {
      cleanup = render(() => <SessionListView embedded />, container);
      const list = container.querySelector<HTMLElement>('.session-list-view')!;
      const items = Array.from(container.querySelectorAll<HTMLElement>('.session-item'));

      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      await Promise.resolve();
      expect(items[1]?.classList.contains('keyboard-focus')).toBe(true);
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });

      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await Promise.resolve();
      expect(items[0]?.classList.contains('keyboard-focus')).toBe(true);

      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(selectSession).toHaveBeenCalledWith('session-1');
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('synchronizes keyboard selection when a session receives focus', () => {
    setState('sessions', [session('session-1', Date.now()), session('session-2', Date.now() - 1)]);
    cleanup = render(() => <SessionListView embedded />, container);

    const buttons = container.querySelectorAll<HTMLButtonElement>('.session-item-main');
    buttons[1]!.focus();

    expect(
      container.querySelectorAll('.session-item')[1]?.classList.contains('keyboard-focus')
    ).toBe(true);
  });
});

describe('SessionListView ordering', () => {
  it('keeps similarly updated sessions in newest-created-first order', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const now = Date.now();
    setSessions([
      session('older-created', now - 1_000, {
        time: { created: now - 50_000, updated: now - 1_000 },
      }),
      session('newer-created', now - 20_000, {
        time: { created: now - 30_000, updated: now - 20_000 },
      }),
    ]);

    cleanup = render(() => <SessionListView />, container);

    expect(
      Array.from(container.querySelectorAll('.session-item-title-text')).map(
        (element) => element.textContent
      )
    ).toEqual(['newer-created', 'older-created']);
  });
});

describe('SessionListView actions', () => {
  it('obscures other sessions and consumes an outside click before closing the menu', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const updated = Date.now();
    setState('sessions', [session('session-1', updated), session('session-2', updated - 1)]);
    cleanup = render(() => <SessionListView />, container);

    const rows = container.querySelectorAll<HTMLElement>('.session-item');
    const owningRow = rows[0]!;
    const otherRow = rows[1]!;
    openSessionActions(owningRow);

    expect(owningRow.classList.contains('is-context-selected')).toBe(true);
    expect(otherRow.classList.contains('is-context-obscured')).toBe(true);

    const backdrop = document.querySelector<HTMLElement>('.session-item-actions-backdrop')!;
    backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(otherRow.classList.contains('is-context-obscured')).toBe(false);
  });

  it('freezes session row order until the context menu closes', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const updated = Date.now();
    setSessions([session('session-1', updated), session('session-2', updated - 1)]);
    cleanup = render(() => <SessionListView />, container);

    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    setSessions([session('session-1', updated), session('session-2', updated + 1)]);

    const rowTitles = () =>
      Array.from(container.querySelectorAll('.session-item-title-text')).map(
        (element) => element.textContent
      );
    expect(rowTitles()).toEqual(['session-1', 'session-2']);

    document
      .querySelector<HTMLElement>('.session-item-actions-backdrop')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));

    expect(rowTitles()).toEqual(['session-2', 'session-1']);
  });

  it('keeps the context menu and owning row selected across session list updates', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const now = Date.now();
    setSessions([session('session-1', now, { title: 'First session' })]);
    cleanup = render(() => <SessionListView />, container);
    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);

    expect(
      container.querySelector('.session-item')?.classList.contains('is-context-selected')
    ).toBe(true);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    setSessions([
      session('session-1', now + 1, { title: 'Updated session' }),
      session('archived-session', now - 2 * 24 * 60 * 60 * 1_000),
    ]);

    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(
      container.querySelector('.session-item')?.classList.contains('is-context-selected')
    ).toBe(true);
  });

  it('keeps an in-progress rename across session list updates', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const now = Date.now();
    setSessions([session('session-1', now, { title: 'First session' })]);
    cleanup = render(() => <SessionListView />, container);
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector<HTMLInputElement>('.session-list-search-input')
      )
    );

    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    await Promise.resolve();
    const input = document.querySelector<HTMLInputElement>('[id^="session-rename-"]')!;
    input.value = 'Draft rename';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    input.focus();
    input.setSelectionRange(5, 5);
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const unrelatedMutation = document.createElement('div');
    document.body.append(unrelatedMutation);
    await Promise.resolve();
    expect(input.selectionStart).toBe(5);
    expect(input.selectionEnd).toBe(5);
    unrelatedMutation.remove();

    setSessions([
      session('session-1', now + 1, { title: 'Updated session' }),
      session('archived-session', now - 2 * 24 * 60 * 60 * 1_000),
    ]);

    await vi.waitFor(() => {
      const updatedInput = document.querySelector<HTMLInputElement>('[id^="session-rename-"]');
      expect(updatedInput?.value).toBe('Draft rename');
      expect(document.activeElement).toBe(updatedInput);
      expect(updatedInput?.selectionStart).toBe(5);
      expect(updatedInput?.selectionEnd).toBe(5);
    });
    expect(
      container.querySelector('.session-item')?.classList.contains('is-context-selected')
    ).toBe(true);
  });

  it('closes the context menu when rename is cancelled', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const updated = Date.now();
    setSessions([session('session-1', updated), session('session-2', updated - 1)]);
    cleanup = render(() => <SessionListView />, container);

    const rows = container.querySelectorAll<HTMLElement>('.session-item');
    openSessionActions(rows[0]!);
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Cancel')!
      .click();

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('.session-item-actions-backdrop')).toBeNull();
    expect(rows[0]!.classList.contains('is-context-selected')).toBe(false);
    expect(rows[1]!.classList.contains('is-context-obscured')).toBe(false);
  });

  it('renames a session from its row action menu', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState('sessions', [session('session-1', Date.now())]);
    cleanup = render(() => <SessionListView />, container);

    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();

    const input = document.querySelector<HTMLInputElement>('[id^="session-rename-"]')!;
    input.value = '  Better title  ';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    input.closest('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true }));

    await vi.waitFor(() => {
      expect(renameSessionMock).toHaveBeenCalledWith('session-1', 'Better title');
    });
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  });

  it('opens the row menu at the right-click position without an actions button', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const updated = Date.now();
    setState('sessions', [
      session('parent', updated),
      session('child', updated - 1, { parentID: 'parent' }),
    ]);
    cleanup = render(() => <SessionListView onOpenSubagents={vi.fn()} />, container);

    const row = container.querySelector<HTMLElement>('.session-item')!;
    expect(row.querySelector('.session-item-actions-trigger')).toBeNull();

    openSessionActions(row, 72, 84);

    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.style.left).toBe('72px');
    expect(menu.style.top).toBe('84px');
  });
});
