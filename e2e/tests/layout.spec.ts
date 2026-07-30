import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('sticky preview hides before the next prompt can overlap it', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview');

  const list = page.locator('.interactive-list');
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
    const header = document.querySelector(
      '.interactive-session > .chat-header'
    ) as HTMLElement | null;
    const stickyElement = document.querySelector(
      '.latest-user-message-sticky-overlay'
    ) as HTMLElement | null;
    const nextPromptElement = document.querySelector(
      '[data-msg-id="message-sticky-user-2"] .user-message-card'
    ) as HTMLElement | null;
    if (!header || !stickyElement || !nextPromptElement) return null;
    const headerBox = header.getBoundingClientRect();
    const stickyBox = stickyElement.getBoundingClientRect();
    const promptBox = nextPromptElement.getBoundingClientRect();
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

test('sticky preview follows live prompt geometry when the assistant row grows', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview');

  const list = page.locator('.interactive-list');
  const sticky = page.locator('.latest-user-message-sticky');
  const nextPrompt = page.locator('[data-msg-id="message-sticky-user-2"] .user-message-card');

  await page.locator('[data-msg-id="message-sticky-assistant-2"]').evaluate((row) => {
    row.setAttribute('style', 'padding-bottom: 600px');
  });
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    element.scrollTop = Math.max(0, element.scrollTop - 100);
    element.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await list.evaluate((element) => {
    const prompt = element.querySelector(
      '[data-msg-id="message-sticky-user-2"] .user-message-card'
    );
    if (!prompt) throw new Error('Next prompt is not mounted');
    element.scrollTop +=
      prompt.getBoundingClientRect().top - element.getBoundingClientRect().top - 70;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect
    .poll(() =>
      nextPrompt.evaluate((prompt) => {
        const scrollList = prompt.closest('.interactive-list');
        if (!scrollList) throw new Error('Message list is missing');
        return prompt.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
      })
    )
    .toBeCloseTo(70, 0);
  await expect(sticky).toHaveCount(0);

  await page.locator('[data-msg-id="message-sticky-assistant-1"]').evaluate((row) => {
    row.setAttribute('style', 'padding-bottom: 220px');
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );

  const promptTop = await nextPrompt.evaluate((prompt) => {
    const scrollList = prompt.closest('.interactive-list');
    if (!scrollList) throw new Error('Message list is missing');
    return prompt.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
  });
  expect(promptTop).toBeGreaterThan(200);
  await expect(sticky).toBeVisible();
  await expect(sticky).toContainText('keep this prompt visible while the answer scrolls');
});

test('virtualized long sticky preview never overlaps the next prompt', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview-large-transcript');

  const list = page.locator('.interactive-list');
  const track = page.locator('.interactive-list-track');
  const sticky = page.locator('.latest-user-message-sticky');
  const nextPrompt = page.locator('[data-msg-id="message-sticky-large-user-2"] .user-message-card');
  await expect(track).toHaveClass(/virtualized/);
  await expect(nextPrompt).toBeAttached();

  await list.evaluate((element) => {
    const prompt = element.querySelector(
      '[data-msg-id="message-sticky-large-user-2"] .user-message-card'
    );
    if (!prompt) throw new Error('Next prompt is not mounted');
    element.scrollTop +=
      prompt.getBoundingClientRect().top - element.getBoundingClientRect().top - 180;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(sticky).toBeVisible();
  await expect(sticky).toContainText('Do not animate text in agent calls');

  await list.evaluate((element) => {
    const overlay = document.querySelector<HTMLElement>('.latest-user-message-sticky-overlay');
    const prompt = document.querySelector<HTMLElement>(
      '[data-msg-id="message-sticky-large-user-2"] .user-message-card'
    );
    if (!overlay || !prompt) throw new Error('Sticky collision targets are not mounted');
    element.scrollTop +=
      prompt.getBoundingClientRect().top - overlay.getBoundingClientRect().bottom - 12;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(sticky).toBeVisible();
  const initialGap = await page.evaluate(() => {
    const overlay = document.querySelector<HTMLElement>('.latest-user-message-sticky-overlay')!;
    const prompt = document.querySelector<HTMLElement>(
      '[data-msg-id="message-sticky-large-user-2"] .user-message-card'
    )!;
    return prompt.getBoundingClientRect().top - overlay.getBoundingClientRect().bottom;
  });
  expect(initialGap).toBeGreaterThanOrEqual(0);
  expect(initialGap).toBeLessThan(24);

  await page.setViewportSize({ width: 460, height: 800 });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await expect(nextPrompt).toBeAttached();
  const result = await page.evaluate(() => {
    const overlay = document.querySelector<HTMLElement>('.latest-user-message-sticky-overlay');
    const prompt = document.querySelector<HTMLElement>(
      '[data-msg-id="message-sticky-large-user-2"] .user-message-card'
    );
    if (!overlay) return { overlap: false, stickyHidden: true };
    if (!prompt) return { overlap: true, stickyHidden: false, reason: 'next prompt unmounted' };
    const overlayBottom = overlay.getBoundingClientRect().bottom;
    const promptTop = prompt.getBoundingClientRect().top;
    return {
      overlap: promptTop < overlayBottom,
      stickyHidden: false,
      overlayBottom,
      promptTop,
    };
  });

  expect(result.overlap, JSON.stringify(result)).toBe(false);
  expect(result.stickyHidden, JSON.stringify(result)).toBe(true);
});
