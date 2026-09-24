import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry } from '../../src/webview/types';

for (const width of [486, 900]) {
  test(`background notices preserve a virtualized live answer at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const row = page.locator('[data-msg-id="message-rapid-assistant-streaming"]');
    await expect(row.locator('.rendered-markdown')).toHaveText('Starting...');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await page.evaluate(() => {
      // SAFETY: The isolated fixture exposes the canonical event transport.
      const harness = (
        window as typeof window & {
          __varroE2E: { replayServerEvent: (event: ServerEvent) => void };
        }
      ).__varroE2E;
      harness.replayServerEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'message-rapid-assistant-streaming-text-1',
            messageID: 'message-rapid-assistant-streaming',
            sessionID: 'session-rapid-streaming-jitter',
            type: 'text',
            text: Array.from(
              { length: 18 },
              (_, index) =>
                `Already visible paragraph ${index}. ${'This content must stay painted while a background command completes. '.repeat(3)}`
            ).join('\n\n'),
          },
        },
      });
    });
    await expect(row.locator('.rendered-markdown p').last()).toContainText(
      'Already visible paragraph 17.'
    );
    await expect
      .poll(() =>
        page
          .locator('.interactive-list')
          .evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop)
      )
      .toBeLessThanOrEqual(2);

    const samples = await page.evaluate(async () => {
      // SAFETY: The isolated fixture exposes the canonical store and event transport.
      const harness = (
        window as typeof window & {
          __varroE2E: {
            replayServerEvent: (event: ServerEvent) => void;
            getSessionMessages: (id: string) => MessageEntry[];
          };
        }
      ).__varroE2E;
      const sessionID = 'session-rapid-streaming-jitter';
      const messages = harness.getSessionMessages(sessionID);
      const user = messages.find((m) => m.info.id === 'message-rapid-user-streaming')!.info;
      const assistant = messages.find(
        (m) => m.info.id === 'message-rapid-assistant-streaming'
      )!.info;
      const marker = [
        ...document.querySelectorAll(
          '[data-msg-id="message-rapid-assistant-streaming"] .rendered-markdown p'
        ),
      ].at(-1)!;
      const list = document.querySelector('.interactive-list')!;
      const result = [];
      for (let frame = 0; frame < 180; frame += 1) {
        const round = Math.floor(frame / 60);
        const noticeID = `background-notice-${round}`;
        if (frame % 60 === 0)
          harness.replayServerEvent({
            type: 'message.updated',
            properties: { info: { ...user, id: noticeID } },
          });
        if (frame % 60 === 1)
          harness.replayServerEvent({
            type: 'message.part.updated',
            properties: {
              part: {
                type: 'text',
                id: `${noticeID}-text`,
                messageID: noticeID,
                sessionID,
                synthetic: true,
                text: '<shell id="background" state="completed">Done</shell>',
              },
            },
          });
        if (frame % 60 === 2)
          harness.replayServerEvent({
            type: 'message.updated',
            properties: { info: { ...assistant, id: `continuation-${round}` } },
          });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const rect = marker.getBoundingClientRect();
        const bounds = list.getBoundingClientRect();
        result.push({
          frame,
          connected: marker.isConnected,
          painted: rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom,
          text: marker.textContent,
          reserve: [
            ...list.querySelectorAll('.append-scroll-bottom-reserve,.activity-exit-bottom-reserve'),
          ].reduce((sum, e) => sum + e.getBoundingClientRect().height, 0),
          mounted: list.querySelectorAll('[data-msg-id]').length,
        });
      }
      return result;
    });
    await writeFile(testInfo.outputPath('frames.json'), JSON.stringify(samples));
    expect(
      samples.every(
        (sample) =>
          sample.connected &&
          sample.painted &&
          sample.text?.startsWith('Already visible paragraph 17.')
      )
    ).toBe(true);
    expect(Math.max(...samples.map((sample) => sample.reserve))).toBeLessThan(200);
    expect(Math.max(...samples.map((sample) => sample.mounted))).toBeLessThan(50);
  });
}
