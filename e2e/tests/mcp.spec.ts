import { expect, test } from '@playwright/test';

test('opens the MCP picker from slash commands and updates connection state', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=mcp-pickers');

  const composer = page.locator('textarea');
  await composer.click();
  await composer.fill('/mcp');
  await expect(page.getByText('Open the MCP picker for this session')).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(page.getByText('chrome', { exact: true })).toBeVisible();
  await expect(page.getByText('needs auth', { exact: true })).toBeVisible();
  await expect(page.getByText('cli not authenticated', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: /github/i }).click();

  await expect.poll(() => page.evaluate(() => localStorage.getItem('varro.sessionSelectedMcps'))).toContain('github');
});
