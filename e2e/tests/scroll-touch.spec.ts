import { expect, test } from '@playwright/test';
import {
  getListDistanceFromBottom,
  getScrollMetrics,
  getVisibleMessageAnchor,
  sampleMessageTopAcrossFrames,
  waitForAnimationFrames,
} from './helpers';
import { appendDeltaToRapidStreaming } from './scroll-helpers';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

for (const gesture of ['tap', 'horizontal swipe'] as const) {
  test(`${gesture} keeps streaming follow enabled`, async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();
    await expect.poll(() => getListDistanceFromBottom(page)).toBeLessThanOrEqual(1);
    const bounds = await list.boundingBox();
    if (!bounds) throw new Error('Missing transcript viewport');
    const cdp = await page.context().newCDPSession(page);
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + 100;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y }],
    });
    if (gesture === 'horizontal swipe') {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + 80, y }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(list).not.toHaveAttribute('data-pointer-scroll-owned');
    const before = (await getScrollMetrics(page, '.interactive-list')).scrollTop;
    await appendDeltaToRapidStreaming(page, `\n\nAfter gesture: ${'More output. '.repeat(80)}`);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
    await expect.poll(() => getListDistanceFromBottom(page)).toBeLessThanOrEqual(1);
    await cdp.detach();
  });
}

test('native touch scrolling releases streaming follow and preserves older content after release', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  const list = page.locator('.interactive-list');
  await expect(list).toBeVisible();
  await expect.poll(() => getListDistanceFromBottom(page)).toBeLessThanOrEqual(1);
  const bounds = await list.boundingBox();
  if (!bounds) throw new Error('Missing transcript viewport');
  await list.evaluate((element) => {
    element.addEventListener('pointercancel', () => element.setAttribute('data-native-pan', ''));
  });
  const cdp = await page.context().newCDPSession(page);
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + 60;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x, y: y + 60 }],
  });
  await expect(list).toHaveAttribute('data-native-pan', '');
  await expect(list).toHaveAttribute('data-pointer-scroll-owned', '');
  // A native pan can outlive the pointer input timeout while the finger is still down.
  await waitForAnimationFrames(page, 45);
  const before = (await getScrollMetrics(page, '.interactive-list')).scrollTop;
  await appendDeltaToRapidStreaming(page, `\n\nDuring touch: ${'More output. '.repeat(80)}`);
  for (let step = 1; step <= 6; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y + 60 + step * 25 }],
    });
    await waitForAnimationFrames(page, 2);
    expect((await getScrollMetrics(page, '.interactive-list')).scrollTop).toBeLessThan(before);
  }
  // Stop the finger before release so this check measures streaming, not native inertia.
  await waitForAnimationFrames(page, 20);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(list).not.toHaveAttribute('data-pointer-scroll-owned');
  await waitForAnimationFrames(page, 10);
  const anchor = await getVisibleMessageAnchor(list);
  await appendDeltaToRapidStreaming(page, `\n\nAfter touch: ${'More output. '.repeat(80)}`);
  const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 45);
  expect(
    samples.every((top) => top !== null && Math.abs(top - anchor.top) <= 1),
    JSON.stringify({ anchor, samples })
  ).toBe(true);
  await page.getByRole('button', { name: 'Scroll to latest message' }).click();
  await expect.poll(() => getListDistanceFromBottom(page)).toBeLessThanOrEqual(1);
  await cdp.detach();
});
