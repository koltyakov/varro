import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComputed, createRoot } from 'solid-js';
import type { TextPart } from '../../types';
import { StreamingPresentation } from './streaming-presentation';
import type { PresentationItem } from './streaming-presentation';

function text(value: string, id = 'text'): PresentationItem {
  return { key: `message\u0000${id}`, partId: id, kind: 'text', text: value };
}
function activity(
  id: string,
  running = false,
  durationMs?: number
): Extract<PresentationItem, { kind: 'activity' }> {
  return {
    key: `message\u0000${id}`,
    partId: id,
    kind: 'activity',
    running,
    active: true,
    expanded: false,
    // Default to reasoning's animated lifecycle; tool-specific cases disable it.
    animateExit: true,
    durationMs,
  };
}
function part(id = 'text'): TextPart {
  return { id, sessionID: 'session', messageID: 'message', type: 'text', text: '' };
}

function tool(id: string, running = true, startedAt = Date.now()) {
  return { ...activity(id, running), animateExit: false, startedAt };
}

describe('StreamingPresentation', () => {
  let queue: StreamingPresentation;
  const exits = new Map<string, () => void>();
  const beforeGroup = vi.fn();
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
    beforeGroup.mockClear();
    beforeLastExit.mockClear();
    queue = new StreamingPresentation({
      beforeExit: vi.fn(),
      beforeGroup,
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

  it('keeps only one running tool visible and admits queued tools after an exit', async () => {
    update([]);
    update([activity('one', true), activity('two', true), activity('three', true)]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect([...queue.visibleActivity()]).toEqual(['message\u0000one']);
    expect([...queue.hiddenParts()]).toEqual(['message\u0000two', 'message\u0000three']);
    expect(vi.getTimerCount()).toBe(0);

    update([activity('one'), activity('two', true), activity('three', true)]);
    expect([...queue.exitingActivity()]).toEqual(['message\u0000one']);
    expect(queue.hiddenParts().has('message\u0000three')).toBe(true);
    exits.get('message\u0000one')!();
    expect([...queue.visibleActivity()]).toEqual(['message\u0000two']);
  });

  it('groups tool previews without an exit animation and immediately frees the slot', async () => {
    update([]);
    const tools = [
      { ...activity('one', false, 1_000), animateExit: false },
      { ...activity('two', true), animateExit: false },
    ];
    update(tools);
    await vi.advanceTimersByTimeAsync(1_299);
    expect([...queue.retainedActivity()]).toEqual(['message\u0000one']);
    expect([...queue.hiddenParts()]).toEqual(['message\u0000two']);
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.retainedActivity().size).toBe(0);
    expect(queue.exitingActivity().size).toBe(0);
    expect([...queue.visibleActivity()]).toEqual(['message\u0000two']);
    expect(beforeGroup).toHaveBeenLastCalledWith(new Set(['message\u0000one']));
    expect(exits.size).toBe(0);
    expect(beforeLastExit).not.toHaveBeenCalled();
  });

  it('finishes the final tool preview without an animation or cleanup timer', async () => {
    update([]);
    update([{ ...activity('one'), animateExit: false }]);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(queue.retainedActivity().size).toBe(0);
    expect(queue.exitingActivity().size).toBe(0);
    expect(queue.pending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(beforeGroup).toHaveBeenLastCalledWith(new Set(['message\u0000one']));
    expect(exits.size).toBe(0);
  });

  it('keeps an inspected tool open and groups it immediately when closed', async () => {
    update([]);
    const preview = { ...activity('one'), animateExit: false };
    update([preview]);
    await vi.advanceTimersByTimeAsync(100);
    queue.inspectActivity(preview.key, true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect([...queue.retainedActivity()]).toEqual([preview.key]);
    queue.inspectActivity(preview.key, false);
    expect(queue.retainedActivity().size).toBe(0);
    expect(queue.exitingActivity().size).toBe(0);
    expect(beforeGroup).toHaveBeenLastCalledWith(new Set([preview.key]));
    expect(exits.size).toBe(0);
  });

  it('rotates long-running tools through queued previews in alternating one-second slots', async () => {
    update([]);
    const tools = [tool('long'), tool('two'), tool('three')];
    update(tools);
    await vi.advanceTimersByTimeAsync(2_999);
    expect([...queue.visibleActivity()]).toEqual([tools[0]!.key]);
    await vi.advanceTimersByTimeAsync(1);
    expect([...queue.visibleActivity()]).toEqual([tools[1]!.key]);
    expect([...queue.hiddenParts()]).toEqual([tools[0]!.key, tools[2]!.key]);
    for (const expected of [tools[0]!, tools[2]!, tools[0]!, tools[1]!]) {
      await vi.advanceTimersByTimeAsync(999);
      expect(queue.visibleActivity().has(expected.key)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect([...queue.visibleActivity()]).toEqual([expected.key]);
      expect(queue.exitingActivity().size).toBe(0);
    }
    expect(exits.size).toBe(0);
  });

  it('gives a queued completed tool one second before grouping it and returning to the long tool', async () => {
    update([]);
    const long = tool('long');
    const completed = { ...tool('completed', false), durationMs: 800 };
    const short = { ...tool('short', false), durationMs: 499 };
    update([long, short, completed]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect([...queue.retainedActivity()]).toEqual([completed.key]);
    expect([...queue.hiddenParts()]).toEqual([long.key]);
    await vi.advanceTimersByTimeAsync(999);
    expect([...queue.retainedActivity()]).toEqual([completed.key]);
    await vi.advanceTimersByTimeAsync(1);
    expect([...queue.visibleActivity()]).toEqual([long.key]);
    expect(queue.retainedActivity().size).toBe(0);
    expect(queue.exitingActivity().size).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect([...queue.visibleActivity()]).toEqual([long.key]);
    expect(queue.pending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not rotate an inspected tool and resumes rotation when it closes', async () => {
    update([]);
    const tools = [tool('long'), tool('two')];
    update(tools);
    await vi.advanceTimersByTimeAsync(100);
    queue.inspectActivity(tools[0]!.key, true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect([...queue.visibleActivity()]).toEqual([tools[0]!.key]);
    expect(vi.getTimerCount()).toBe(0);
    queue.inspectActivity(tools[0]!.key, false);
    expect([...queue.visibleActivity()]).toEqual([tools[1]!.key]);
    queue.inspectActivity(tools[1]!.key, true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect([...queue.visibleActivity()]).toEqual([tools[1]!.key]);
    queue.inspectActivity(tools[1]!.key, false);
    expect([...queue.visibleActivity()]).toEqual([tools[0]!.key]);
  });

  it('groups a hidden long tool when it completes without interrupting the current one-second preview', async () => {
    update([]);
    const long = tool('long');
    const two = tool('two');
    const three = tool('three');
    update([long, two, three]);
    await vi.advanceTimersByTimeAsync(3_500);
    update([{ ...long, running: false, durationMs: 3_500 }, two, three]);
    expect([...queue.visibleActivity()]).toEqual([two.key]);
    expect(queue.hiddenParts().has(long.key)).toBe(false);
    await vi.advanceTimersByTimeAsync(499);
    expect([...queue.visibleActivity()]).toEqual([two.key]);
    await vi.advanceTimersByTimeAsync(1);
    expect([...queue.visibleActivity()]).toEqual([three.key]);
  });

  it('starts rotation for an already-long tool when a queued tool arrives and cancels it on reset', async () => {
    update([]);
    const long = tool('long');
    update([long]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.getTimerCount()).toBe(0);
    update([long, tool('two')]);
    await vi.advanceTimersByTimeAsync(99);
    expect([...queue.visibleActivity()]).toEqual([long.key]);
    await vi.advanceTimersByTimeAsync(1);
    expect([...queue.visibleActivity()]).toEqual(['message\u0000two']);
    queue.reset();
    expect(vi.getTimerCount()).toBe(0);
    expect(queue.visibleActivity().size).toBe(0);
    expect(queue.hiddenParts().size).toBe(0);
  });

  it('uses known execution time to rotate a hydrated long tool without waiting three more seconds', async () => {
    const now = Date.now();
    const tools = [tool('long', true, now - 10_000), tool('two', true, now)];
    update(tools);
    await vi.advanceTimersByTimeAsync(1_099);
    expect([...queue.visibleActivity()]).toEqual([tools[0]!.key]);
    await vi.advanceTimersByTimeAsync(1);
    expect([...queue.visibleActivity()]).toEqual([tools[1]!.key]);
  });

  it('counts each rotation slot from the painted frame and ignores stale paint callbacks', async () => {
    const paints: Array<() => void> = [];
    queue.dispose();
    queue = new StreamingPresentation({
      beforeExit: vi.fn(),
      beforeGroup,
      beforeLastExit,
      afterExit: vi.fn(),
      afterShow: (painted) => paints.push(painted),
    });
    update([]);
    const tools = [tool('long'), tool('two')];
    update(tools);
    await vi.advanceTimersByTimeAsync(100);
    paints.shift()!();
    await vi.advanceTimersByTimeAsync(2_900);
    expect([...queue.visibleActivity()]).toEqual([tools[1]!.key]);
    await vi.advanceTimersByTimeAsync(200);
    const painted = paints.shift()!;
    painted();
    await vi.advanceTimersByTimeAsync(999);
    expect([...queue.visibleActivity()]).toEqual([tools[1]!.key]);
    await vi.advanceTimersByTimeAsync(1);
    expect([...queue.visibleActivity()]).toEqual([tools[0]!.key]);
    queue.flush();
    painted();
    paints.shift()!();
    expect(queue.visibleActivity().size).toBe(0);
    expect(queue.hiddenParts().size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['text', 'instant'] as const)(
    'groups completed previews and queued tools immediately when %s arrives',
    async (kind) => {
      update([]);
      const tools = [activity('one'), activity('two'), activity('three')];
      update(tools);
      await vi.advanceTimersByTimeAsync(220);
      expect(queue.retainedActivity().size).toBe(1);
      expect(queue.hiddenParts().has('message\u0000three')).toBe(true);

      update([
        ...tools,
        kind === 'text' ? text('Ready') : { key: 'edit', partId: 'edit', kind: 'instant' },
      ]);
      expect(queue.retainedActivity().size).toBe(0);
      expect(queue.exitingActivity().size).toBe(0);
      expect(queue.hiddenParts().size).toBe(0);
      expect(beforeGroup).toHaveBeenLastCalledWith(new Set(tools.map((item) => item.key)));
      await vi.advanceTimersByTimeAsync(32);
      if (kind === 'text') expect(queue.textForPart(part())).toBe('Ready');
      expect(queue.pending()).toBe(false);
    }
  );

  it.each([
    { running: true, durationMs: undefined },
    { running: false, durationMs: 500 },
    { running: false, durationMs: 1_000 },
  ])('skips queued short tools in favor of $running/$durationMs activity', async (alternative) => {
    update([]);
    const tools = [
      activity('short', false, 499),
      activity('preferred', alternative.running, alternative.durationMs),
      activity('instant', false, 0),
    ];
    update(tools);
    expect([...queue.hiddenParts()]).toEqual(['message\u0000preferred']);
    expect(beforeGroup).toHaveBeenLastCalledWith(
      new Set(['message\u0000short', 'message\u0000instant'])
    );
    await vi.advanceTimersByTimeAsync(100);
    expect([...queue.visibleActivity(), ...queue.retainedActivity()]).toEqual([
      'message\u0000preferred',
    ]);
    update(
      tools.map((item) => (item.partId === 'preferred' ? activity('preferred', false, 700) : item))
    );
    await vi.runAllTimersAsync();
    expect(queue.hiddenParts().size).toBe(0);
    expect(queue.pending()).toBe(false);
    expect(beforeGroup).toHaveBeenCalledTimes(1);
  });

  it('preserves short previews when no longer or running activity is available', async () => {
    update([]);
    update([activity('one', false, 20), activity('two', false, 499)]);
    await vi.advanceTimersByTimeAsync(100);
    expect([...queue.retainedActivity()]).toEqual(['message\u0000one']);
    expect([...queue.hiddenParts()]).toEqual(['message\u0000two']);
    expect(beforeGroup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_200);
    exits.get('message\u0000one')!();
    expect([...queue.retainedActivity()]).toEqual(['message\u0000two']);
  });

  it('does not guess unknown durations or use grouped history to skip short previews', async () => {
    update([activity('history', false, 1_000)]);
    update([activity('history', false, 1_000), activity('short', false, 100), activity('unknown')]);
    await vi.advanceTimersByTimeAsync(100);
    expect([...queue.retainedActivity()]).toEqual(['message\u0000short']);
    expect([...queue.hiddenParts()]).toEqual(['message\u0000unknown']);
    update([
      activity('history', false, 1_000),
      activity('short', false, 100),
      activity('running', true),
    ]);
    expect([...queue.retainedActivity()]).toEqual(['message\u0000short']);
  });

  it('skips a queued tool once its short duration becomes known', async () => {
    update([]);
    update([activity('one', true), activity('two', true), activity('three', true)]);
    await vi.advanceTimersByTimeAsync(100);
    update([activity('one', true), activity('two', false, 100), activity('three', true)]);
    expect([...queue.visibleActivity()]).toEqual(['message\u0000one']);
    expect([...queue.hiddenParts()]).toEqual(['message\u0000three']);
    expect(beforeGroup).toHaveBeenLastCalledWith(new Set(['message\u0000two']));
    update([activity('one'), activity('two', false, 100), activity('three', true), text('Ready')]);
    await vi.advanceTimersByTimeAsync(120);
    expect([...queue.visibleActivity()]).toEqual(['message\u0000three']);
  });

  it('releases text past running tools and groups them as soon as they complete', async () => {
    update([]);
    const tools = [activity('one', true), activity('two', true), activity('three', true)];
    update(tools);
    await vi.advanceTimersByTimeAsync(220);
    update([...tools, text('Ready')]);
    await vi.advanceTimersByTimeAsync(32);
    expect(queue.textForPart(part())).toBe('Ready');
    expect(queue.visibleActivity().size).toBe(1);
    update([activity('one'), activity('two'), activity('three'), text('Ready')]);
    expect(queue.visibleActivity().size).toBe(0);
    expect(queue.hiddenParts().size).toBe(0);
    expect(queue.pending()).toBe(false);
  });

  it('keeps promoted tools queued when the tray slot is occupied', async () => {
    update([]);
    const tools = [activity('one', true), activity('two', true), activity('three', true)];
    update(tools);
    await vi.advanceTimersByTimeAsync(220);
    queue.showActivity('message\u0000three');
    expect(queue.visibleActivity().size).toBe(1);
    expect(queue.hiddenParts().has('message\u0000three')).toBe(true);
    update([activity('one'), activity('two', true), tools[2]!, text('Continuing')]);
    expect([...queue.visibleActivity()]).toEqual(['message\u0000two']);
    expect(queue.hiddenParts().has('message\u0000three')).toBe(true);
  });

  it('limits hydrated running tools to one slot', async () => {
    update([activity('one', true), activity('two', true), activity('three', true)]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(queue.visibleActivity().size).toBe(1);
    expect([...queue.hiddenParts()]).toEqual(['message\u0000two', 'message\u0000three']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores empty text boundaries and preserves a new activity group after text', async () => {
    update([]);
    update([activity('one'), text('')]);
    await vi.advanceTimersByTimeAsync(100);
    expect(queue.retainedActivity().has('message\u0000one')).toBe(true);
    update([activity('one'), text('Ready'), activity('two')]);
    expect(queue.retainedActivity().size).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect([...queue.retainedActivity()]).toEqual(['message\u0000two']);
    expect(queue.textForPart(part())).toBe('Ready');
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

  it('admits a large completed burst one at a time and drains the remaining previews', async () => {
    update([]);
    const tools = Array.from({ length: 32 }, (_, index) => activity(`tool-${index}`));
    update(tools);
    await vi.advanceTimersByTimeAsync(100);
    expect([...queue.retainedActivity()]).toEqual(['message\u0000tool-0']);
    await vi.advanceTimersByTimeAsync(100);
    expect(queue.retainedActivity().size).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect([...queue.retainedActivity()]).toEqual(['message\u0000tool-0']);
    await vi.advanceTimersByTimeAsync(1_080);
    expect(queue.exitingActivity().size).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect([...queue.retainedActivity()]).toEqual(['message\u0000tool-1']);
    expect(queue.hiddenParts().size).toBe(30);
    await vi.runAllTimersAsync();
    expect(queue.hiddenParts().size).toBe(0);
    expect(queue.pending()).toBe(false);
  });

  it('collects parallel fast tools and waits for the actual exit without following content', async () => {
    update([]);
    update([activity('one'), activity('two')]);
    expect(queue.hiddenParts().size).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    expect([...queue.retainedActivity()]).toEqual(['message\u0000one']);
    await vi.advanceTimersByTimeAsync(120);
    expect([...queue.retainedActivity()]).toEqual(['message\u0000one']);
    await vi.advanceTimersByTimeAsync(1_080);
    expect(queue.exitingActivity().size).toBe(1);
    await vi.advanceTimersByTimeAsync(420);
    expect(queue.exitingActivity().size).toBe(1);
    exits.get('message\u0000one')!();
    expect(beforeLastExit).toHaveBeenCalledTimes(1);
    expect([...queue.retainedActivity()]).toEqual(['message\u0000two']);
    await vi.advanceTimersByTimeAsync(600);
    exits.get('message\u0000two')!();
    expect(beforeLastExit).toHaveBeenCalledTimes(2);
    update([activity('one'), activity('two'), text('Answer follows the preview.')]);
    await vi.advanceTimersByTimeAsync(300);
    expect(queue.textForPart(part())).toBe('Answer follows the preview.');
    expect(queue.pending()).toBe(false);
  });

  it('does not restart a burst deadline when another completed tool joins it', async () => {
    update([]);
    update([activity('one')]);
    await vi.advanceTimersByTimeAsync(1_000);
    update([activity('one'), activity('two')]);
    await vi.advanceTimersByTimeAsync(300);
    expect([...queue.exitingActivity()]).toEqual(['message\u0000one']);
    expect(queue.hiddenParts().has('message\u0000two')).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    expect([...queue.retainedActivity()]).toEqual(['message\u0000two']);
    await vi.advanceTimersByTimeAsync(700);
    expect([...queue.exitingActivity()]).toEqual(['message\u0000two']);
    await vi.advanceTimersByTimeAsync(700);
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

  it('keeps the single slot occupied after its painted-frame callback', async () => {
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
    expect(queue.visibleActivity().size).toBe(1);
    expect(paints).toHaveLength(1);
    queue.flush();
    paints[0]!();
    expect(queue.pending()).toBe(false);
    expect(queue.visibleActivity().size).toBe(0);
  });

  it('keeps an inspected completed tool open and releases the answer gate', async () => {
    update([]);
    update([activity('one')]);
    await vi.advanceTimersByTimeAsync(100);
    queue.inspectActivity('message\u0000one', true);
    update([activity('one'), text('Ready to read')]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(queue.retainedActivity().has('message\u0000one')).toBe(true);
    expect(queue.textForPart(part())).toBe('Ready to read');
    expect(queue.pending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    queue.inspectActivity('message\u0000one', false);
    expect(queue.retainedActivity().size).toBe(0);
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
    update([activity('one')]);
    await vi.advanceTimersByTimeAsync(1_300);
    const staleExit = exits.get('message\u0000one')!;
    update([activity('one'), text('Queued answer')]);
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
