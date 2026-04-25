import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('host abort command stops the active busy session', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=abort-command');

  await expect(page.getByTitle('Stop')).toHaveCount(0);
  await expect(page.locator('textarea')).toBeVisible();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: { requests: Array<{ path: string }> };
        }).__varroE2E;
        return value?.requests.filter((request) => request.path.endsWith('/abort')).length || 0;
      })
    )
    .toBe(1);
});
