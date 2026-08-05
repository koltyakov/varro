import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('opens read mode for long assistant answers and preserves rendered content', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=message-rendering');

  await expect(page.locator('.chat-header-title-text').first()).toHaveText(
    'Rendered message actions'
  );
  await expect(page.getByRole('link', { name: 'release notes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy code' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open read mode' })).toHaveCount(0);

  await page.locator('.interactive-list-track').evaluate((track) => {
    track.classList.add('virtualized');
  });
  const chatContentWidth = await page
    .locator('.interactive-list-track')
    .evaluate((element) => element.getBoundingClientRect().width);
  await page.keyboard.down('Alt');
  await page.getByRole('button', { name: 'Open read mode' }).click();
  await page.keyboard.up('Alt');

  const dialog = page.getByRole('dialog', { name: 'Read mode' });
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      dialog.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return {
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
          contentWidth: element
            .querySelector('.assistant-read-overlay-inner')!
            .getBoundingClientRect().width,
          insideMessageRow: element.closest('.interactive-item-container') !== null,
        };
      })
    )
    .toEqual({
      left: 0,
      top: 0,
      width: await page.evaluate(() => window.innerWidth),
      height: await page.evaluate(() => window.innerHeight),
      contentWidth: chatContentWidth,
      insideMessageRow: false,
    });
  await expect(dialog.getByText('rich assistant message controls')).toBeVisible();
  await expect(dialog.getByText("export const useful = 'e2e coverage';")).toBeVisible();

  await dialog.getByRole('button', { name: 'Exit read mode' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
});

test('closes read mode with escape', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=message-rendering');

  await expect(page.locator('.chat-header-title-text').first()).toHaveText(
    'Rendered message actions'
  );
  await page.keyboard.down('Alt');
  await page.getByRole('button', { name: 'Open read mode' }).click();
  await page.keyboard.up('Alt');
  const dialog = page.getByRole('dialog', { name: 'Read mode' });
  await expect(dialog).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
});

test('keeps final-answer rails visible in virtualized transcripts', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');

  const track = page.locator('.interactive-list-track');
  await expect(track).toHaveClass(/virtualized/);

  const finalRow = page.locator('[data-msg-id="message-large-assistant-239"]');
  const ordinaryRow = page.locator('[data-msg-id="message-large-user-239"]');
  const finalItem = finalRow.locator('.assistant-message-flow-item-final');
  await expect(finalItem).toBeVisible();

  const containment = await finalRow.evaluate((row) => getComputedStyle(row).contain);
  const ordinaryContainment = await ordinaryRow.evaluate((row) => getComputedStyle(row).contain);
  const rail = await finalItem.evaluate((item) => {
    const style = getComputedStyle(item, '::before');
    return {
      content: style.content,
      width: style.width,
      backgroundColor: style.backgroundColor,
    };
  });

  expect(containment).toContain('layout');
  expect(containment).not.toBe('content');
  expect(ordinaryContainment).toBe('content');
  expect(rail.content).not.toBe('none');
  expect(rail.width).toBe('1px');
  expect(rail.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
});

test('routes safe external markdown links through the extension bridge', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=message-rendering');

  await page.getByRole('link', { name: 'release notes' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { externalUrls?: string[] };
          }
        ).__varroE2E;
        return value?.externalUrls || [];
      })
    )
    .toEqual(['https://example.com/varro/releases']);
});
