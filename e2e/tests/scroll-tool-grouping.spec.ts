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

// Replays of v2 and v1 sessions clamped the bottom-pinned transcript by 1 px whenever a tool
// tray with a fractional height grouped: its row lost a whole-pixel correction under the fixed
// collapse target, but the reserve covered only the fractional tray height.
for (const trayFraction of [0.1, 0.3, 0.6]) {
  test(`tool grouping keeps a fractional row pinned: ${trayFraction}px tray fraction`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 486, height: 800 });
    await page.goto(
      '/e2e/harness/index.html?scenario=tool-cards-large-transcript&activeTray=1&activeTrayIndex=69&activeTrayCount=1'
    );
    // Artificial stress changes only fixture geometry; production trays have fractional heights.
    await page.addStyleTag({
      content: `.assistant-active-activity-tray { padding-bottom: ${trayFraction}px; }`,
    });
    await expect(page.locator('.assistant-active-activity-item')).toHaveCount(1);
    const bottomDistance = () =>
      page
        .locator('.interactive-list')
        .evaluate((list) => list.scrollHeight - list.clientHeight - list.scrollTop);
    await expect.poll(bottomDistance).toBeLessThanOrEqual(1);
    await expect
      .poll(() =>
        page
          .locator('[data-msg-id="message-tool-cards-assistant-69"]')
          .evaluate((row) => row.style.getPropertyValue('--interactive-item-block-correction'))
      )
      .not.toBe('');
    await page.waitForTimeout(300);

    const samples = await page.evaluate(async () => {
      // SAFETY: The isolated fixture installs typed persistence and production-event replay helpers.
      const harness = (
        window as Window & {
          __varroE2E?: {
            getSessionMessages(id: string): MessageEntry[];
            replayServerEvent(event: ServerEvent): void;
          };
        }
      ).__varroE2E;
      const list = document.querySelector<HTMLElement>('.interactive-list');
      const marker = list?.querySelector<HTMLElement>(
        '[data-msg-id="message-tool-cards-user-69"] .user-message-card'
      );
      const initial = harness
        ?.getSessionMessages('session-tool-cards-large-transcript')
        .find((entry) => entry.info.id === 'message-tool-cards-assistant-69');
      if (!harness || !list || !marker || !initial) throw new Error('Missing tool fixture');
      const sample = () => ({
        scrollTop: list.scrollTop,
        top: marker.getBoundingClientRect().top,
        active: list.querySelectorAll('.assistant-active-activity-item').length,
      });
      const result = [sample()];
      for (const part of initial.parts) {
        if (part.type !== 'tool' || part.state.status !== 'running') continue;
        harness.replayServerEvent({
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
      }
      for (let frame = 0; frame < 40; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        result.push(sample());
      }
      return result;
    });
    expect(samples.at(-1)?.active).toBe(0);
    const reversals = samples
      .slice(1)
      .filter((sample, index) => sample.top > samples[index]!.top + 0.1);
    expect(reversals, JSON.stringify(samples.slice(0, 6))).toEqual([]);
  });
}

// Replay of a v2 session: following text grouped the finished tool preview one frame before its
// first paced chunk painted, so Thinking flashed for a single frame between them.
for (const virtualized of [false, true]) {
  test(`following text replaces a tool preview without a Thinking flash: ${virtualized ? 'measured' : 'short'}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 486, height: 800 });
    const sessionID = virtualized ? 'session-tool-cards-large-transcript' : 'session-tool-cards';
    const messageID = virtualized
      ? 'message-tool-cards-assistant-69'
      : 'message-tool-cards-assistant';
    await page.goto(
      virtualized
        ? '/e2e/harness/index.html?scenario=tool-cards-large-transcript&activeTray=1&activeTrayIndex=69&activeTrayCount=1'
        : '/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayPrefix=1&activeTrayCount=1'
    );
    await expect(page.locator('.assistant-active-activity-item')).toHaveCount(1);
    await expect(page.locator('.interactive-loading-row.is-reserved')).toHaveCount(1);
    await page.waitForTimeout(700);

    const samples = await page.evaluate(
      async ({ sessionID, messageID }) => {
        // SAFETY: The isolated fixture installs typed persistence and production-event replay helpers.
        const harness = (
          window as Window & {
            __varroE2E?: {
              getSessionMessages(id: string): MessageEntry[];
              replayServerEvent(event: ServerEvent): void;
            };
          }
        ).__varroE2E;
        const list = document.querySelector<HTMLElement>('.interactive-list');
        const initial = harness
          ?.getSessionMessages(sessionID)
          .find((entry) => entry.info.id === messageID);
        if (!harness || !list || !initial || initial.info.role !== 'assistant')
          throw new Error('Missing tool fixture');
        const tool = initial.parts.find(
          (part): part is ToolPart => part.type === 'tool' && part.state.status === 'running'
        );
        if (!tool) throw new Error('Missing running tool');
        harness.replayServerEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              ...tool,
              state: {
                status: 'completed',
                input: tool.state.input,
                output: 'Done',
                title: 'Inspected',
                metadata: {},
                time: { start: Date.now() - 1000, end: Date.now() },
              },
            } satisfies ToolPart,
          },
        });
        harness.replayServerEvent({
          type: 'message.updated',
          properties: {
            info: {
              ...initial.info,
              time: { ...initial.info.time, completed: Date.now() },
              finish: 'tool-calls',
            },
          },
        });
        const info = {
          ...initial.info,
          id: 'tool-grouping-following-step',
          time: { created: Date.now() },
        };
        harness.replayServerEvent({ type: 'message.updated', properties: { info } });
        harness.replayServerEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'tool-grouping-following-text',
              sessionID,
              messageID: info.id,
              type: 'text',
              text: '',
              time: { start: Date.now() },
            },
          },
        });
        harness.replayServerEvent({
          type: 'message.part.delta',
          properties: {
            sessionID,
            messageID: info.id,
            partID: 'tool-grouping-following-text',
            field: 'text',
            delta: 'The checkout has a pre-existing modification in the installer.',
          },
        });
        const result: Array<{ thinking: boolean; active: number; text: boolean }> = [];
        for (let frame = 0; frame < 30; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          result.push({
            thinking: !!list.querySelector(
              '.interactive-loading-row:not(.is-reserved):not(.trailing-assistant-summary-row) .loading-verb'
            ),
            active: list.querySelectorAll('.assistant-active-activity-item').length,
            text: (
              list.querySelector('[data-msg-id="tool-grouping-following-step"]')?.textContent ?? ''
            ).includes('The checkout'),
          });
        }
        return result;
      },
      { sessionID, messageID }
    );
    expect(samples.at(-1)).toMatchObject({ active: 0, text: true });
    expect(
      samples.flatMap((sample, frame) => (sample.thinking ? [{ frame, ...sample }] : []))
    ).toEqual([]);
  });
}
