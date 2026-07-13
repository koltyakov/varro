import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EState } from './helpers';

async function getRenderedMessageRowCount(page: Page) {
  return getE2EState(page, () => document.querySelectorAll('[data-msg-id]').length);
}

async function waitForAnimationFrame(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

test('large transcripts keep rendered rows bounded while scrolling', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');

  await expect(page.locator('.chat-header-title-text').first()).toHaveText('Large transcript');
  const list = page.locator('.interactive-list');
  await expect(list).toBeVisible();

  await expect.poll(() => getRenderedMessageRowCount(page)).toBeLessThan(90);

  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
    element.dispatchEvent(new Event('scroll'));
  });
  await waitForAnimationFrame(page);
  await expect.poll(() => getRenderedMessageRowCount(page)).toBeLessThan(90);

  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await waitForAnimationFrame(page);
  await expect.poll(() => getRenderedMessageRowCount(page)).toBeLessThan(90);

  await list.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 40);
    element.dispatchEvent(new Event('scroll'));
  });
  await waitForAnimationFrame(page);
  await expect.poll(() => getRenderedMessageRowCount(page)).toBeLessThan(90);

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
});
