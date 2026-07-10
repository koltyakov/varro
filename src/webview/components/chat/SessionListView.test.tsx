import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types';
import { client } from '../../lib/client';
import { setState } from '../../lib/state';
import {
  getSessionDiffSummaryStateForTests,
  resetSessionDiffSummaryStateForTests,
  SessionListView,
} from './SessionListView';

vi.mock('../../hooks/useOpenCode', () => ({
  deleteSession: vi.fn(),
  deleteSessionPermanently: vi.fn(),
  emptyRecycleBin: vi.fn(),
  restoreSession: vi.fn(),
  selectSession: vi.fn(),
}));

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

function session(id: string, updated: number): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: id,
    version: '1',
    time: { created: updated - 1_000, updated },
    summary: { files: 0, additions: 0, deletions: 0 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  resetSessionDiffSummaryStateForTests();
  setState('sessions', []);
  setState('activeSessionId', null);
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
  setState('sessions', []);
  vi.restoreAllMocks();
  resetSessionDiffSummaryStateForTests();
});

describe('SessionListView diff summaries', () => {
  it('uses the aggregate session diff response instead of loading full diffs or messages', async () => {
    const diffSummarySpy = vi
      .spyOn(client.varro.session, 'diffSummary')
      .mockResolvedValue({ files: 2, additions: 6, deletions: 4 });
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
    expect(diffSpy).not.toHaveBeenCalled();
    expect(messagesSpy).not.toHaveBeenCalled();
  });

  it('caps and drops queued work when sessions are no longer visible', async () => {
    const pending = deferred<{ files: number; additions: number; deletions: number }>();
    vi.spyOn(client.varro.session, 'diffSummary').mockReturnValue(pending.promise);
    setState(
      'sessions',
      Array.from({ length: 160 }, (_, index) => session(`session-${index}`, Date.now() - index))
    );

    cleanup = render(() => <SessionListView />, container);

    expect(getSessionDiffSummaryStateForTests()).toMatchObject({ active: 4, queued: 100 });

    setState('sessions', []);
    expect(getSessionDiffSummaryStateForTests().queued).toBe(0);

    pending.resolve({ files: 0, additions: 0, deletions: 0 });
    await vi.waitFor(() => expect(getSessionDiffSummaryStateForTests().active).toBe(0));
  });

  it('bounds cached summaries across changing visible session sets', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
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
});
