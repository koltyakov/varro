import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComputed, createRoot } from 'solid-js';
import type { TextPart } from '../../types';
import { StreamingPresentation } from './streaming-presentation';
import type { PresentationItem } from './streaming-presentation';

function text(value: string, id = 'text'): PresentationItem {
  return { key: `message\u0000${id}`, partId: id, kind: 'text', text: value };
}
function activity(id: string, running = false): PresentationItem {
  return {
    key: `message\u0000${id}`,
    partId: id,
    kind: 'activity',
    running,
    active: true,
    expanded: false,
  };
}
function part(id = 'text'): TextPart {
  return { id, sessionID: 'session', messageID: 'message', type: 'text', text: '' };
}

describe('StreamingPresentation', () => {
  let queue: StreamingPresentation;
  const exits = new Map<string, () => void>();
  const beforeLastExit = vi.fn();
  const update = (
    items: PresentationItem[],
    options: { scope?: string; immediate?: boolean; live?: boolean } = {}
  ) => {
    queue.update({
      scope: options.scope ?? 'session',
      turn: 'turn',
      items,
      live: options.live ?? true,
      immediate: options.immediate ?? false,
    });
  };
  beforeEach(() => {
    vi.useFakeTimers();
    exits.clear();
    beforeLastExit.mockClear();
    queue = new StreamingPresentation({
      beforeExit: vi.fn(),
      beforeGroup: vi.fn(),
      beforeLastExit,
      afterExit: (key, complete) => {
        exits.set(key, complete);
      },
    });
  });
  afterEach(() => {
    queue.dispose();
    vi.useRealTimers();
  });

  it('shows loaded history immediately and paces only subsequent additions', async () => {
    update([activity('old'), text('Already here')]);
    expect(queue.textForPart(part())).toBe('Already here');
    expect(queue.pending()).toBe(false);
    expect(queue.retainedActivity().size).toBe(0);
    update([activity('old'), text('Already here. ' + 'A fresh readable paragraph. '.repeat(80))]);
    expect(queue.textForPart(part())).toBe('Already here');
    await vi.advanceTimersByTimeAsync(100);
    const displayed = queue.textForPart(part())!;
    expect(displayed.length).toBeGreaterThan('Already here'.length);
    expect(displayed.length).toBeLessThan(1_500);
    await vi.advanceTimersByTimeAsync(200);
    expect(queue.textForPart(part())).toBe(
      'Already here. ' + 'A fresh readable paragraph. '.repeat(80)
    );
    expect(queue.pending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('admits a large completed burst one block at a time and coalesces overflow', async () => {
    update([]);
    const tools = Array.from({ length: 32 }, (_, index) => activity(`tool-${index}`));
    update([...tools, text('The answer is ready.')]);
    await vi.advanceTimersByTimeAsync(100);
    expect([...queue.retainedActivity()]).toEqual(['message\u0000tool-0']);
    await vi.advanceTimersByTimeAsync(100);
    expect(queue.retainedActivity().size).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect([...queue.retainedActivity()]).toEqual(['message\u0000tool-0', 'message\u0000tool-1']);
    await vi.advanceTimersByTimeAsync(1_080);
    expect(queue.exitingActivity().size).toBeGreaterThanOrEqual(3);
    expect(queue.exitingActivity().size).toBeLessThanOrEqual(6);
    expect(queue.textForPart(part())).toBe('');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queue.hiddenParts().size).toBe(0);
    expect(queue.textForPart(part())).toBe('The answer is ready.');
    expect(queue.pending()).toBe(false);
  });

  it('collects parallel fast tools into one readable moment and waits for the actual exit', async () => {
    update([]);
    update([activity('one'), activity('two'), text('Answer follows the preview.')]);
    expect(queue.hiddenParts().size).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    expect([...queue.retainedActivity()]).toEqual(['message\u0000one']);
    await vi.advanceTimersByTimeAsync(120);
    expect([...queue.retainedActivity()]).toEqual(['message\u0000one', 'message\u0000two']);
    expect(queue.textForPart(part())).toBe('');
    await vi.advanceTimersByTimeAsync(1_080);
    expect(queue.exitingActivity().size).toBe(2);
    await vi.advanceTimersByTimeAsync(420);
    expect(queue.exitingActivity().size).toBe(2);
    expect(queue.textForPart(part())).toBe('');
    exits.get('message\u0000one')!();
    expect(beforeLastExit).not.toHaveBeenCalled();
    exits.get('message\u0000two')!();
    expect(beforeLastExit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(queue.textForPart(part())).toBe('Answer follows the preview.');
    expect(queue.pending()).toBe(false);
  });

  it('does not restart a burst deadline when another completed tool joins it', async () => {
    update([]);
    update([activity('one')]);
    await vi.advanceTimersByTimeAsync(1_000);
    update([activity('one'), activity('two'), text('Ready')]);
    await vi.advanceTimersByTimeAsync(300);
    expect([...queue.exitingActivity()]).toEqual(['message\u0000one']);
    expect(queue.hiddenParts().has('message\u0000two')).toBe(false);
    await vi.advanceTimersByTimeAsync(700);
    expect(queue.textForPart(part())).toBe('Ready');
    expect(queue.exitingActivity().size).toBe(0);
  });

  it('keeps standalone content behind preceding text until it has caught up', async () => {
    update([]);
    update([
      text('Prose before an edit. '.repeat(80)),
      { key: 'message\u0000edit', partId: 'edit', kind: 'instant' },
    ]);
    expect(queue.hiddenParts().has('message\u0000edit')).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(queue.hiddenParts().has('message\u0000edit')).toBe(false);
    expect(queue.pending()).toBe(false);
  });

  it('bypasses prompt delays while preserving unrelated running activity', () => {
    update([]);
    update([activity('one', true), text('Waiting for approval.')]);
    queue.update({
      scope: 'session',
      turn: 'turn',
      items: [activity('one', true), text('Waiting for approval.')],
      live: true,
      immediate: true,
      keepRunningVisible: true,
    });
    expect(queue.visibleActivity().has('message\u0000one')).toBe(true);
    expect(queue.textForPart(part())).toBe('Waiting for approval.');
    expect(queue.pending()).toBe(false);
  });

  it('paces the next admission from the painted frame rather than an overdue timer', async () => {
    const paints: Array<() => void> = [];
    queue.dispose();
    queue = new StreamingPresentation({
      beforeExit: vi.fn(),
      beforeGroup: vi.fn(),
      beforeLastExit,
      afterExit: vi.fn(),
      afterShow: (painted) => {
        paints.push(painted);
      },
    });
    update([]);
    update([activity('one', true), activity('two', true), activity('three', true)]);
    await vi.advanceTimersByTimeAsync(100);
    expect(queue.visibleActivity().size).toBe(1);
    await vi.advanceTimersByTimeAsync(120);
    expect(queue.visibleActivity().size).toBe(1);
    paints[0]!();
    await vi.advanceTimersByTimeAsync(119);
    expect(queue.visibleActivity().size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.visibleActivity().size).toBe(2);
    queue.flush();
    paints[1]!();
    expect(queue.pending()).toBe(false);
    expect(queue.visibleActivity().size).toBe(0);
  });

  it('keeps an inspected completed tool open and releases the answer gate', async () => {
    update([]);
    update([activity('one'), text('Ready to read')]);
    await vi.advanceTimersByTimeAsync(100);
    queue.inspectActivity('message\u0000one', true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(queue.retainedActivity().has('message\u0000one')).toBe(true);
    expect(queue.textForPart(part())).toBe('Ready to read');
    expect(queue.pending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    queue.inspectActivity('message\u0000one', false);
    expect(queue.exitingActivity().has('message\u0000one')).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(queue.exitingActivity().size).toBe(0);
  });

  it('applies shorter and divergent canonical corrections and discards queued suffixes', async () => {
    update([text('Prefix')]);
    update([text('Prefix ' + 'queued words '.repeat(100))]);
    await vi.advanceTimersByTimeAsync(64);
    update([text('Corrected')]);
    expect(queue.textForPart(part())).toBe('Corrected');
    update([text('Short')]);
    await vi.advanceTimersByTimeAsync(500);
    expect(queue.textForPart(part())).toBe('Short');
    expect(queue.pending()).toBe(false);
  });

  it('does not split surrogate pairs and eventually reveals the exact Unicode text', async () => {
    update([]);
    const target = '🙂'.repeat(1_000);
    update([text(target)]);
    for (let index = 0; index < 10; index += 1) {
      await vi.advanceTimersByTimeAsync(32);
      const displayed = queue.textForPart(part())!;
      expect(displayed).toMatch(/^(?:🙂)*$/u);
      expect(target.startsWith(displayed)).toBe(true);
    }
    expect(queue.textForPart(part())).toBe(target);
  });

  it('flushes immediately for interruption and rejects callbacks from a replaced session', async () => {
    update([]);
    update([activity('one'), text('Queued answer')]);
    await vi.advanceTimersByTimeAsync(1_300);
    const staleExit = exits.get('message\u0000one')!;
    queue.flush();
    expect(queue.textForPart(part())).toBe('Queued answer');
    expect(queue.pending()).toBe(false);
    update([text('Another session')], { scope: 'other' });
    staleExit();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(queue.textForPart(part())).toBe('Another session');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels scheduled text and activity work on disposal', () => {
    update([]);
    update([activity('one'), text('Pending')]);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    queue.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases reactive readers of the previous turn even when the next turn is empty', async () => {
    update([]);
    update([text('Queued words. '.repeat(100))]);
    let observed: string | undefined;
    const dispose = createRoot((disposeRoot) => {
      createComputed(() => {
        observed = queue.textForPart(part());
      });
      return disposeRoot;
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(observed?.length).toBeGreaterThan(0);
    queue.update({ scope: 'session', turn: 'next', items: [], live: true, immediate: false });
    expect(observed).toBeUndefined();
    expect(queue.canSmoothFollow()).toBe(false);
    dispose();
  });
});
