import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry, ToolPart } from '../../src/webview/types';

for (const virtualized of [false, true]) {
  test(`tool grouping does not reverse an appended step: ${virtualized ? 'measured' : 'short'}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 486, height: 800 });
    const fixtureSessionID = virtualized
      ? 'session-tool-cards-large-transcript'
      : 'session-tool-cards';
    const fixtureMessageID = virtualized
      ? 'message-tool-cards-assistant-69'
      : 'message-tool-cards-assistant';
    await page.goto(
      virtualized
        ? '/e2e/harness/index.html?scenario=tool-cards-large-transcript&activeTray=1&activeTrayIndex=69&activeTrayCount=3'
        : '/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayPrefix=1&activeTrayCompletedPrefix=1&activeTrayCount=3'
    );
    await expect(page.locator('.assistant-active-activity-item')).toHaveCount(1);
    await expect
      .poll(() =>
        page
          .locator('.interactive-list')
          .evaluate((list) => list.scrollHeight - list.clientHeight - list.scrollTop)
      )
      .toBeLessThanOrEqual(1);

    const result = await page.evaluate(
      async ({ sessionID, messageID, measured }) => {
        // SAFETY: The isolated fixture installs typed persistence and production-event replay helpers.
        const harness = (
          window as Window & {
            __varroE2E?: {
              getSessionMessages(id: string): MessageEntry[];
              replayServerEvent(event: ServerEvent): void;
            };
          }
        ).__varroE2E;
        if (!harness) throw new Error('Missing E2E harness');
        const list = document.querySelector<HTMLElement>('.interactive-list');
        const initial = harness
          .getSessionMessages(sessionID)
          .find((entry) => entry.info.id === messageID);
        if (!list || !initial || initial.info.role !== 'assistant')
          throw new Error('Missing tool fixture');
        const running = initial.parts.filter(
          (part): part is ToolPart => part.type === 'tool' && part.state.status === 'running'
        );
        if (running.length !== 3) throw new Error('Expected three overlapping tools');
        const marker = measured
          ? list.querySelector<HTMLElement>(
              '[data-msg-id="message-tool-cards-user-69"] .user-message-card'
            )
          : list.querySelector<HTMLElement>('.assistant-activity-summary');
        if (!marker) throw new Error('Missing stable painted marker');
        const send = (event: ServerEvent) => harness.replayServerEvent(event);
        const complete = (part: ToolPart) => {
          send({
            type: 'message.part.updated',
            properties: {
              part: {
                ...part,
                state: {
                  status: 'completed',
                  input: part.state.input,
                  output: 'Done',
                  title: 'Inspected',
                  metadata: {},
                  time: { start: Date.now() - 1000, end: Date.now() },
                },
              } satisfies ToolPart,
            },
          });
        };
        const errors: string[] = [];
        const onError = (event: ErrorEvent) => errors.push(event.message);
        window.addEventListener('error', onError);
        const samples: Array<{ top: number; scrollTop: number; active: number; reserve: number }> =
          [];
        const start = performance.now();
        let completed = false;
        let appended = false;
        let streamed = false;
        try {
          while (performance.now() - start < 4200) {
            const elapsed = performance.now() - start;
            if (!streamed && elapsed >= 1200) {
              streamed = true;
              send({
                type: 'message.part.updated',
                properties: {
                  part: {
                    id: 'tool-grouping-next-text',
                    sessionID,
                    messageID: 'tool-grouping-next-step',
                    type: 'text',
                    text: 'The next inspection is complete.',
                  },
                },
              });
            }
            if (!completed && elapsed >= 100) {
              completed = true;
              for (const part of running) complete(part);
              send({
                type: 'message.updated',
                properties: {
                  info: {
                    ...initial.info,
                    time: { ...initial.info.time, completed: Date.now() },
                    finish: 'tool-calls',
                  },
                },
              });
            }
            if (!appended && elapsed >= 800) {
              appended = true;
              const info = {
                ...initial.info,
                id: 'tool-grouping-next-step',
                time: { created: Date.now() },
              };
              send({ type: 'message.updated', properties: { info } });
              send({
                type: 'message.part.updated',
                properties: {
                  part: {
                    id: 'tool-grouping-next-search',
                    sessionID,
                    messageID: info.id,
                    type: 'tool',
                    tool: 'grep',
                    callID: 'tool-grouping-next-call',
                    state: {
                      status: 'completed',
                      input: { pattern: 'next-step', path: 'src' },
                      title: 'Search',
                      output: 'Found matching source',
                      metadata: {},
                      time: { start: Date.now() - 1000, end: Date.now() },
                    },
                  },
                },
              });
            }
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            samples.push({
              top: marker.getBoundingClientRect().top,
              scrollTop: list.scrollTop,
              active: list.querySelectorAll('.assistant-active-activity-item').length,
              reserve:
                list.querySelector('.append-scroll-bottom-reserve')?.getBoundingClientRect()
                  .height ?? 0,
            });
          }
          return {
            samples,
            errors,
            connected: marker.isConnected,
          };
        } finally {
          window.removeEventListener('error', onError);
        }
      },
      { sessionID: fixtureSessionID, messageID: fixtureMessageID, measured: virtualized }
    );
    await test.info().attach('tool-grouping-frames', {
      body: JSON.stringify(result),
      contentType: 'application/json',
    });
    expect(result.connected).toBe(true);
    expect(result.samples.length).toBeGreaterThan(100);
    expect(result.samples.at(-1)?.active).toBe(0);
    const reversals = result.samples
      .slice(1)
      .filter((sample, index) => sample.top > result.samples[index]!.top + 0.1);
    expect(reversals, 'An activity owner must not undo a newer append destination').toEqual([]);
    expect(result.errors).toEqual([]);
  });
}
