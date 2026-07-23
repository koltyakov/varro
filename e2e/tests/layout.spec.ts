import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('sticky preview hides before the next prompt can overlap it', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview');

  const list = page.locator('.interactive-list');
  const header = page.locator('.interactive-session > .chat-header');
  const sticky = page.locator('.latest-user-message-sticky');
  const nextPrompt = page.locator('[data-msg-id="message-sticky-user-2"] .user-message-card');

  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
    element.dispatchEvent(new Event('scroll'));
  });

  await expect(sticky).toBeVisible();
  await expect(sticky).toContainText('keep this prompt visible while the answer scrolls');
  const textClip = sticky.locator('.latest-user-message-sticky-text-clip');
  await expect(textClip).toHaveClass(/has-more-below/);
  const overflowFade = await textClip.evaluate((element) => {
    const text = element.querySelector('.latest-user-message-sticky-text');
    return {
      maskImage: text ? getComputedStyle(text).maskImage : 'none',
      overlayContent: getComputedStyle(element, '::after').content,
    };
  });
  expect(overflowFade.maskImage).not.toBe('none');
  expect(overflowFade.overlayContent).toBe('none');

  const gaps = await getE2EState(page, () => {
    const header = document.querySelector('.interactive-session > .chat-header') as HTMLElement | null;
    const sticky = document.querySelector('.latest-user-message-sticky') as HTMLElement | null;
    const nextPrompt = document.querySelector(
      '[data-msg-id="message-sticky-user-2"] .user-message-card'
    ) as HTMLElement | null;
    if (!header || !sticky || !nextPrompt) return null;
    const headerBox = header.getBoundingClientRect();
    const stickyBox = sticky.getBoundingClientRect();
    const promptBox = nextPrompt.getBoundingClientRect();
    return {
      headerGap: stickyBox.top - headerBox.bottom,
      promptGap: promptBox.top - stickyBox.bottom,
    };
  });

  expect(gaps?.headerGap).toBeGreaterThanOrEqual(0);
  expect(gaps?.promptGap).toBeGreaterThanOrEqual(0);

  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });

  await expect(sticky).toBeVisible();
  await expect(nextPrompt).toBeVisible();
});
