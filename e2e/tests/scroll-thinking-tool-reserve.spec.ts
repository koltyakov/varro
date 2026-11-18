import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { AssistantMessage, MessageEntry, ToolPart } from '../../src/webview/types';

const sessionID = 'thinking-tool-reserve';
const created = 1_780_000_000_000;
const intro: AssistantMessage = {
  role: 'assistant',
  id: 'intro',
  parentID: 'prompt',
  sessionID,
  time: { created, completed: created + 100 },
  finish: 'tool-calls',
  providerID: 'openai',
  modelID: 'gpt-5',
  mode: 'build',
  agent: 'build',
  path: { cwd: '/workspace', root: '/workspace' },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
};
const initialMessages = (short: boolean): MessageEntry[] => [
  {
    info: {
      role: 'user',
      id: 'prompt',
      sessionID,
      time: { created },
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5' },
    },
    parts: [
      { type: 'text', id: 'request', sessionID, messageID: 'prompt', text: 'Check the files.' },
    ],
  },
  {
    info: intro,
    parts: [
      {
        type: 'text',
        id: 'prose',
        sessionID,
        messageID: intro.id,
        text: Array.from(
          { length: short ? 3 : 20 },
          (_, i) => `Check ${i + 1}. Inspect the current file before continuing.`
        ).join('\n\n'),
      },
    ],
  },
];

