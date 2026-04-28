import { expect, test } from '@playwright/test';

test('supports slash commands for sessions and settings-adjacent pickers', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=slash-commands');

  const composer = page.locator('textarea');
  await composer.click();
  await composer.fill('/sessions');
  await expect(page.getByText('Open the session list')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Sessions', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Slash command flows' }).click();
  await composer.click();
  await composer.fill('/models');
  await page.keyboard.press('Enter');
  await expect(page.getByText('OpenAI', { exact: true })).toBeVisible();
  await expect(page.getByText('OpenCode Go', { exact: true })).toBeVisible();

  await composer.click();
  await composer.fill('/mcps');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /chrome connected/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /playwright disabled/i })).toBeVisible();
});

test('reacts to host command events for focus and attention sessions', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/e2e/harness/index.html?scenario=command-events');
  const sessionsPane = page.getByRole('complementary', { name: 'Sessions' });

  await expect(page.locator('textarea')).toBeFocused();
  await expect(sessionsPane.getByText('Filtered:', { exact: true })).toBeVisible();
  await expect(sessionsPane.locator('.chat-header-filter-chip-label')).toHaveText('Needs attention');
  await expect(sessionsPane.locator('.session-item-title')).toContainText([
    'Follow up attention queue',
    'Build approval required',
  ]);
});

test('keeps the attention filter applied after opening a session from a host command event', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/e2e/harness/index.html?scenario=command-events');
  const sessionsPane = page.getByRole('complementary', { name: 'Sessions' });

  await expect(sessionsPane.locator('.chat-header-filter-chip-label')).toHaveText('Needs attention');
  await sessionsPane.locator('.session-item').filter({ hasText: 'Build approval required' }).getByRole('button').first().click();

  await expect(page.locator('.chat-header-title-text').first()).toHaveText('Build approval required');
  await expect(sessionsPane.locator('.chat-header-filter-chip-label')).toHaveText('Needs attention');
  await expect(sessionsPane.locator('.session-item-title')).toContainText([
    'Follow up attention queue',
    'Build approval required',
  ]);
});

test('reapplies the attention filter after reload when host command events fire again', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/e2e/harness/index.html?scenario=command-events');
  const sessionsPane = page.getByRole('complementary', { name: 'Sessions' });

  await expect(sessionsPane.locator('.chat-header-filter-chip-label')).toHaveText('Needs attention');
  await page.reload();

  await expect(page.locator('textarea')).toBeFocused();
  await expect(sessionsPane.locator('.chat-header-filter-chip-label')).toHaveText('Needs attention');
  await expect(sessionsPane.locator('.session-item-title')).toContainText([
    'Follow up attention queue',
    'Build approval required',
  ]);
});
