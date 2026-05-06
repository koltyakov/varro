import { expect, test } from '@playwright/test';

test('focus-input without pending attention focuses textarea but does not show attention filter', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/e2e/harness/index.html?scenario=statusbar-focus');
  const sessionsPane = page.getByRole('complementary', { name: 'Sessions' });

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeFocused();
  await expect(sessionsPane.getByText('Filtered:', { exact: true })).not.toBeVisible();
  await expect(sessionsPane.locator('.chat-header-filter-chip-label')).not.toBeVisible();
});

test('open-attention-sessions with pending attention shows filter and lists sessions', async ({
  page,
}) => {
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

test('posting focus-input at runtime focuses textarea without activating attention filter', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const sessionsPane = page.getByRole('complementary', { name: 'Sessions' });

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
  await page.evaluate(() => {
    window.postMessage({ type: 'command/focus-input' }, '*');
  });

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeFocused();
  await expect(sessionsPane.locator('.chat-header-filter-chip-label')).not.toBeVisible();
});

test('focus-input followed by open-attention-sessions switches from plain focus to attention filter', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/e2e/harness/index.html?scenario=command-events');
  const sessionsPane = page.getByRole('complementary', { name: 'Sessions' });

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeFocused();
  await expect(sessionsPane.locator('.chat-header-filter-chip-label')).toHaveText(
    'Needs attention'
  );

  await page.evaluate(() => {
    window.postMessage({ type: 'command/focus-input' }, '*');
  });

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeFocused();
  await expect(sessionsPane.locator('.chat-header-filter-chip-label')).toHaveText(
    'Needs attention'
  );
});
