import { expect, test } from '@playwright/test';

test('sends multiple inline skill chips and shows them above the message', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 500, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=slash-commands');
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Use $[browser-bridge] to inspect the page, then $[unslop].');
  await expect(composer.locator('[data-chip-type="mention-skill"]')).toHaveText([
    'browser-bridge',
    'unslop',
  ]);
  await composer.press('Enter');
  const message = page.locator('.user-message-card').last();
  await expect(message.locator('.user-message-text .inline-chip')).toHaveText([
    'browser-bridge',
    'unslop',
  ]);
  const attachments = message.locator('.message-attachments-leading');
  await expect(attachments).toContainText('browser-bridge');
  await expect(attachments).toContainText('unslop');
  await expect(message).not.toContainText('Use the skill tool');
  const railBox = await attachments.boundingBox();
  const textBox = await message.locator('.user-message-text').boundingBox();
  expect(railBox).not.toBeNull();
  expect(textBox).not.toBeNull();
  expect(railBox!.y + railBox!.height).toBeLessThanOrEqual(textBox!.y);
  await page.screenshot({ path: testInfo.outputPath('skill-attachments.png') });
});

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
