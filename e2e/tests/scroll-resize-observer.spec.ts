import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry } from '../../src/webview/types';
import { getScrollMetrics } from './helpers';

for (const scenario of ['mixed-small-transcript', 'large-transcript']) {
  test(`streaming in ${scenario} does not resize boxes during observer delivery`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 456, height: 850 });
    await page.goto(`/e2e/harness/index.html?scenario=${scenario}`);
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThanOrEqual(1);

    const result = await page.evaluate(async (fixtureName) => {
      // SAFETY: The isolated E2E fixture installs these message and replay APIs before rendering.
      const harness = (
        window as Window & {
          __varroE2E?: {
            getSessionMessages(sessionId: string): MessageEntry[];
            replayServerEvent(event: ServerEvent): void;
          };
        }
      ).__varroE2E;
      if (!harness) throw new Error('Missing E2E harness');
      const sessionID = `session-${fixtureName}`;
      const assistant = harness
        .getSessionMessages(sessionID)
        .findLast((m) => m.info.role === 'assistant');
      const element = document.querySelector<HTMLElement>('.interactive-list');
      if (!assistant || !element) throw new Error('Missing transcript fixture');
      const errors: string[] = [];
      const onError = (event: ErrorEvent) => errors.push(event.message);
      window.addEventListener('error', onError);
      const tops: number[] = [];
      let raf = 0;
      const sample = () => {
        tops.push(element.scrollTop);
        raf = requestAnimationFrame(sample);
      };
      raf = requestAnimationFrame(sample);
      const send = (event: ServerEvent) => harness.replayServerEvent(event);
      const info = { ...assistant.info, time: { created: assistant.info.time.created } };
      const partID = 'resize-observer-regression';
      const startHeight = element.scrollHeight;
      try {
        send({ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } });
        send({ type: 'message.updated', properties: { info } });
        send({
          type: 'message.part.updated',
          properties: {
            part: { id: partID, type: 'text', sessionID, messageID: info.id, text: '' },
          },
        });
        for (let index = 0; index < 120; index++) {
          send({
            type: 'message.part.delta',
            properties: {
              sessionID,
              messageID: info.id,
              partID,
              field: 'text',
              delta: `\n\nResize paragraph ${index}: incremental Markdown must follow the growing answer smoothly.`,
            },
          });
          await new Promise((resolve) => setTimeout(resolve, 32));
        }
        send({
          type: 'message.updated',
          properties: { info: { ...info, time: { ...info.time, completed: Date.now() } } },
        });
        send({ type: 'session.status', properties: { sessionID, status: { type: 'idle' } } });
        const deadline = performance.now() + 10_000;
        while (
          !element.textContent?.includes('Resize paragraph 119:') ||
          element.scrollHeight - element.clientHeight - element.scrollTop > 1
        ) {
          if (performance.now() > deadline)
            throw new Error('Streaming did not settle at the bottom');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        return {
          errors,
          growth: element.scrollHeight - startHeight,
          backwards: tops.slice(1).filter((top, index) => top < tops[index]! - 1),
          frames: tops.length,
        };
      } finally {
        cancelAnimationFrame(raf);
        window.removeEventListener('error', onError);
      }
    }, scenario);
    expect(result.errors).toEqual([]);
    expect(result.growth).toBeGreaterThan(1000);
    expect(result.frames).toBeGreaterThan(100);
    expect(result.backwards).toEqual([]);
  });
}
