import { expect, test } from '@playwright/test';

test('renders linked tool questions inline instead of as standalone prompts', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=linked-tool-question');

  await expect(page.getByText('Target environment', { exact: true })).toBeVisible();
  await expect(page.getByText('Which environment should I target?', { exact: true })).toBeVisible();
  await expect(page.locator('.question-prompt-card')).toHaveCount(1);
  await expect(page.locator('.tool-invocation-title')).toHaveCount(0);
});
