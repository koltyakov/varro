import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('full access mode sends a bash request without showing a permission prompt', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=full-access');

  await expect(page.getByRole('button', { name: 'Full access permissions' })).toBeVisible();

  const composer = page.locator('textarea');
  await composer.fill('In full access mode, get opencode version using bash by running opencode --version.');
  await page.getByTitle('Send (Enter)').click();

  await expect(page.getByText('Permission Required')).toHaveCount(0);
  await expect(page.locator('.chat-turn-user').last()).toContainText('get opencode version');

  const promptCount = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ path: string }> };
    }).__varroE2E;
    return value?.requests.filter((request) => request.path.endsWith('/prompt_async')).length || 0;
  });

  expect(promptCount).toBe(1);
});

test('restores full access mode after reload', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=full-access');

  await expect(page.getByRole('button', { name: 'Full access permissions' })).toBeVisible();
  await page.reload();

  await expect(page.getByRole('button', { name: 'Full access permissions' })).toBeVisible();
  await expect(page.locator('textarea')).toBeVisible();
});
