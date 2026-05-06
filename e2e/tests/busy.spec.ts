import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('busy send menu supports stop-and-send for follow-up instructions', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=busy-stop-send');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Stop and send this follow-up now.');
  await page.getByTitle('More send options').click();
  await expect(page.getByText('Stop and Send', { exact: true })).toBeVisible();
  await page.getByText('Stop and Send', { exact: true }).click();

  await expect(page.locator('.chat-turn-user').last()).toContainText('Stop and send this follow-up now.');

  const requests = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ method: string; path: string }> };
    }).__varroE2E;
    return value?.requests || [];
  });

  expect(requests.filter((request) => request.path.endsWith('/abort'))).toHaveLength(1);
  expect(requests.filter((request) => request.path.endsWith('/prompt_async'))).toHaveLength(1);
});

test('restores the active busy session after webview reload', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=busy-stop-send');

  await expect(page.getByText('Still working through the requested refactor steps.', { exact: true })).toBeVisible();

  await page.reload();

  await expect(page.getByTitle('Back to sessions').locator('..').getByText('Busy stop and send')).toBeVisible();
  await expect(page.getByText('Still working through the requested refactor steps.', { exact: true })).toBeVisible();

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Stop and send this after reload.');
  await page.getByTitle('More send options').click();
  await expect(page.getByText('Stop and Send', { exact: true })).toBeVisible();
  await page.getByText('Stop and Send', { exact: true }).click();

  await expect(page.locator('.chat-turn-user').last()).toContainText('Stop and send this after reload.');

  const requests = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ method: string; path: string }> };
    }).__varroE2E;
    return value?.requests || [];
  });

  expect(requests.filter((request) => request.path.endsWith('/abort'))).toHaveLength(1);
  expect(requests.filter((request) => request.path.endsWith('/prompt_async'))).toHaveLength(1);
});
