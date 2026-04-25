import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('confirms and cancels archive actions for overflow sessions', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=archive-overflow');
  await page.getByTitle('Back to sessions').click();

  await page.getByLabel('Expand Show more').click();
  await page.getByLabel('Archive Show more').click();
  await expect(page.getByRole('button', { name: 'Confirm archive Show more' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel archive Show more' }).click();
  await expect(page.getByRole('button', { name: 'Confirm archive Show more' })).toHaveCount(0);

  await page.getByLabel('Archive Show more').click();
  await page.getByRole('button', { name: 'Confirm archive Show more' }).click();

  const deleteCount = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ method: string; path: string }> };
    }).__varroE2E;
    return value?.requests.filter((request) => request.method === 'DELETE' && request.path.startsWith('/session/')).length || 0;
  });

  expect(deleteCount).toBeGreaterThan(0);
});
