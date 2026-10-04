import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry } from '../../src/webview/types';
import { getScrollMetrics, waitForAnimationFrames } from './helpers';

test('remounted Markdown tables have their final column layout at the first row measurement', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 810 });
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');
  const list = page.locator('.interactive-list');
  await expect(list).toBeVisible();
  await expect
    .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
    .toBeLessThanOrEqual(1);

  const observation = await page.evaluateHandle(() => {
    const measure = Element.prototype.getBoundingClientRect;
    const rows = new Map<Element, { compact: boolean; min: number; max: number }>();
    const errors: string[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.message);
    window.addEventListener('error', onError);
    Element.prototype.getBoundingClientRect = function () {
      const rect = measure.call(this);
      const table = this.hasAttribute('data-msg-id') ? this.querySelector('table') : null;
      if (this.isConnected && table) {
        const compact = table.classList.contains('table-first-col-compact');
        const previous = rows.get(this);
        rows.set(this, {
          compact: compact && (previous?.compact ?? true),
          min: Math.min(previous?.min ?? rect.height, rect.height),
          max: Math.max(previous?.max ?? rect.height, rect.height),
        });
      }
      return rect;
    };
    return {
      rows,
      errors,
      stop: () => {
        Element.prototype.getBoundingClientRect = measure;
        window.removeEventListener('error', onError);
      },
    };
  });
  await page.evaluate(() => {
    // SAFETY: The isolated harness owns these history and event APIs.
    const harness = (
      window as Window & {
        __varroE2E?: {
          getSessionMessages(sessionId: string): MessageEntry[];
          replayServerEvent(event: ServerEvent): void;
        };
      }
    ).__varroE2E;
    if (!harness) throw new Error('Missing E2E harness');
    const sessionID = 'session-large-transcript';
    const text = [
      '## Table measurement regression',
      '',
      '| # | Stage | Description |',
      '| --- | --- | --- |',
      ...Array.from(
        { length: 4 },
        (_, index) =>
          `| ${index + 1} | Stage ${index + 1} | ${'The description needs room to wrap beside the compact stage number. '.repeat(3)} |`
      ),
    ].join('\n');
    for (const index of [228, 229, 230]) {
      const message = harness
        .getSessionMessages(sessionID)
        .find((entry) => entry.info.id === `message-large-assistant-${index}`)!;
      const part = message.parts.find((candidate) => candidate.type === 'text')!;
      harness.replayServerEvent({
        type: 'message.part.updated',
        properties: { part: { ...part, type: 'text', text } },
      });
    }
  });
  await list.hover();
  for (const delta of [-420, -420, -420, -420, -420, 420, 420, 420, 420, 420, -420, -420]) {
    await page.mouse.wheel(0, delta);
    await waitForAnimationFrames(page, 4);
  }
  await waitForAnimationFrames(page, 8);
  const result = await observation.evaluate((state) => {
    state.stop();
    return { rows: [...state.rows.values()], errors: state.errors };
  });
  expect(result.rows.length).toBeGreaterThanOrEqual(3);
  expect(
    result.rows.every((row) => row.compact),
    JSON.stringify(result.rows)
  ).toBe(true);
  expect(
    result.rows.every((row) => row.max - row.min <= 1),
    JSON.stringify(result.rows)
  ).toBe(true);
  expect(result.errors).toEqual([]);
});

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
