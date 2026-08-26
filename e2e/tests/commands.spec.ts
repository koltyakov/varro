import { expect, test } from '@playwright/test';

test('hides disabled slash commands', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=slash-commands');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  for (const [command, description] of [
    ['/new', 'Start a new chat session'],
    ['/sessions', 'Open the session list'],
    ['/fork', 'Fork the current session'],
    ['/attach', 'Pick files or folders to attach'],
    ['/abort', 'Stop the current run'],
    ['/models', 'Open the model picker'],
    ['/mcp', 'Open the MCP picker for this session'],
  ] as const) {
    await composer.fill(command);
    await expect(page.getByText(description, { exact: true })).not.toBeVisible();
  }
});

test('reacts to host command events for focus and attention sessions', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/e2e/harness/index.html?scenario=command-events');
  const sessionsPane = page.getByRole('complementary', { name: 'Sessions' });

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeFocused();
  await expect(sessionsPane.getByText('Filtered:', { exact: true })).toBeVisible();
  await expect(sessionsPane.locator('.chat-header-filter-chip-label')).toHaveText(
    'Needs attention'
  );
  await expect(sessionsPane.locator('.session-item-title')).toContainText([
    'Follow up attention queue',
    'Build approval required',
  ]);
});

test('keeps the attention filter applied after opening a session from a host command event', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/e2e/harness/index.html?scenario=command-events');
  const sessionsPane = page.getByRole('complementary', { name: 'Sessions' });

  await expect(sessionsPane.locator('.chat-header-filter-chip-label')).toHaveText(
    'Needs attention'
  );
  await sessionsPane
    .locator('.session-item')
    .filter({ hasText: 'Build approval required' })
    .getByRole('button')
    .first()
    .click();

  await expect(page.locator('.chat-header-title-text').first()).toHaveText(
    'Build approval required'
  );
  await expect(sessionsPane.locator('.chat-header-filter-chip-label')).toHaveText(
    'Needs attention'
  );
  await expect(sessionsPane.locator('.session-item-title')).toContainText([
    'Follow up attention queue',
    'Build approval required',
  ]);
});

test('reapplies the attention filter after reload when host command events fire again', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/e2e/harness/index.html?scenario=command-events');
  const sessionsPane = page.getByRole('complementary', { name: 'Sessions' });

  await expect(sessionsPane.locator('.chat-header-filter-chip-label')).toHaveText(
    'Needs attention'
  );
  await page.reload();

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeFocused();
  await expect(sessionsPane.locator('.chat-header-filter-chip-label')).toHaveText(
    'Needs attention'
  );
  await expect(sessionsPane.locator('.session-item-title')).toContainText([
    'Follow up attention queue',
    'Build approval required',
  ]);
});
