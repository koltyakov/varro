/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: This E2E check inspects controlled slash-action requests exposed by the harness browser global. */
import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('slash commands trigger settings actions', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=slash-commands');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();

  await composer.click();
  await composer.fill('/settings');
  await expect(page.getByText('Open VS Code settings for Varro')).toBeVisible();
  await page.keyboard.press('Enter');

  const state = await getE2EState(page, () => {
    const value = (
      window as Window & {
        __varroE2E?: {
          settingsQueries?: string[];
        };
      }
    ).__varroE2E;
    return {
      settings: value?.settingsQueries?.[0] || null,
    };
  });

  expect(state).toEqual({
    settings: 'Varro >',
  });
});

test('supports keyboard navigation and tab completion for slash command suggestions', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=slash-commands');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('/co');
  await expect(page.getByText('Connect a provider')).toBeVisible();

  await composer.press('ArrowDown');
  await expect(page.locator('.composer-completion-item.selected')).toHaveCount(1);
  const selectedTitle = page.locator(
    '.composer-completion-item.selected .composer-completion-title'
  );
  const selectedText = await selectedTitle.textContent();
  await composer.press('Tab');

  await expect(composer).toHaveText(selectedText?.trim() || '');
});

test('closes slash command suggestions with escape', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=slash-commands');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('/co');
  await expect(page.locator('.composer-completion-menu')).toBeVisible();

  await composer.press('Escape');

  await expect(page.locator('.composer-completion-menu')).toHaveCount(0);
  await expect(composer).toHaveText('');
});
