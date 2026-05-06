import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('opens read mode for long assistant answers and preserves rendered content', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=message-rendering');

  await expect(page.locator('.chat-header-title-text').first()).toHaveText('Rendered message actions');
  await expect(page.getByRole('link', { name: 'release notes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy code' })).toBeVisible();

  await page.getByRole('button', { name: 'Open read mode' }).click();

  const dialog = page.getByRole('dialog', { name: 'Read mode' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('rich assistant message controls')).toBeVisible();
  await expect(dialog.getByText("export const useful = 'e2e coverage';")).toBeVisible();

  await dialog.getByRole('button', { name: 'Exit read mode' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
});

test('closes read mode with escape', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=message-rendering');

  await page.getByRole('button', { name: 'Open read mode' }).click();
  const dialog = page.getByRole('dialog', { name: 'Read mode' });
  await expect(dialog).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
});

test('routes safe external markdown links through the extension bridge', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=message-rendering');

  await page.getByRole('link', { name: 'release notes' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: { externalUrls?: string[] };
        }).__varroE2E;
        return value?.externalUrls || [];
      })
    )
    .toEqual(['https://example.com/varro/releases']);
});
