/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: This E2E callback invokes the provider hook installed by the controlled harness fixture. */
import { expect, test } from '@playwright/test';

test('shows usage-limit retry state and lets the user switch providers', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=usage-limit');

  await expect(page.getByText('Usage limit reached', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-usage-limit-meta')).toContainText('messages exhausted');
  await expect(page.locator('.chat-usage-limit-message')).toContainText('429 usage limit reached');
  await expect(page.locator('.toolbar-limit-chip')).toContainText('0%');

  await page.getByRole('button', { name: 'Switch provider' }).click();
  await expect(page.getByText('OpenAI', { exact: true })).toBeVisible();
  await expect(page.getByText('OpenCode Go', { exact: true })).toBeVisible();
  await expect(page.getByText('Go Plan', { exact: true })).toBeVisible();
  await expect(page.getByText('Go Build', { exact: true })).toBeVisible();
  await page.getByText('Go Plan', { exact: true }).click();

  await expect(page.getByLabel('OpenCode Go / Go Plan')).toBeVisible();
});

test('stops retrying a usage-limited session', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=usage-limit');

  await page.getByRole('button', { name: 'Stop retrying' }).click();

  const abortRequest = await page.evaluate(() => {
    const value = (
      window as Window & {
        __varroE2E?: { requests: Array<{ method: string; path: string }> };
      }
    ).__varroE2E;
    return (
      value?.requests.find(
        (request) => request.method === 'POST' && request.path.endsWith('/abort')
      ) || null
    );
  });

  expect(abortRequest).toMatchObject({ method: 'POST' });
});

test('keeps the manually selected provider model as the default after reload', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=usage-limit');

  await page.getByRole('button', { name: 'Switch provider' }).click();
  await page.getByText('Go Plan', { exact: true }).click();
  await expect(page.getByLabel('OpenCode Go / Go Plan')).toBeVisible();

  await page.reload();

  await expect(page.getByLabel('OpenCode Go / Go Plan')).toBeVisible();
});

test('supports escape in the provider switcher', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=usage-limit');

  await page.getByRole('button', { name: 'Switch provider' }).click();
  await expect(page.getByText('Go Plan', { exact: true })).toBeVisible();
  const picker = page.locator('.dropdown-menu').first();
  await picker.press('Escape');
  await expect(page.getByText('Go Plan', { exact: true })).toHaveCount(0);
});

test('opens manage models from the picker and filters the model catalog', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
  await expect(page.getByRole('button', { name: 'Manage models', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Manage models', exact: true }).click();

  await expect(page.getByText('Models', { exact: true })).toBeVisible();
  const filter = page.getByLabel('Filter providers or models');
  await filter.fill('openai');
  await expect(page.getByText('OpenAI', { exact: true })).toBeVisible();
  await expect(page.getByText('GPT-4.1', { exact: true })).toBeVisible();
  await expect(page.getByText('GitHub Copilot', { exact: true })).toHaveCount(0);
});
