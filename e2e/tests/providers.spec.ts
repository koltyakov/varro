import { expect, test } from '@playwright/test';

test('shows usage-limit retry state and lets the user switch providers', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=usage-limit');

  await expect(page.getByText('Usage limit reached', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-usage-limit-meta')).toContainText('messages exhausted');
  await expect(page.locator('.chat-usage-limit-message')).toContainText('429 usage limit reached');
  await expect(page.locator('.toolbar-limit-chip')).toContainText('0 msg');

  await page.getByRole('button', { name: 'Switch provider' }).click();
  await expect(page.getByText('OpenAI', { exact: true })).toBeVisible();
  await expect(page.getByText('OpenCode Go', { exact: true })).toBeVisible();
  await expect(page.getByText('Go Plan', { exact: true })).toBeVisible();
  await expect(page.getByText('Go Build', { exact: true })).toBeVisible();
  await page.getByText('Go Plan', { exact: true }).click();

  await expect(page.getByTitle('OpenCode Go / Go Plan')).toBeVisible();
});

test('opens manage models from the picker and filters the settings catalog', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await page.getByTitle('GitHub Copilot / GPT-5 mini').click();
  await expect(page.getByText('Manage Models', { exact: true })).toBeVisible();
  await page.getByText('Manage Models', { exact: true }).click();

  await expect(page.getByText('Models', { exact: true })).toBeVisible();
  const filter = page.getByLabel('Filter providers or models');
  await filter.fill('openai');
  await expect(page.getByText('OpenAI', { exact: true })).toBeVisible();
  await expect(page.getByText('GPT-4.1', { exact: true })).toBeVisible();
  await expect(page.getByText('GitHub Copilot', { exact: true })).toHaveCount(0);
});
