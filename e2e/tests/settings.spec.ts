import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('toggling /thinking hides and shows reasoning blocks', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready');

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

test('/thinking description reflects current visibility state', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready');

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
  await page.goto('/e2e/harness/index.html?scenario=plan-ready');

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

test('sticky prompt preference changes via config/update', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview');

  await expect
    .poll(() =>
      getE2EState(page, () => ({
        showStickyUserPrompt: localStorage.getItem('varro.showStickyUserPrompt'),
      }))
    )
    .toEqual({ showStickyUserPrompt: null });

  const list = page.locator('.interactive-list');
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(page.locator('.latest-user-message-sticky')).toBeVisible();

  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'config/update',
        payload: {
          expandThinkingByDefault: false,
          showStickyUserPrompt: false,
          desktopSessionPaneSide: 'left',
        },
      },
      '*'
    );
  });

  await expect(page.locator('.latest-user-message-sticky')).toHaveCount(0);

  await expect
    .poll(() =>
      getE2EState(page, () => ({
        showStickyUserPrompt: localStorage.getItem('varro.showStickyUserPrompt'),
      }))
    )
    .toEqual({ showStickyUserPrompt: 'false' });
});
