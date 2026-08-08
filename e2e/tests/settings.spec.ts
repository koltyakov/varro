import { expect, test } from '@playwright/test';
import { getE2EState, getVisibleMessageAnchor, sampleMessageTopAcrossFrames } from './helpers';

test('toggling /thinking hides and shows reasoning blocks', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready&expandedActivity=1');

  const thinkingBoxes = page.locator('.chat-thinking-box');
  await expect(thinkingBoxes).toBeVisible();

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('/thinking');
  await page.keyboard.press('Enter');

  await expect(thinkingBoxes).toHaveCount(0);

  await composer.click();
  await composer.fill('/thinking');
  await page.keyboard.press('Enter');

  await expect(thinkingBoxes).toBeVisible();
});

test('thinking visibility preserves a detached virtualized anchor', async ({ page }) => {
  await page.goto(
    '/e2e/harness/index.html?scenario=heterogeneous-large-transcript&expandedActivity=1'
  );
  const list = page.locator('.interactive-list');
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    element.scrollTop = element.scrollHeight * 0.5;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  const anchor = await getVisibleMessageAnchor(list);
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();

  for (const expectedThinkingCount of [0, 1]) {
    await composer.fill('/thinking');
    await page.keyboard.press('Enter');
    if (expectedThinkingCount === 0) {
      await expect(page.locator('.chat-thinking-box')).toHaveCount(0);
    } else {
      await expect.poll(() => page.locator('.chat-thinking-box').count()).toBeGreaterThan(0);
    }
    const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 12);
    for (const top of samples) {
      expect(top).not.toBeNull();
      expect(Math.abs(top! - anchor.top)).toBeLessThan(1.5);
    }
  }
});

test('hiding an expanded offscreen activity group preserves the bottom viewport', async ({
  page,
}) => {
  await page.goto(
    '/e2e/harness/index.html?scenario=thinking-expanded-virtualized-anchor&expandedActivity=1'
  );
  const list = page.locator('.interactive-list');
  const summary = page.locator('.assistant-activity-summary', { hasText: '9 thoughts' });
  for (let step = 0; step <= 20 && (await summary.count()) === 0; step += 1) {
    await list.evaluate((element, ratio) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop = (element.scrollHeight - element.clientHeight) * ratio;
      element.dispatchEvent(new Event('scroll'));
    }, step / 20);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    );
  }
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await summary.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expect.poll(() => page.locator('.chat-thinking-box').count()).toBe(9);
  await list.evaluate(async (element) => {
    const target = element.scrollHeight - element.clientHeight - 120;
    while (element.scrollTop < target - 1) {
      const movement = Math.min(100, target - element.scrollTop);
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: movement, bubbles: true }));
      element.scrollTop += movement;
      element.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );

  const anchor = await getVisibleMessageAnchor(list);
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('/thinking');
  await page.keyboard.press('Enter');
  await expect(page.locator('.chat-thinking-box')).toHaveCount(0);

  const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 12);
  for (const top of samples) {
    expect(top).not.toBeNull();
    expect(Math.abs(top! - anchor.top), JSON.stringify({ anchor, samples })).toBeLessThan(1.5);
  }
});

test('/thinking description reflects current visibility state', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready&expandedActivity=1');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('/thinking');

  await expect(page.getByText('Hide thinking blocks')).toBeVisible();
  await page.keyboard.press('Escape');

  await composer.click();
  await composer.fill('/thinking');
  await page.keyboard.press('Enter');

  await composer.click();
  await composer.fill('/thinking');
  await expect(page.getByText('Show thinking blocks')).toBeVisible();
});

test('thinking preference persists across reload', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready&expandedActivity=1');

  await expect(page.locator('.chat-thinking-box')).toBeVisible();

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('/thinking');
  await page.keyboard.press('Enter');

  await expect(page.locator('.chat-thinking-box')).toHaveCount(0);

  await expect
    .poll(() =>
      getE2EState(page, () => ({
        showThinking: localStorage.getItem('varro.showThinking'),
      }))
    )
    .toEqual({ showThinking: 'false' });

  await page.reload();

  await expect(page.locator('.chat-thinking-box')).toHaveCount(0);

  await composer.click();
  await composer.fill('/thinking');
  await page.keyboard.press('Enter');

  await expect(page.locator('.chat-thinking-box')).toBeVisible();
});

test('sticky prompt ignores a legacy disabled preference', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('varro.showStickyUserPrompt', 'false');
  });
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview');

  const list = page.locator('.interactive-list');
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(page.locator('.latest-user-message-sticky')).toBeVisible();
});
