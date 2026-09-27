import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { AssistantMessage, MessageEntry, ToolPart } from '../../src/webview/types';

for (const width of [480, 1280]) {
  test(`keeps a short streaming transcript free of transient overflow at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 1272 });
    const sessionID = 'short-stream';
    const created = 1_780_000_000_000;
    const info: AssistantMessage = {
      id: 'short-assistant',
      sessionID,
      role: 'assistant',
      parentID: 'short-user',
      time: { created },
      providerID: 'openai',
      modelID: 'gpt-5',
      mode: 'build',
      agent: 'build',
      path: { cwd: '/workspace', root: '/workspace' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const initialMessages: MessageEntry[] = [
      {
        info: {
          id: 'short-user',
          sessionID,
          role: 'user',
          time: { created: created - 1 },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-5' },
        },
        parts: [
          {
            id: 'prompt',
            messageID: 'short-user',
            sessionID,
            type: 'text',
            text: 'Check the scrolling issue.',
          },
        ],
      },
      {
        info,
        parts: [
          {
            id: 'intro',
            messageID: info.id,
            sessionID,
            type: 'text',
            text: 'I will check the scroll anchoring and row measurement code.',
          },
        ],
      },
    ];
    await page.addInitScript(
      (fixture) => {
        // SAFETY: The isolated E2E harness reads this fixture before mounting.
        (window as typeof window & { varroPlaybackCapture: typeof fixture }).varroPlaybackCapture =
          fixture;
      },
      {
        session: {
          id: sessionID,
          projectID: 'test',
          directory: '/workspace',
          title: 'Short stream',
          version: '1.0.0',
          time: { created, updated: created },
        },
        initialMessages,
      }
    );
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    await expect(page.locator('[data-msg-id="short-assistant"] .rendered-markdown')).toBeVisible();
    const samples = await page.evaluate(
      async ({ sessionID: streamSessionID, info: assistant }) => {
        const startedAt = Date.now();
        // SAFETY: This transport belongs to the isolated E2E fixture.
        const harness = (
          window as Window & { __varroE2E?: { replayServerEvent(event: ServerEvent): void } }
        ).__varroE2E!;
        const list = document.querySelector<HTMLElement>('.interactive-list')!;
        const marker = list.querySelector('.user-message-card')!;
        harness.replayServerEvent({
          type: 'session.status',
          properties: { sessionID: streamSessionID, status: { type: 'busy' } },
        });
        const result = [];
        // Repeated exits used to accumulate spacers until they filled this tall viewport.
        // Keep enough cycles to exercise the scrollbar flash, not just the first tool handoff.
        for (let frame = 0; frame < 2500; frame += 1) {
          const cycle = Math.floor(frame / 100);
          const phase = frame % 100;
          const messageID = `streamed-${cycle}`;
          if (phase === 0 && cycle < 24)
            harness.replayServerEvent({
              type: 'message.updated',
              properties: { info: { ...assistant, id: messageID } },
            });
          const part: ToolPart = {
            id: `read-${cycle}`,
            messageID,
            sessionID: streamSessionID,
            type: 'tool',
            tool: 'read',
            callID: `call-${cycle}`,
            state: {
              status: 'running',
              input: { filePath: `/workspace/source-${cycle}.ts` },
              time: { start: startedAt },
            },
          };
          if (phase === 0 && cycle < 24)
            harness.replayServerEvent({ type: 'message.part.updated', properties: { part } });
          if (phase === 30 && cycle < 24)
            harness.replayServerEvent({
              type: 'message.part.updated',
              properties: {
                part: {
                  ...part,
                  state: {
                    status: 'completed' as const,
                    input: part.state.input,
                    title: 'Read source',
                    output: 'contents',
                    metadata: {},
                    time: { start: startedAt, end: startedAt + 100 },
                  },
                },
              },
            });
          if (phase === 85 && cycle % 10 === 0 && cycle < 24)
            harness.replayServerEvent({
              type: 'message.part.updated',
              properties: {
                part: {
                  id: `text-${cycle}`,
                  messageID,
                  sessionID: streamSessionID,
                  type: 'text',
                  text: 'The next file contains the layout measurements.',
                },
              },
            });
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          result.push({
            frame,
            overflow: list.scrollHeight - list.clientHeight,
            pageOverflow:
              document.documentElement.scrollHeight - document.documentElement.clientHeight,
            top: list.scrollTop,
            markerTop: marker.getBoundingClientRect().top,
            reserve:
              list.querySelector<HTMLElement>('.append-scroll-bottom-reserve')?.offsetHeight ?? 0,
            exitReserve:
              list.querySelector<HTMLElement>('.activity-exit-bottom-reserve')?.offsetHeight ?? 0,
            previewIds: [
              ...list.querySelectorAll<HTMLElement>('.assistant-active-activity-item'),
            ].map((item) => item.dataset.activityPartId),
            exiting: !!list.querySelector('.assistant-active-activity-item.is-exiting'),
          });
        }
        return result;
      },
      { sessionID, info }
    );
    expect(new Set(samples.flatMap((sample) => sample.previewIds)).size).toBe(24);
    expect(samples.some((sample) => sample.exiting)).toBe(true);
    expect(samples.filter((sample) => sample.overflow > 0).slice(0, 5)).toEqual([]);
    expect(samples.filter((sample) => sample.pageOverflow > 0).slice(0, 5)).toEqual([]);
    expect(samples.every((sample) => sample.top === 0)).toBe(true);
    expect(
      Math.max(...samples.map((sample) => sample.markerTop)) -
        Math.min(...samples.map((sample) => sample.markerTop))
    ).toBeLessThanOrEqual(1);
  });
}
