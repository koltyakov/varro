import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry } from '../../src/webview/types';
import { getScrollMetrics, waitForAnimationFrames } from './helpers';

// Headless Chromium hides native scrollbars by default, making thumb drags inert.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

for (const phase of ['exiting', 'retained', 'held-pointer'] as const) {
  test(`scrollbar dragging releases the ${phase} activity-collapse anchor`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 504, height: 800 });
    await page.goto(
      '/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayPrefix=1&activeTrayCompletedPrefix=1&activeTrayCount=2'
    );
    const list = page.locator('.interactive-list');
    const items = page.locator('.assistant-active-activity-item');
    await expect(items).toHaveCount(2);
    await page.waitForTimeout(2_100);
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThanOrEqual(1);
    const pauseExit =
      phase === 'exiting'
        ? await page.addStyleTag({
            content:
              '.assistant-active-activity-item.is-exiting { animation-play-state: paused !important; }',
          })
        : null;
    await page.evaluate(() => {
      // SAFETY: The isolated fixture installs this typed message store and event transport.
      const harness = (
        window as typeof window & {
          __varroE2E: {
            getSessionMessages(id: string): MessageEntry[];
            replayServerEvent(event: ServerEvent): void;
          };
        }
      ).__varroE2E;
      for (const part of harness.getSessionMessages('session-tool-cards').flatMap((m) => m.parts)) {
        if (part.type !== 'tool' || part.state.status !== 'running') continue;
        harness.replayServerEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              ...part,
              state: {
                ...part.state,
                status: 'completed' as const,
                title: 'Read source',
                output: 'Done',
                metadata: {},
                time: { start: Date.now() - 3_000, end: Date.now() },
              },
            },
          },
        });
      }
    });
    if (phase === 'exiting') {
      await expect(page.locator('.assistant-active-activity-item.is-exiting')).toHaveCount(2);
    } else {
      await expect(items).toHaveCount(0);
      await expect(page.locator('.append-scroll-bottom-reserve')).toBeVisible();
      await waitForAnimationFrames(page, 40);
    }

    const thumb = await list.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const height = element.clientHeight;
      const thumbHeight = Math.max(18, (height * height) / element.scrollHeight);
      const travel = height - thumbHeight;
      return {
        x: rect.right - 3,
        y:
          rect.top +
          (element.scrollTop / (element.scrollHeight - height)) * travel +
          thumbHeight / 2,
        top: element.scrollTop,
      };
    });
    await page.mouse.move(thumb.x, thumb.y);
    await page.mouse.down();
    // Pointer ownership must survive the short keyboard/input-intent timeout.
    if (phase === 'held-pointer') await page.waitForTimeout(650);
    await page.mouse.move(thumb.x, thumb.y - 100, { steps: 12 });
    // Custom Chromium scrollbars deliver the final drag movement on the next frame.
    await waitForAnimationFrames(page, 2);
    await page.mouse.up();
    await pauseExit?.evaluate((element) => element.parentNode?.removeChild(element));

    const samples = await list.evaluate(async (element) => {
      const summary = element.querySelector('.assistant-activity-summary');
      if (!summary) throw new Error('Missing retained activity summary');
      const frames = [];
      for (let frame = 0; frame < 60; frame++) {
        frames.push({ top: element.scrollTop, summaryTop: summary.getBoundingClientRect().top });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return frames;
    });
    await testInfo.attach('scrollbar-frames', {
      body: JSON.stringify({ thumb, samples }),
      contentType: 'application/json',
    });
    expect(samples[0]!.top).toBeLessThan(thumb.top - 100);
    expect(
      Math.max(...samples.map((sample) => Math.abs(sample.summaryTop - samples[0]!.summaryTop)))
    ).toBeLessThanOrEqual(1);
    await expect(items).toHaveCount(0);

    const appendText = (paragraphs: number) =>
      page.evaluate((count) => {
        // SAFETY: The isolated fixture owns this event transport; no recorded tools execute.
        const harness = (
          window as typeof window & {
            __varroE2E: { replayServerEvent(event: ServerEvent): void };
          }
        ).__varroE2E;
        harness.replayServerEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'scrollbar-continuation',
              sessionID: 'session-tool-cards',
              messageID: 'message-tool-cards-assistant',
              type: 'text',
              text: Array.from(
                { length: count },
                (_, index) => `Continuation paragraph ${index}.`
              ).join('\n\n'),
            },
          },
        });
      }, paragraphs);
    await appendText(20);
    await expect(list).toContainText('Continuation paragraph 19.');
    const summaryTop = await list
      .locator('.assistant-activity-summary')
      .first()
      .evaluate((element) => element.getBoundingClientRect().top);
    expect(Math.abs(summaryTop - samples[0]!.summaryTop)).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).click();
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThanOrEqual(1);
    await appendText(30);
    await expect(list).toContainText('Continuation paragraph 29.');
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThanOrEqual(1);
  });
}
