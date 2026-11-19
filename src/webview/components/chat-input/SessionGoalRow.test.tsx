import { createSignal, flush as flushSolid } from 'solid-js';
import { render } from '@solidjs/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionGoal } from '../../../shared/session-goal';
import type { ServerEvent } from '../../../shared/protocol';
import { client } from '../../lib/client';
import { SessionGoalRow } from './SessionGoalRow';

const goal: SessionGoal = {
  id: 'goal-1',
  objective: 'Wait for 1 minute',
  status: 'active',
  rounds: 0,
  maxRounds: 50,
  updatedAt: 1,
};
let container: HTMLDivElement;
let cleanup: (() => void) | undefined;
async function settle() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
  flushSolid();
}
function emit(event: ServerEvent) {
  window.dispatchEvent(
    new MessageEvent('message', { data: { type: 'server/event', payload: event } })
  );
  flushSolid();
}
function change(next: SessionGoal | null, sessionID = 'ses_one') {
  emit({ type: 'session.goal.updated', properties: { sessionID, goal: next } });
}
function button(label: string) {
  return container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
}
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  vi.spyOn(client.session, 'goal').mockResolvedValue(goal);
  vi.spyOn(client.session, 'command').mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup?.();
  flushSolid();
  cleanup = undefined;
  container.remove();
  vi.restoreAllMocks();
});

