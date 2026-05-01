import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('slash /export sends session/export message for active session', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=restored-session');

  const composer = page.locator('textarea');
  await composer.click();
  await composer.fill('/export');
  await expect(page.getByText('Export the current session')).toBeVisible();
  await page.keyboard.press('Enter');

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: { exportSessionIds?: string[] };
        }).__varroE2E;
        return value?.exportSessionIds?.[0] || null;
      })
    )
    .toBe('session-restored');
});

test('/export does nothing when no session is active', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const composer = page.locator('textarea');
  await composer.click();
  await composer.fill('/export');
  await expect(page.getByText('Export the current session')).toBeVisible();
  await page.keyboard.press('Enter');

  const exportCount = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { exportSessionIds?: string[] };
    }).__varroE2E;
    return value?.exportSessionIds?.length || 0;
  });

  expect(exportCount).toBe(0);
});

test('/export sends correct session after switching sessions', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=status-filters');

  const composer = page.locator('textarea');
  await composer.click();
  await composer.fill('/export');
  await expect(page.getByText('Export the current session')).toBeVisible();
  await page.keyboard.press('Enter');

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: { exportSessionIds?: string[] };
        }).__varroE2E;
        return value?.exportSessionIds?.[0] || null;
      })
    )
    .toBe('session-completed');
});
