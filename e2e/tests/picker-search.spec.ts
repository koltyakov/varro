import { expect, test } from '@playwright/test';

test('filters models in the model picker and shows a no-match state', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=model-search');

  await page.getByTitle('GitHub Copilot / GPT-5 mini').click();
  const search = page.getByLabel('Search models');
  await expect(search).toBeVisible();

  await search.fill('go');
  await expect(page.getByText('OpenCode Go', { exact: true })).toBeVisible();
  await expect(page.getByText('Go Fast', { exact: true })).toBeVisible();
  await expect(page.getByText('Go Review', { exact: true })).toBeVisible();

  await search.fill('zzzz');
  await expect(page.getByText('No matching models', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.getByText('OpenAI', { exact: true })).toBeVisible();
});

test('filters MCPs in the MCP picker and shows a no-match state', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=mcp-search');

  const composer = page.locator('textarea');
  await composer.click();
  await composer.fill('/mcps');
  await page.keyboard.press('Enter');

  const search = page.getByLabel('Search MCPs');
  await expect(search).toBeVisible();

  await search.fill('sentry');
  await expect(page.getByRole('button', { name: /sentry failed token expired/i })).toBeVisible();

  await search.fill('zzzz');
  await expect(page.getByText('No matching MCPs', { exact: true })).toBeVisible();
});
