import { expect, test } from '@playwright/test';
import { getScrollMetrics, waitForAnimationFrame, waitForAnimationFrames } from './helpers';
import {
  appendDeltaToMultiAgentLargeStreaming,
  appendDeltaToMultiAgentStreaming,
} from './scroll-helpers';

test.describe('multi-agent scroll stability', () => {
  test('no jitter when streaming at bottom with multiple completed agent responses', async ({
    page,
  }) => {
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

    const positions: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      await appendDeltaToMultiAgentStreaming(
        page,
        `\n\nMulti-agent streaming chunk ${i}: ${`Streaming into a chat with multiple completed agent turns. This exercises the scroll anchoring logic. `.repeat(4)}`
      );
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    let maxFrameDelta = 0;
    for (let i = 1; i < positions.length; i += 1) {
      const frameDelta = Math.abs(positions[i]! - positions[i - 1]!);
      maxFrameDelta = Math.max(maxFrameDelta, frameDelta);
    }

    expect(maxFrameDelta).toBeLessThan(120);

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('no jump to previous agent message during streaming', async ({ page }) => {
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

    const positions: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      await appendDeltaToMultiAgentStreaming(
        page,
        `\n\nNo-backward-jump chunk ${i}: ${'Verify scroll position only moves forward during streaming. '.repeat(6)}`
      );
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]! - 3);
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

    const positions: number[] = [await list.evaluate((element) => element.scrollTop)];
    for (let index = 0; index < 40; index += 1) {
      await page.mouse.wheel(0, -200);
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]).toBeLessThanOrEqual(positions[index - 1]! + 2);
    }

    const viewportHeight = await list.evaluate((element) => element.clientHeight);
    for (let index = 1; index < positions.length; index += 1) {
      const upwardDelta = positions[index - 1]! - positions[index]!;
      expect(upwardDelta).toBeLessThan(viewportHeight * 0.8);
    }
  });

  test('scroll position stable after top-to-bottom round trip in multi-agent transcript', async ({
    page,
  }) => {
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

  test('no backward jumps during streaming in large multi-agent transcript', async ({ page }) => {
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

    const positions: number[] = [];
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
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]! - 3);
    }

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
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

    const detachedScrollTop = await list.evaluate((element) => {
      const mid = Math.floor(element.scrollHeight / 2);
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = mid;
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop;
    });
    await waitForAnimationFrames(page, 3);

    for (let i = 0; i < 10; i += 1) {
      await appendDeltaToMultiAgentLargeStreaming(
        page,
        `\n\nDetached streaming chunk ${i}: ${'content should not move viewport '.repeat(6)}`
      );
      await waitForAnimationFrames(page, 2);
    }

    const afterStreaming = await list.evaluate((element) => element.scrollTop);
    expect(Math.abs(afterStreaming - detachedScrollTop)).toBeLessThan(10);
  });

  test('no viewport blank space at any scroll position in multi-agent large transcript', async ({
    page,
  }) => {
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
