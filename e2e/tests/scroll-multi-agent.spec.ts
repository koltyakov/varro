/* oxlint-disable anti-slop/no-unknown-parameters -- Browser callbacks intercept synthetic message-part updates whose payload is intentionally opaque until forwarded. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Assertions access message hooks installed by the controlled E2E harness. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  getScrollMetrics,
  getVisibleMessageAnchor,
  sampleMessageTopAcrossFrames,
  waitForAnimationFrame,
  waitForAnimationFrames,
} from './helpers';
import {
  appendDeltaToMultiAgentLargeStreaming,
  appendDeltaToMultiAgentStreaming,
} from './scroll-helpers';

async function appendRunningToolPart(page: Page, index: number) {
  await page.evaluate((toolIndex) => {
    const part = {
      id: `message-mla-assistant-streaming-tool-${toolIndex}`,
      sessionID: 'session-multi-agent-large-streaming',
      messageID: 'message-mla-assistant-streaming',
      type: 'tool' as const,
      callID: `message-mla-assistant-streaming-tool-${toolIndex}-call`,
      tool: toolIndex % 2 === 0 ? 'bash' : 'grep',
      state: {
        status: 'running' as const,
        input:
          toolIndex % 2 === 0
            ? { command: `npm run check-${toolIndex}` }
            : { pattern: `stream-${toolIndex}`, path: 'src' },
        title: toolIndex % 2 === 0 ? `npm run check-${toolIndex}` : `Search: stream-${toolIndex}`,
        metadata: {},
        time: { start: Date.now() },
      },
    };
    const harnessWindow = window as typeof window & {
      __varroE2E?: { updateMessagePart?: (updatedPart: unknown) => void };
    };
    harnessWindow.__varroE2E?.updateMessagePart?.(part);
    window.postMessage(
      {
        type: 'server/event',
        payload: { type: 'message.part.updated', properties: { part } },
      },
      '*'
    );
  }, index);
}

async function completeRunningToolPart(page: Page, index: number) {
  await page.evaluate((toolIndex) => {
    const part = {
      id: `message-mla-assistant-streaming-tool-${toolIndex}`,
      sessionID: 'session-multi-agent-large-streaming',
      messageID: 'message-mla-assistant-streaming',
      type: 'tool' as const,
      callID: `message-mla-assistant-streaming-tool-${toolIndex}-call`,
      tool: toolIndex % 2 === 0 ? 'bash' : 'grep',
      state: {
        status: 'completed' as const,
        input:
          toolIndex % 2 === 0
            ? { command: `npm run check-${toolIndex}` }
            : { pattern: `stream-${toolIndex}`, path: 'src' },
        output: 'Completed successfully',
        title: toolIndex % 2 === 0 ? `npm run check-${toolIndex}` : `Search: stream-${toolIndex}`,
        metadata: {},
        time: { start: Date.now() - 1_000, end: Date.now() },
      },
    };
    const harnessWindow = window as typeof window & {
      __varroE2E?: { updateMessagePart?: (updatedPart: unknown) => void };
    };
    harnessWindow.__varroE2E?.updateMessagePart?.(part);
    window.postMessage(
      {
        type: 'server/event',
        payload: { type: 'message.part.updated', properties: { part } },
      },
      '*'
    );
  }, index);
}

test.describe('multi-agent scroll stability', () => {
  test('keeps bottom follow engaged with multiple completed agent responses', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    for (let i = 0; i < 20; i += 1) {
      await appendDeltaToMultiAgentStreaming(
        page,
        `\n\nMulti-agent streaming chunk ${i}: ${`Streaming into a chat with multiple completed agent turns. This exercises the scroll anchoring logic. `.repeat(4)}`
      );
      await waitForAnimationFrames(page, 2);
      await expect
        .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
        .toBeLessThan(15);
    }
  });

  test('keeps bottom follow engaged during multi-agent streaming', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    for (let i = 0; i < 15; i += 1) {
      await appendDeltaToMultiAgentStreaming(
        page,
        `\n\nBottom-follow chunk ${i}: ${'Verify the transcript remains pinned during streaming. '.repeat(6)}`
      );
      await waitForAnimationFrames(page, 2);
      await expect
        .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
        .toBeLessThan(15);
    }

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });
});

test.describe('multi-agent large virtualized scroll stability', () => {
  test('no jitter when scrolling upward through large multi-agent transcript', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-large-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    for (let index = 0; index < 40; index += 1) {
      const before = await getVisibleMessageAnchor(list);
      if (before.scrollTop < 200) break;

      await page.mouse.wheel(0, -200);
      const samples = await sampleMessageTopAcrossFrames(list, before.id, 4);
      expect(
        samples.every((top) => top !== null),
        JSON.stringify({ index, before, samples })
      ).toBe(true);
      const settledTop = samples.at(-1)!;
      expect(Math.abs(settledTop! - before.top - 200), `wheel step ${index}`).toBeLessThan(4);
      for (const top of samples.slice(1)) {
        expect(Math.abs(top! - settledTop!), `settling step ${index}`).toBeLessThan(1.5);
      }
    }
  });

  test('reaches both scroll boundaries in a multi-agent transcript', async ({ page }) => {
    // This is boundary/range coverage, not a visible-jump oracle.
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-large-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 4);

    const topScrollTop = await list.evaluate((element) => element.scrollTop);
    expect(topScrollTop).toBeLessThan(50);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight - element.clientHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 5);

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom), {
        timeout: 8000,
      })
      .toBeLessThan(80);
  });

  test('keeps bottom follow engaged in a large multi-agent transcript', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-large-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    for (let i = 0; i < 25; i += 1) {
      const size =
        i % 3 === 0
          ? 'Short chunk.'
          : `Longer streaming chunk with varied content. ${'This exercises scroll anchoring with multiple agent responses above. '.repeat(4 + (i % 6))}`;
      await appendDeltaToMultiAgentLargeStreaming(
        page,
        `\n\nMulti-agent large chunk ${i}: ${size}`
      );
      await waitForAnimationFrames(page, 2);
      await expect
        .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
        .toBeLessThan(15);
    }

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('keeps following a rapid tool burst while the transcript is unfocused', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-large-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const composer = page.locator('[contenteditable="true"]');
    await composer.focus();
    await expect(composer).toBeFocused();

    await page.evaluate(() => {
      const harnessWindow = window as typeof window & {
        __varroE2E?: { updateMessagePart?: (updatedPart: unknown) => void };
      };
      for (let index = 0; index < 40; index += 1) {
        const part = {
          id: `message-mla-assistant-streaming-burst-tool-${index}`,
          sessionID: 'session-multi-agent-large-streaming',
          messageID: 'message-mla-assistant-streaming',
          type: 'tool' as const,
          callID: `message-mla-assistant-streaming-burst-tool-${index}-call`,
          tool: 'bash',
          state: {
            status: 'running' as const,
            input: { command: `npm run burst-${index}` },
            title: `npm run burst-${index}`,
            metadata: {},
            time: { start: Date.now() },
          },
        };
        harnessWindow.__varroE2E?.updateMessagePart?.(part);
        window.postMessage(
          {
            type: 'server/event',
            payload: { type: 'message.part.updated', properties: { part } },
          },
          '*'
        );
      }
    });

    await expect(page.getByText('npm run burst-39', { exact: true })).toBeVisible();
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
    await expect(composer).toBeFocused();
  });

  test('slow upward scrolling stays anchored while new content streams', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-large-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    for (let index = 0; index < 24; index += 1) {
      const before = await getVisibleMessageAnchor(list);

      await page.mouse.wheel(0, -1);
      await appendDeltaToMultiAgentLargeStreaming(
        page,
        `\n\nSlow-scroll chunk ${index}: ${'stream without moving the detached viewport '.repeat(5 + (index % 3))}`
      );
      await appendRunningToolPart(page, index);
      const samples = await sampleMessageTopAcrossFrames(list, before.id, 4);
      for (const top of samples) {
        expect(top).not.toBeNull();
        expect(Math.abs(top! - before.top - 1)).toBeLessThan(1.5);
      }
    }
  });

  test('offscreen activity completion does not move a detached viewport', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=multi-agent-large-streaming'
    );
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 300);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);
    const anchor = await getVisibleMessageAnchor(list);

    await appendRunningToolPart(page, 100);
    await page.waitForTimeout(250);
    const activity = page.locator(
      '[data-activity-part-id="message-mla-assistant-streaming-tool-100"]'
    );
    await expect(activity).toHaveCount(1);
    expect(
      await activity.evaluate((element) => {
        const transcript = element.closest('.interactive-list');
        return (
          !!transcript &&
          element.getBoundingClientRect().top >= transcript.getBoundingClientRect().bottom
        );
      })
    ).toBe(true);
    await expect(activity).not.toHaveClass(/is-entering/);
    await completeRunningToolPart(page, 100);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    for (let sample = 0; sample < 32; sample += 1) {
      const before = await getVisibleMessageAnchor(list, anchor.id);
      await page.mouse.wheel(0, -1);
      await page.waitForTimeout(100);
      const current = await getVisibleMessageAnchor(list, anchor.id);
      expect(
        Math.abs(current.top - before.top - 1),
        JSON.stringify({ sample, before, current })
      ).toBeLessThan(1.5);
    }
  });

  test('detached scroll holds while streaming in large multi-agent transcript', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-large-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      const mid = Math.floor(element.scrollHeight / 2);
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = mid;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);
    const detachedAnchor = await getVisibleMessageAnchor(list);

    for (let i = 0; i < 10; i += 1) {
      await appendDeltaToMultiAgentLargeStreaming(
        page,
        `\n\nDetached streaming chunk ${i}: ${'content should not move viewport '.repeat(6)}`
      );
      const samples = await sampleMessageTopAcrossFrames(list, detachedAnchor.id, 2);
      expect(
        samples.every((top) => top !== null && Math.abs(top - detachedAnchor.top) < 1.5),
        JSON.stringify({ i, detachedAnchor, samples })
      ).toBe(true);
    }

    const afterStreaming = await getVisibleMessageAnchor(list, detachedAnchor.id);
    expect(Math.abs(afterStreaming.top - detachedAnchor.top)).toBeLessThan(1.5);
  });

  test('no viewport blank space at any scroll position in multi-agent large transcript', async ({
    page,
  }) => {
    // Scroll coordinates select coverage samples; rendered viewport content is the oracle.
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-large-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const scrollHeight = await list.evaluate((el) => el.scrollHeight);
    const viewportHeight = await list.evaluate((el) => el.clientHeight);
    const positions = [
      0,
      scrollHeight * 0.2,
      scrollHeight * 0.4,
      scrollHeight * 0.6,
      scrollHeight * 0.8,
      scrollHeight - viewportHeight,
    ];

    for (const targetScrollTop of positions) {
      await list.evaluate((element, target) => {
        element.scrollTop = target;
        element.dispatchEvent(new Event('scroll'));
      }, targetScrollTop);
      await waitForAnimationFrames(page, 3);

      const renderedRowCount = await list.evaluate((element) => {
        const containerRect = element.getBoundingClientRect();
        return [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].filter((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
        }).length;
      });
      expect(renderedRowCount).toBeGreaterThan(0);
    }
  });
});