describe('SessionGoalRow', () => {
  it('shows a compact goal row with always-available pause and clear controls', async () => {
    cleanup = render(() => <SessionGoalRow sessionID="ses_one" directory="/repo" />, container);
    await settle();
    expect(container.querySelector('.chat-queue-item')?.textContent).toContain(
      'Goal: Wait for 1 minute'
    );
    expect(container.textContent).not.toContain('Active');
    expect(container.querySelector('.chat-queue-paused-label')).toBeNull();
    expect(button('Pause goal')).not.toBeNull();
    expect(button('Clear goal')).not.toBeNull();
    expect(button('Pause goal')?.closest('.chat-queue-actions')).toBeNull();
    expect(client.session.goal).toHaveBeenCalledWith(
      'ses_one',
      expect.objectContaining({ directory: '/repo' })
    );
  });

  it('runs pause, resume, and clear against the owning session without picker overrides', async () => {
    cleanup = render(() => <SessionGoalRow sessionID="ses_one" directory="/repo" />, container);
    await settle();
    button('Pause goal')!.click();
    await settle();
    expect(client.session.command).toHaveBeenLastCalledWith(
      'ses_one',
      { command: 'goal', arguments: 'pause' },
      { directory: '/repo' }
    );
    expect(button('Pause goal')).not.toBeNull();
    change({ ...goal, status: 'paused', reason: 'Paused by the user' });
    expect(container.textContent).toContain('Paused');
    button('Resume goal')!.click();
    await settle();
    expect(client.session.command).toHaveBeenLastCalledWith(
      'ses_one',
      { command: 'goal', arguments: 'resume' },
      { directory: '/repo' }
    );
    change(goal);
    button('Clear goal')!.click();
    await settle();
    expect(client.session.command).toHaveBeenLastCalledWith(
      'ses_one',
      { command: 'goal', arguments: 'clear' },
      { directory: '/repo' }
    );
    expect(container.textContent).toContain(goal.objective);
    change(null);
    expect(container.textContent).toBe('');
  });

  it('follows automatic pauses and completion, ignoring other sessions', async () => {
    cleanup = render(() => <SessionGoalRow sessionID="ses_one" />, container);
    await settle();
    change(null, 'ses_other');
    expect(container.textContent).toContain(goal.objective);
    change({ ...goal, status: 'paused', reason: 'Not making progress' });
    expect(button('Resume goal')).not.toBeNull();
    expect(container.querySelector('.chat-queue-paused-label')?.textContent).toBe('Paused');
    expect(container.querySelector('.chat-queue-paused-label')?.getAttribute('title')).toBe(
      'Not making progress'
    );
    expect(container.textContent).not.toContain('Not making progress');
    change({ ...goal, status: 'complete', reason: 'Verified' });
    expect(container.textContent).not.toContain('Complete');
    expect(container.querySelector('.chat-queue-paused-label')).toBeNull();
    expect(container.querySelector('.chat-queue-label')?.getAttribute('title')).toContain(
      'Verified'
    );
    expect(button('Pause goal')).toBeNull();
    expect(button('Resume goal')).toBeNull();
    expect(button('Clear goal')).not.toBeNull();
  });

  it('keeps reasons in tooltips without adding a second row', async () => {
    cleanup = render(() => <SessionGoalRow sessionID="ses_one" />, container);
    await settle();
    expect(container.querySelector('.chat-goal-reason')).toBeNull();
    change({ ...goal, status: 'paused' });
    expect(container.querySelector('.chat-goal-reason')).toBeNull();
    change({ ...goal, status: 'paused', reason: 'Paused by the user' });
    expect(container.textContent).not.toContain('Paused by the user');
    expect(container.querySelector('.chat-queue-paused-label')?.getAttribute('title')).toBe(
      'Paused by the user'
    );
    change({ ...goal, reason: 'Resumed by the user' });
    expect(container.querySelector('.chat-queue-paused-label')).toBeNull();
    expect(container.querySelector('.chat-goal-reason')).toBeNull();
  });

  it('does not let a stale snapshot overwrite a newer event', async () => {
    let resolve!: (value: SessionGoal | null) => void;
    vi.mocked(client.session.goal).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    cleanup = render(() => <SessionGoalRow sessionID="ses_one" />, container);
    flushSolid();
    change({ ...goal, status: 'paused' });
    resolve(goal);
    await settle();
    expect(container.textContent).toContain('Paused');
  });

  it('loads goals again after reconnecting, without periodic polling', async () => {
    vi.mocked(client.session.goal).mockResolvedValueOnce(goal).mockResolvedValueOnce(null);
    cleanup = render(() => <SessionGoalRow sessionID="ses_one" />, container);
    await settle();
    emit({ type: 'server.connected' });
    await settle();
    expect(container.textContent).toBe('');
    expect(client.session.goal).toHaveBeenCalledTimes(2);
  });

  it('cancels stale reads and never carries a goal to another session', async () => {
    const [sessionID, setSessionID] = createSignal('ses_one');
    let resolve!: (value: SessionGoal | null) => void;
    vi.mocked(client.session.goal)
      .mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        })
      )
      .mockResolvedValueOnce(null);
    cleanup = render(() => <SessionGoalRow sessionID={sessionID()} />, container);
    flushSolid();
    const signal = vi.mocked(client.session.goal).mock.calls[0]?.[1]?.signal;
    setSessionID('ses_two');
    flushSolid();
    resolve(goal);
    await settle();
    change(goal, 'ses_one');
    expect(signal?.aborted).toBe(true);
    expect(container.textContent).toBe('');
  });

  it('prevents overlapping controls and retains state with an actionable error on rejection', async () => {
    let reject!: (cause: Error) => void;
    vi.mocked(client.session.command).mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      })
    );
    cleanup = render(() => <SessionGoalRow sessionID="ses_one" />, container);
    await settle();
    button('Pause goal')!.click();
    flushSolid();
    expect(button('Pause goal')?.disabled).toBe(true);
    expect(button('Clear goal')?.disabled).toBe(true);
    button('Clear goal')!.click();
    expect(client.session.command).toHaveBeenCalledTimes(1);
    reject(new Error('Connection lost'));
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Connection lost');
    expect(container.textContent).toContain(goal.objective);
    expect(button('Pause goal')?.disabled).toBe(false);
  });

  it('renders nothing when no goal is set or the plugin is unavailable', async () => {
    vi.mocked(client.session.goal).mockRejectedValue(new Error('RPC not found'));
    cleanup = render(() => <SessionGoalRow sessionID="ses_one" />, container);
    await settle();
    expect(container.textContent).toBe('');
    change(goal);
    expect(container.textContent).toContain(goal.objective);
  });
});
