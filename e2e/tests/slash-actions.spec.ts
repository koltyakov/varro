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

test('renders inline argument hints without inserting them into command text', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 500, height: 700 });
  await page.goto('/e2e/harness/index.html?scenario=slash-commands&nativeCommand=1');
  const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
  await composer.fill('/mc');
  await composer.press('Tab');
  await expect(composer).toHaveText('/mcp');
  await expect(composer).toHaveAttribute('data-command-argument-hint', ' [server]');
  expect(await composer.evaluate((element) => getComputedStyle(element, '::after').content)).toBe(
    '" [server]"'
  );
  await composer.press('Space');
  await expect(composer).toHaveAttribute('data-command-argument-hint', '[server]');
  await composer.pressSequentially('browser');
  await expect(composer).not.toHaveAttribute('data-command-argument-hint');
  await expect(composer).toHaveText('/mcp browser');
  await composer.fill('/mcps ');
  await expect(composer).toHaveAttribute('data-command-argument-hint', '[server]');
  await composer.fill('/audit ');
  await expect(composer).toHaveAttribute('data-command-argument-hint', '[arguments]');
  expect(await composer.textContent()).toBe('/audit ');
  await page.screenshot({ path: testInfo.outputPath('command-argument-hint.png') });
  await composer.fill('/settings');
  await expect(composer).not.toHaveAttribute('data-command-argument-hint');
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

test('keeps matching slash suggestion rows mounted through Backspace', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=slash-commands');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('/connec');
  const connectItem = page.locator('.composer-completion-item', {
    hasText: 'Connect a provider',
  });
  await expect(connectItem).toBeVisible();
  await connectItem.evaluate((element) => {
    element.setAttribute('data-backspace-identity', 'retained');
  });

  await composer.press('Backspace');

  await expect(composer).toHaveText('/conne');
  await expect(
    page.locator('.composer-completion-item[data-backspace-identity="retained"]', {
      hasText: 'Connect a provider',
    })
  ).toBeVisible();
});