for (const short of [true, false]) {
  test(
    short
      ? 'fractional read previews never create reserve in a fitting transcript'
      : 'the first completed tool adds real history and later compact swaps need no reserve',
    async ({ page }, testInfo) => {
      test.setTimeout(65_000);
      await page.setViewportSize({ width: 500, height: short ? 850 : 570 });
      await page.addInitScript(
        (capture) => {
          // SAFETY: The isolated playback harness reads this fixture before mounting.
          (
            window as typeof window & { varroPlaybackCapture: typeof capture }
          ).varroPlaybackCapture = capture;
        },
        {
          session: {
            id: sessionID,
            projectID: 'test',
            directory: '/workspace',
            title: 'Tool reserve',
            version: '1',
            time: { created, updated: created },
          },
          initialMessages: initialMessages(short),
        }
      );
      await page.goto('/e2e/harness/index.html?scenario=session-playback');
      const marker = page.locator('[data-msg-id="intro"] .rendered-markdown p').last();
      await expect(marker).toBeInViewport();
      const geometry = await marker.evaluate(
        async (paragraph, { base, shortTranscript }) => {
          // SAFETY: Only the isolated playback harness installs this event replay method.
          const { replayServerEvent: send } = (
            window as typeof window & {
              __varroE2E: { replayServerEvent(event: ServerEvent): void };
            }
          ).__varroE2E;
          const list = paragraph.closest<HTMLElement>('.interactive-list')!;
          const sample = () => ({
            top: list.scrollTop,
            marker: paragraph.getBoundingClientRect().top,
            bottom: list.scrollHeight - list.clientHeight,
            reserve:
              list.querySelector('.append-scroll-bottom-reserve')?.getBoundingClientRect().height ??
              0,
            exit:
              list.querySelector('.activity-exit-bottom-reserve')?.getBoundingClientRect().height ??
              0,
            summaries: list.querySelectorAll(
              '.assistant-activity-summary:not(.assistant-activity-summary-placeholder)'
            ).length,
            placeholders: list.querySelectorAll('.assistant-activity-summary-placeholder').length,
            active: list.querySelector<HTMLElement>('.assistant-active-activity-item')?.dataset
              .activityPartId,
            thinking: !!list.querySelector(
              '.interactive-loading-row:not(.is-reserved) .loading-verb'
            ),
          });
          const waitFor = async (
            label: string,
            ready: (frame: ReturnType<typeof sample>) => boolean
          ) => {
            const frames = [];
            const deadline = Date.now() + 6500;
            let stableSince = 0;
            let previous = '';
            do {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              const frame = sample();
              frames.push(frame);
              const key = JSON.stringify(frame);
              if (!ready(frame) || previous !== key) stableSince = 0;
              if (ready(frame)) {
                stableSince ||= performance.now();
                if (performance.now() - stableSince >= 250) return { frames, settled: frame };
              }
              previous = key;
            } while (Date.now() < deadline);
            throw new Error(`${label} did not settle: ${previous}`);
          };
          send({
            type: 'session.status',
            properties: { sessionID: base.sessionID, status: { type: 'busy' } },
          });
          const initial = await waitFor(
            'initial Thinking',
            (f) => f.thinking && (shortTranscript ? f.bottom === 0 : f.top > 0)
          );
          const cycles = [];
          for (const [i, tool] of (shortTranscript
            ? ['bash', 'read', 'grep', 'read', 'grep', 'read']
            : ['read', 'grep', 'grep', 'grep', 'read']
          ).entries()) {
            const id = `tool-${i}`;
            const start = Date.now();
            const info = { ...base, id: `step-${i}`, finish: undefined, time: { created: start } };
            const part: ToolPart = {
              type: 'tool',
              id,
              tool,
              callID: `call-${i}`,
              sessionID: base.sessionID,
              messageID: info.id,
              state: {
                status: 'running',
                input:
                  tool === 'read'
                    ? { filePath: 'source.test.ts', offset: 1, limit: 120 }
                    : tool === 'grep'
                      ? { pattern: 'function', path: 'src' }
                      : { command: 'npm test' },
                time: { start },
              },
            };
            send({ type: 'message.updated', properties: { info } });
            send({ type: 'message.part.updated', properties: { part } });
            const shown = await waitFor(`active ${id}`, (f) => f.active === id && !f.thinking);
            const end = Date.now();
            send({
              type: 'message.part.updated',
              properties: {
                part: {
                  ...part,
                  state: {
                    status: 'completed' as const,
                    input: part.state.input,
                    title: 'Done',
                    output: 'Done',
                    metadata: {},
                    time: { start, end },
                  },
                },
              },
            });
            send({
              type: 'message.updated',
              properties: {
                info: { ...info, finish: 'tool-calls', time: { created: start, completed: end } },
              },
            });
            const hidden = await waitFor(`Thinking after ${id}`, (f) => !f.active && f.thinking);
            cycles.push({ tool, shown, hidden });
          }
          return { cycles, initial: initial.settled };
        },
        { base: intro, shortTranscript: short }
      );
      await testInfo.attach('thinking-tool-geometry', {
        body: JSON.stringify(geometry),
        contentType: 'application/json',
      });
      const checkpoints = geometry.cycles.map(({ tool, shown, hidden }) => ({
        tool,
        shown: shown.settled,
        hidden: hidden.settled,
      }));
      const evidence = JSON.stringify(checkpoints);
      const allFrames = geometry.cycles.flatMap(({ shown, hidden }) => [
        ...shown.frames,
        ...hidden.frames,
      ]);
      expect(
        allFrames.every((f) => f.reserve === 0 && f.exit === 0 && f.placeholders === 0),
        evidence
      ).toBe(true);
      expect(
        geometry.cycles[0]!.shown.frames.every((f) => f.summaries === 0),
        evidence
      ).toBe(true);
      expect(geometry.cycles[0]!.hidden.settled.summaries, evidence).toBe(1);
      if (short) {
        const frames = geometry.cycles.flatMap(({ shown, hidden }) => [
          ...shown.frames,
          ...hidden.frames,
        ]);
        expect(Math.max(...frames.map((f) => f.bottom)), evidence).toBe(0);
        expect(
          Math.max(...frames.map((f) => Math.abs(f.marker - geometry.initial.marker))),
          evidence
        ).toBeLessThanOrEqual(1);
        expect(Math.max(...frames.map((f) => f.reserve)), evidence).toBe(0);
        return;
      }
      const baseline = geometry.cycles[0]!.hidden.settled;
      for (const { shown, hidden } of geometry.cycles.slice(1)) {
        for (const frame of [...shown.frames, ...hidden.frames]) {
          expect(Math.abs(frame.marker - baseline.marker), evidence).toBeLessThanOrEqual(1);
          expect(frame.bottom, evidence).toBe(baseline.bottom);
        }
      }
    }
  );
}
