import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { AssistantMessage, MessageEntry, ToolPart } from '../../src/webview/types';

const sessionID = 'cross-step-reserve';
const created = 1_780_000_000_000;

function assistant(id: string, completed: boolean): AssistantMessage {
  return {
    id,
    sessionID,
    parentID: 'prompt',
    role: 'assistant',
    agent: 'build',
    mode: 'build',
    providerID: 'replay',
    modelID: 'replay',
    path: { root: '/generated', cwd: '/generated' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, ...(completed && { completed: created + 1 }) },
    ...(completed && { finish: 'tool-calls' }),
  };
}

function readTool(messageID: string, id: string, completed: boolean): ToolPart {
  const input = { filePath: `/generated/${id}.ts` };
  return {
    sessionID,
    messageID,
    id,
    type: 'tool',
    tool: 'read',
    callID: `call-${id}`,
    state: completed
      ? {
          status: 'completed',
          input,
          output: 'contents',
          title: 'Read source',
          metadata: {},
          time: { start: created, end: created + 1000 },
        }
      : { status: 'running', input, time: { start: created } },
  };
}

function prose(id: string, text: string): MessageEntry {
  return {
    info: assistant(id, true),
    parts: [{ id: `${id}-text`, sessionID, messageID: id, type: 'text', text }],
  };
}

const initialMessages: MessageEntry[] = [
  {
    info: {
      id: 'prompt',
      role: 'user',
      sessionID,
      agent: 'build',
      model: { providerID: 'replay', modelID: 'replay' },
      time: { created },
    },
    parts: [
      { type: 'text', id: 'prompt-text', messageID: 'prompt', sessionID, text: 'Check the files.' },
    ],
  },
  prose(
    'intro',
    Array.from(
      { length: 9 },
      (_, i) =>
        `Marker ${i + 1}. The transcript should stay in place when a tool uses the available space.`
    ).join('\n\n')
  ),
  { info: assistant('earlier', true), parts: [readTool('earlier', 'early-completed', true)] },
  prose('middle', 'Already painted paragraph between the two activity segments.'),
  { info: assistant('latest', false), parts: [readTool('latest', 'latest-initial', false)] },
];

function toolEvents(messageID: string, id: string, completed: boolean): ServerEvent[] {
  const message: ServerEvent = {
    type: 'message.updated',
    properties: { info: assistant(messageID, completed) },
  };
  const part: ServerEvent = {
    type: 'message.part.updated',
    properties: { part: readTool(messageID, id, completed) },
  };
  return completed ? [part, message] : [message, part];
}

for (const owner of ['earlier', 'latest'] as const) {
  const side = owner === 'earlier' ? 'above' : 'below';
  test(`replacement tool sourced ${side} a retained summary preserves earlier prose`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(45000);
    await page.setViewportSize({ width: 486, height: 760 });
    await page.addInitScript(
      (capture) => {
        // SAFETY: The isolated session-playback harness reads this fixture before mounting.
        (window as typeof window & { varroPlaybackCapture: typeof capture }).varroPlaybackCapture =
          capture;
      },
      {
        session: {
          id: sessionID,
          projectID: 'replay',
          directory: '/generated',
          version: '1',
          title: 'Cross-step reserve',
          time: { created, updated: created },
        },
        initialMessages,
      }
    );
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    const marker = page.locator('[data-msg-id="intro"] .rendered-markdown p').last();
    await expect(marker).toBeInViewport();
    const geometry = await marker.evaluate(
      async (paragraph, fixture) => {
        // SAFETY: Only the isolated session-playback harness exposes this event replay method.
        const { replayServerEvent: send } = (
          window as typeof window & {
            __varroE2E: { replayServerEvent(event: ServerEvent): void };
          }
        ).__varroE2E;
        const list = paragraph.closest<HTMLElement>('.interactive-list')!;
        const sample = () => ({
          marker: paragraph.getBoundingClientRect().top,
          top: list.scrollTop,
          reserve:
            list.querySelector('.append-scroll-bottom-reserve')?.getBoundingClientRect().height ??
            0,
          exit:
            list.querySelector('.activity-exit-bottom-reserve')?.getBoundingClientRect().height ??
            0,
          active: list.querySelector<HTMLElement>('.interactive-loading-row > .status-slot-tool')
            ?.dataset.activityPartId,
          thinking: !!list.querySelector(
            '.interactive-loading-row:not(.is-reserved) .loading-verb'
          ),
        });
        const settle = async (id?: string) => {
          const frames = [];
          let previous = '';
          let stableAt = 0;
          const deadline = performance.now() + 7000;
          do {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const frame = sample();
            frames.push(frame);
            const ready = id
              ? frame.active === id && !frame.thinking
              : !frame.active && frame.thinking;
            const key = JSON.stringify(frame);
            if (!ready || key !== previous) stableAt = 0;
            if (ready) {
              stableAt ||= performance.now();
              if (performance.now() - stableAt >= 600) return { frames, last: frame };
            }
            previous = key;
          } while (performance.now() < deadline);
          throw new Error(`Did not settle ${id ?? 'Thinking'}: ${previous}`);
        };
        send({
          type: 'session.status',
          properties: { sessionID: fixture.sessionID, status: { type: 'busy' } },
        });
        await settle('latest-initial');
        for (const event of fixture.completeLatest) send(event);
        const baseline = (await settle()).last;
        const cycles = [];
        for (const cycle of fixture.cycles) {
          for (const event of cycle.start) send(event);
          const admission = await settle(cycle.id);
          for (const event of cycle.finish) send(event);
          const collapse = await settle();
          cycles.push({ admission, collapse });
        }
        return { baseline, cycles };
      },
      {
        sessionID,
        completeLatest: toolEvents('latest', 'latest-initial', true),
        cycles: Array.from({ length: 2 }, (_, i) => {
          const id = `replacement-${i}`;
          return { id, start: toolEvents(owner, id, false), finish: toolEvents(owner, id, true) };
        }),
      }
    );
    await testInfo.attach('cross-step-frames', {
      body: JSON.stringify(geometry),
      contentType: 'application/json',
    });
    expect(geometry.baseline.top).toBeGreaterThan(0);
    expect(geometry.baseline.reserve + geometry.baseline.exit).toBe(0);
    for (const [index, cycle] of geometry.cycles.entries()) {
      for (const [boundary, { frames }] of Object.entries(cycle)) {
        expect(Math.max(...frames.map((f) => f.reserve + f.exit))).toBe(0);
        const movement = Math.max(
          ...frames.map((f) => Math.abs(f.marker - geometry.baseline.marker))
        );
        expect(
          movement,
          `tool ${index} ${boundary}: preceding paragraph moved`
        ).toBeLessThanOrEqual(1);
      }
    }
  });
}
