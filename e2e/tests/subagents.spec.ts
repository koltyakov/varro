import { expect, test } from '@playwright/test';

test('opens the subagent session list from a parent session', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=subagent-sessions');

  await page.getByTitle('Back to sessions').click();
  await page.locator('.session-item').filter({ hasText: 'Parent orchestration' }).hover();
  await page.getByRole('button', { name: 'Show 2 sub-agent sessions' }).click();
  await expect(page.getByText('Viewing:', { exact: true })).toBeVisible();
  await expect(page.getByText('Sub-agents', { exact: true })).toBeVisible();
  await expect(page.locator('.session-item-title')).toContainText(['Update tests', 'Inspect API routes']);
});
