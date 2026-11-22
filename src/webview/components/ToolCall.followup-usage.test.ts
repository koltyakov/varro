import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import type { SessionFollowupUsage, SessionUsageTotals } from '../../shared/protocol';
import { setState } from '../lib/state';
import { client } from '../lib/client';
import { followupUsage } from '../lib/followup-usage';
import type { Session, ToolPart } from '../types';
import { ToolCall, resetToolCallExpansionState } from './ToolCall';

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

function totals(overrides: Partial<SessionUsageTotals> = {}): SessionUsageTotals {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    steps: 1,
    missing: 0,
    active: 0,
    ...overrides,
  };
}

function childSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'child',
    projectID: 'project-1',
    directory: '/repo',
    parentID: 'session-1',
    title: 'review',
    version: '1',
    time: { created: 0, updated: 0 },
    tokens: { input: 900, output: 90, reasoning: 9, cache: { read: 0, write: 100 } },
    cost: 2,
    ...overrides,
  };
}

function launch(
  callID: string,
  metadata: { sessionID?: string; childPromptID?: string }
): ToolPart {
  return {
    id: `tool-${callID}`,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID,
    tool: 'task',
    state: {
      status: 'completed',
      input: { description: 'review', prompt: 'Review it' },
      output: 'The subagent is working in the background (sessionID: child).',
      title: 'review',
      metadata: { sessionID: 'child', status: 'running', ...metadata },
      time: { start: 1, end: 2 },
    },
  };
}

function emit(type: string, properties: Record<string, string>) {
  window.dispatchEvent(
    new MessageEvent('message', { data: { type: 'server/event', payload: { type, properties } } })
  );
  flushSolid();
}

function summaryFor(
  promptID: string,
  usage: Partial<SessionUsageTotals>,
  final = true
): SessionFollowupUsage {
  return {
    supported: true,
    complete: true,
    pendingPromptIDs: [],
    intervals: [{ promptIDs: [promptID], final, usage: totals(usage) }],
  };
}

async function settle() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
  flushSolid();
}

function header(selector: string, root: ParentNode = container) {
  return root.querySelector(`.tool-invocation-header ${selector}`);
}

function detailRow(label: string) {
  return [...container.querySelectorAll('.structured-tool-row')].find(
    (row) => row.querySelector('.structured-tool-label')?.textContent === label
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  followupUsage.resetForTests();
  setState(storePath('sessions', [childSession()]));
  flushSolid();
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  flushSolid();
  container.remove();
  setState(storePath('sessions', []));
  flushSolid();
  resetToolCallExpansionState();
  followupUsage.resetForTests();
  vi.restoreAllMocks();
});

