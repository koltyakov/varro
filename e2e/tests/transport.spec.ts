import { expect, test } from '@playwright/test';

test('shows the degraded transport banner while keeping chat usable', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=transport-degraded');

  await expect(page.getByRole('status').filter({ hasText: 'Live updates are reconnecting' })).toBeVisible();
  await expect(page.locator('textarea')).toBeVisible();
  await expect(page.locator('textarea')).toBeEditable();
});
