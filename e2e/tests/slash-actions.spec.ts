import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('slash commands trigger provider setup, settings, and file picker actions', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=slash-commands');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();

  await composer.click();
  await composer.fill('/connect');
  await expect(page.getByText('Open provider login in the terminal')).toBeVisible();
  await page.keyboard.press('Enter');

  await composer.click();
  await composer.fill('/settings');
  await expect(page.getByText('Open VS Code settings for Varro')).toBeVisible();
  await page.keyboard.press('Enter');

  await composer.click();
  await composer.fill('/attach');
  await expect(page.getByText('Pick files or folders to attach')).toBeVisible();
  await page.keyboard.press('Enter');

  const state = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: {
        terminalCommands?: Array<{ command: string; title?: string }>;
        settingsQueries?: string[];
        filePickCount?: number;
      };
    }).__varroE2E;
    return {
      terminal: value?.terminalCommands?.[0] || null,
      settings: value?.settingsQueries?.[0] || null,
      filePickCount: value?.filePickCount || 0,
    };
  });

  expect(state).toEqual({
    terminal: { command: 'opencode auth login', title: 'OpenCode Provider Setup' },
    settings: 'Varro',
    filePickCount: 1,
  });
});

test('supports keyboard navigation and tab completion for slash command suggestions', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=slash-commands');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('/co');
  await expect(page.getByText('Open provider login in the terminal')).toBeVisible();

  await composer.press('ArrowDown');
  await expect(page.locator('.composer-completion-item.selected')).toHaveCount(1);
  const selectedTitle = page.locator('.composer-completion-item.selected .composer-completion-title');
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