describe('ToolCall follow-up usage', () => {
  it('shows the admitted prompt interval with interval cost and session totals in details', async () => {
    const summary: SessionFollowupUsage = {
      supported: true,
      complete: true,
      pendingPromptIDs: [],
      intervals: [
        {
          promptIDs: ['p1', 'p2'],
          final: true,
          usage: totals({
            input: 10,
            cacheWrite: 5,
            output: 3,
            reasoning: 2,
            cost: 0.5,
            cacheRead: 70,
          }),
        },
      ],
    };
    vi.spyOn(client.varro.session, 'followupUsage').mockResolvedValue(summary);

    cleanup = render(
      () => ToolCall({ part: launch('call-2', { childPromptID: 'p2' }) }),
      container
    );
    flushSolid();
    expect(header('.tool-invocation-token-label')?.textContent).toBe('Loading usage');
    expect(header('.tool-invocation-token-stats')).toBeNull();
    await settle();

    expect(header('.tool-invocation-token-label')?.textContent).toBe('Shared usage');
    const stats = header('.tool-invocation-token-stats');
    expect(stats?.textContent).toBe('↑ 15 ↓ 5');
    expect(stats?.getAttribute('title')).toContain('Shared response usage: 2 prompts');
    expect(stats?.getAttribute('title')).toContain('Cache reads: 70.');

    container.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();
    flushSolid();
    expect(detailRow('cost')?.querySelector('.structured-tool-value')?.textContent).toBe('$0.50');
    expect(detailRow('cache read')?.querySelector('.structured-tool-value')?.textContent).toBe(
      '70'
    );
    expect(detailRow('session total')?.querySelector('.structured-tool-value')?.textContent).toBe(
      '↑ 1,000 ↓ 99 · $2.00'
    );
  });

  it('shares one read across cards for the same child and refreshes on reconnect', async () => {
    const read = vi.spyOn(client.varro.session, 'followupUsage').mockResolvedValue({
      supported: true,
      complete: true,
      pendingPromptIDs: ['p2'],
      intervals: [{ promptIDs: ['p1'], final: true, usage: totals({ input: 4, output: 1 }) }],
    });

    cleanup = render(
      () => [
        ToolCall({ part: launch('call-1', { childPromptID: 'p1' }) }),
        ToolCall({ part: launch('call-2', { childPromptID: 'p2' }) }),
      ],
      container
    );
    await settle();

    expect(read).toHaveBeenCalledTimes(1);
    const [first, second] = [...container.querySelectorAll('.tool-invocation-header')];
    expect(first?.querySelector('.tool-invocation-token-stats')?.textContent).toBe('↑ 4 ↓ 1');
    expect(first?.querySelector('.tool-invocation-token-label')).toBeNull();
    // An undelivered follow-up never borrows session totals.
    expect(second?.querySelector('.tool-invocation-token-label')?.textContent).toBe(
      'Usage pending'
    );
    expect(second?.querySelector('.tool-invocation-token-stats')).toBeNull();

    // Totals are unchanged, but a reconnect may have missed deliveries.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'server/event', payload: { type: 'server.connected' } },
      })
    );
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reports unavailable usage when the prompt is older than the bounded history', async () => {
    vi.spyOn(client.varro.session, 'followupUsage').mockResolvedValue({
      supported: true,
      complete: false,
      pendingPromptIDs: [],
      intervals: [],
    });

    cleanup = render(
      () => ToolCall({ part: launch('call-1', { childPromptID: 'old' }) }),
      container
    );
    await settle();

    const label = header('.tool-invocation-token-label');
    expect(label?.textContent).toBe('Usage unavailable');
    expect(label?.getAttribute('title')).toContain('older than the subagent history');
    expect(header('.tool-invocation-token-stats')).toBeNull();
    container.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();
    flushSolid();
    expect(detailRow('cost')).toBeUndefined();
  });

  it('labels older explicitly linked calls with session totals and matching cost', () => {
    const read = vi.spyOn(client.varro.session, 'followupUsage');

    cleanup = render(() => ToolCall({ part: launch('call-1', {}) }), container);
    flushSolid();

    expect(read).not.toHaveBeenCalled();
    const label = header('.tool-invocation-token-label');
    expect(label?.textContent).toBe('Σ1');
    expect(label?.getAttribute('title')).toBe(
      'Session 1 total: all recorded usage in this subagent session, including work after later follow-ups. Session ID: child. Input includes cache writes; output includes reasoning.'
    );
    expect(header('.tool-invocation-token-stats')?.textContent).toBe('↑ 1,000 ↓ 99');
    container.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();
    flushSolid();
    expect(detailRow('cost')?.querySelector('.structured-tool-value')?.textContent).toBe('$2.00');
  });

  it('indexes child sessions rather than calls or matching token totals', () => {
    const first = childSession({ time: { created: 10, updated: 10 } });
    const second = childSession({ id: 'second', time: { created: 20, updated: 20 } });
    const unrelated = childSession({ id: 'unrelated', parentID: 'another-parent' });
    // Both children have identical usage, and the session list is not in creation order.
    setState(storePath('sessions', [second, unrelated, first]));
    flushSolid();
    cleanup = render(
      () => [
        ToolCall({ part: launch('relay', { sessionID: 'child' }) }),
        ToolCall({ part: launch('review', { sessionID: 'second' }) }),
        ToolCall({ part: launch('fix', { sessionID: 'child' }) }),
        ToolCall({ part: launch('coordinate', { sessionID: 'second' }) }),
      ],
      container
    );
    flushSolid();
    const labels = () =>
      [...container.querySelectorAll('.tool-invocation-token-label')].map(
        (label) => label.textContent
      );
    expect(labels()).toEqual(['Σ1', 'Σ2', 'Σ1', 'Σ2']);
    expect(
      [...container.querySelectorAll('.tool-invocation-token-label')].map((label) =>
        label.getAttribute('title')
      )
    ).toEqual([
      expect.stringContaining('Session ID: child.'),
      expect.stringContaining('Session ID: second.'),
      expect.stringContaining('Session ID: child.'),
      expect.stringContaining('Session ID: second.'),
    ]);

    setState(
      storePath('sessions', [
        first,
        childSession({ id: 'later', time: { created: 30, updated: 30 } }),
        second,
        unrelated,
      ])
    );
    flushSolid();
    expect(labels()).toEqual(['Σ1', 'Σ2', 'Σ1', 'Σ2']);
  });

  it('never shows zero counters for an interval without a recorded step', async () => {
    const read = vi
      .spyOn(client.varro.session, 'followupUsage')
      .mockResolvedValueOnce(summaryFor('p1', { steps: 0, active: 1 }, false));

    cleanup = render(
      () => ToolCall({ part: launch('call-1', { childPromptID: 'p1' }) }),
      container
    );
    await settle();

    expect(header('.tool-invocation-token-label')?.textContent).toBe('Usage pending');
    expect(header('.tool-invocation-token-stats')).toBeNull();
    container.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();
    flushSolid();
    expect(detailRow('cost')).toBeUndefined();

    // The step settled without usage: still unknown, so no zero subtotal.
    read.mockResolvedValueOnce(summaryFor('p1', { steps: 0, missing: 1 }));
    emit('session.next.step.ended', { sessionID: 'child' });
    await settle();
    expect(header('.tool-invocation-token-label')?.textContent).toBe('Partial usage');
    expect(header('.tool-invocation-token-stats')).toBeNull();
  });

  it('refreshes on a delivery to its child even when totals and status are unchanged', async () => {
    const read = vi.spyOn(client.varro.session, 'followupUsage').mockResolvedValueOnce({
      supported: true,
      complete: true,
      pendingPromptIDs: ['p1'],
      intervals: [],
    });

    cleanup = render(
      () => ToolCall({ part: launch('call-1', { childPromptID: 'p1' }) }),
      container
    );
    await settle();
    expect(header('.tool-invocation-token-label')?.textContent).toBe('Usage pending');

    emit('session.next.prompted', { sessionID: 'other-child' });
    await settle();
    expect(read).toHaveBeenCalledTimes(1);

    read.mockResolvedValueOnce(summaryFor('p1', { input: 6, output: 2 }));
    emit('session.next.prompted', { sessionID: 'child' });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(header('.tool-invocation-token-stats')?.textContent).toBe('↑ 6 ↓ 2');
  });

  it('marks an open interval unavailable when its refresh fails', async () => {
    const read = vi
      .spyOn(client.varro.session, 'followupUsage')
      .mockResolvedValueOnce(summaryFor('p1', { input: 6, output: 2, active: 1 }, false));

    cleanup = render(
      () => ToolCall({ part: launch('call-1', { childPromptID: 'p1' }) }),
      container
    );
    await settle();
    expect(header('.tool-invocation-token-stats')?.textContent).toBe('↑ 6 ↓ 2');

    read.mockRejectedValueOnce(new Error('offline'));
    emit('session.next.step.ended', { sessionID: 'child' });
    await settle();

    const label = header('.tool-invocation-token-label');
    expect(label?.textContent).toBe('Usage unavailable');
    expect(label?.getAttribute('title')).toContain('refresh failed');
    expect(header('.tool-invocation-token-stats')).toBeNull();
  });

  it('reads in the child directory and ignores a read for a previous directory', async () => {
    const resolvers: Array<(value: SessionFollowupUsage) => void> = [];
    const read = vi.spyOn(client.varro.session, 'followupUsage').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );

    cleanup = render(
      () => ToolCall({ part: launch('call-1', { childPromptID: 'p1' }) }),
      container
    );
    flushSolid();
    expect(read).toHaveBeenLastCalledWith('child', {
      directory: '/repo',
      signal: expect.any(AbortSignal),
    });

    setState(storePath('sessions', [childSession({ directory: '/other' })]));
    flushSolid();
    expect(read).toHaveBeenLastCalledWith('child', {
      directory: '/other',
      signal: expect.any(AbortSignal),
    });
    // The previous directory's read was abandoned with its last card.
    expect(read.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);

    resolvers[0]!(summaryFor('p1', { input: 99 }));
    await settle();
    expect(header('.tool-invocation-token-label')?.textContent).toBe('Loading usage');

    resolvers[1]!(summaryFor('p1', { input: 6, output: 2 }));
    await settle();
    expect(header('.tool-invocation-token-stats')?.textContent).toBe('↑ 6 ↓ 2');
  });

  it('drops a closed interval on revert and ignores the late pre-revert read', async () => {
    const resolvers: Array<(value: SessionFollowupUsage) => void> = [];
    const read = vi
      .spyOn(client.varro.session, 'followupUsage')
      .mockResolvedValueOnce(summaryFor('p1', { input: 6, output: 2 }))
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
          })
      );

    cleanup = render(
      () => ToolCall({ part: launch('call-1', { childPromptID: 'p1' }) }),
      container
    );
    await settle();
    expect(header('.tool-invocation-token-stats')?.textContent).toBe('↑ 6 ↓ 2');

    // A delivery starts a read, then a revert replaces history before it settles.
    emit('session.next.prompted', { sessionID: 'child' });
    emit('session.next.revert.committed', { sessionID: 'child' });
    await settle();
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    expect(header('.tool-invocation-token-label')?.textContent).toBe('Loading usage');
    expect(header('.tool-invocation-token-stats')).toBeNull();

    resolvers[0]!(summaryFor('p1', { input: 99, output: 9 }));
    await settle();
    expect(header('.tool-invocation-token-label')?.textContent).toBe('Loading usage');
    expect(header('.tool-invocation-token-stats')).toBeNull();

    // The reverted prompt is gone from fresh history.
    resolvers[1]!({ supported: true, complete: true, pendingPromptIDs: [], intervals: [] });
    await settle();
    expect(header('.tool-invocation-token-label')?.textContent).toBe('Usage unavailable');
    expect(header('.tool-invocation-token-stats')).toBeNull();
  });

  it('treats a reconnect as unknown history and reloads closed intervals', async () => {
    const read = vi
      .spyOn(client.varro.session, 'followupUsage')
      .mockResolvedValueOnce(summaryFor('p1', { input: 6, output: 2 }))
      .mockImplementationOnce(() => new Promise(() => {}));

    cleanup = render(
      () => ToolCall({ part: launch('call-1', { childPromptID: 'p1' }) }),
      container
    );
    await settle();
    emit('server.connected', {});
    await settle();

    expect(read).toHaveBeenCalledTimes(2);
    expect(header('.tool-invocation-token-label')?.textContent).toBe('Loading usage');
    expect(header('.tool-invocation-token-stats')).toBeNull();
  });

  it('reports a pending prompt unavailable once a refresh after its delivery fails', async () => {
    const read = vi.spyOn(client.varro.session, 'followupUsage').mockResolvedValueOnce({
      supported: true,
      complete: true,
      pendingPromptIDs: ['p1'],
      intervals: [],
    });

    cleanup = render(
      () => ToolCall({ part: launch('call-1', { childPromptID: 'p1' }) }),
      container
    );
    await settle();
    expect(header('.tool-invocation-token-label')?.textContent).toBe('Usage pending');

    read.mockRejectedValueOnce(new Error('offline'));
    emit('session.next.prompted', { sessionID: 'child' });
    await settle();
    expect(header('.tool-invocation-token-label')?.textContent).toBe('Usage unavailable');
  });

  it.each(['session.next.prompted', 'session.next.revert.committed'])(
    'reads fresh after %s while no card was mounted, with totals unchanged',
    async (type) => {
      const read = vi
        .spyOn(client.varro.session, 'followupUsage')
        .mockResolvedValueOnce(summaryFor('p1', { input: 6, output: 2 }))
        .mockImplementationOnce(() => new Promise(() => {}));
      const part = launch('call-1', { childPromptID: 'p1' });
      cleanup = render(() => ToolCall({ part }), container);
      await settle();
      cleanup();
      cleanup = undefined;
      flushSolid();

      emit(type, { sessionID: 'child' });
      await settle();
      // Unmounted cards do not read.
      expect(read).toHaveBeenCalledTimes(1);

      cleanup = render(() => ToolCall({ part }), container);
      await settle();
      expect(read).toHaveBeenCalledTimes(2);
      expect(header('.tool-invocation-token-label')?.textContent).toBe('Loading usage');
      expect(header('.tool-invocation-token-stats')).toBeNull();
    }
  );
});
