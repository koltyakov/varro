import { expect, test } from '@playwright/test';
import { getScrollMetrics } from './helpers';

async function waitForAnimationFrame(page: import('@playwright/test').Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

test.describe('auto-scroll', () => {
  test('starts at the bottom of the conversation', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('manual scroll up disengages auto-scroll', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await waitForAnimationFrame(page);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 300);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    const metrics = await getScrollMetrics(page, '.interactive-list');
    expect(metrics.distanceFromBottom).toBeGreaterThan(200);
  });

  test('does not jitter when scrolled to the middle of a large transcript', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    const midpoint = await list.evaluate((element) => {
      const mid = Math.floor(element.scrollHeight / 2);
      element.scrollTop = mid;
      element.dispatchEvent(new Event('scroll'));
      return mid;
    });
    await waitForAnimationFrame(page);

    const posAfterFrame = await list.evaluate((el) => el.scrollTop);
    expect(Math.abs(posAfterFrame - midpoint)).toBeLessThan(2);

    await waitForAnimationFrame(page);
    const posAfterSecondFrame = await list.evaluate((el) => el.scrollTop);
    expect(Math.abs(posAfterSecondFrame - midpoint)).toBeLessThan(2);
  });
});

test.describe('sticky preview overlap', () => {
  test('hides immediately when next user message reaches the sticky bottom', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=sticky-preview');
    const list = page.locator('.interactive-list');
    const sticky = page.locator('.latest-user-message-sticky');

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);
    await expect(sticky).toBeVisible();

    const overlapDetected = await list.evaluate((element) => {
      const stickyEl = document.querySelector('.latest-user-message-sticky');
      const nextPrompt = document.querySelector(
        '[data-msg-id="message-sticky-user-2"] .user-message-card'
      );
      if (!stickyEl || !nextPrompt) return false;

      const stickyBottom = stickyEl.getBoundingClientRect().bottom;
      const promptTop = nextPrompt.getBoundingClientRect().top;

      const step = 5;
      for (let i = 0; i < 600; i++) {
        element.scrollTop += step;
        element.dispatchEvent(new Event('scroll'));

        const currentStickyEl = document.querySelector('.latest-user-message-sticky');
        const currentPromptEl = document.querySelector(
          '[data-msg-id="message-sticky-user-2"] .user-message-card'
        );
        if (!currentStickyEl || !currentPromptEl) break;

        const currentStickyBottom = currentStickyEl.getBoundingClientRect().bottom;
        const currentPromptTop = currentPromptEl.getBoundingClientRect().top;
        if (currentPromptTop < currentStickyBottom) {
          return true;
        }
      }
      return false;
    });

    expect(overlapDetected).toBe(false);
  });

  test('sticky hides when scrolling back up toward its source message', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=sticky-preview');
    const list = page.locator('.interactive-list');
    const sticky = page.locator('.latest-user-message-sticky');

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);
    await expect(sticky).toBeVisible();

    await list.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);
    await waitForAnimationFrame(page);

    await expect(sticky).not.toBeVisible();
  });
});
