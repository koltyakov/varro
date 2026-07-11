import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('recycle bin entry shows sub-agent count after archiving parent', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=subagent-sessions');

  const parentRow = page.locator('.session-item').filter({ hasText: 'Parent orchestration' });
  await parentRow.hover();
  await parentRow.getByTitle('Move to Recycle Bin').click();

  await page.getByLabel('Expand Recycle Bin').click();
  const recycleRow = page.locator('.recycle-bin-item').filter({ hasText: 'Parent orchestration' });
  await expect(recycleRow).toBeVisible();
  await expect(recycleRow).toContainText('2 sub-agents');
});

test('restoring a parent session from recycle bin also restores children', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=subagent-sessions');

  const parentRow = page.locator('.session-item').filter({ hasText: 'Parent orchestration' });
  await parentRow.hover();
  await parentRow.getByTitle('Move to Recycle Bin').click();

  await page.getByLabel('Expand Recycle Bin').click();
  const recycleRow = page.locator('.recycle-bin-item').filter({ hasText: 'Parent orchestration' });
  await expect(recycleRow).toBeVisible();
  await recycleRow.getByRole('button', { name: 'Restore' }).click();

  await expect(page.locator('.recycle-bin-item')).toHaveCount(0);

  const restoredParent = page.locator('.session-item').filter({ hasText: 'Parent orchestration' });
  await expect(restoredParent).toBeVisible();

  await restoredParent.hover();
  await page.getByRole('button', { name: 'Show 2 sub-agent sessions' }).click();
  await expect(page.locator('.session-item-title')).toContainText([
    'Update tests',
    'Inspect API routes',
  ]);
});

test('permanently deleting a parent from recycle bin removes the entire tree', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=subagent-sessions');

  const parentRow = page.locator('.session-item').filter({ hasText: 'Parent orchestration' });
  await parentRow.hover();
  await parentRow.getByTitle('Move to Recycle Bin').click();

  await page.getByLabel('Expand Recycle Bin').click();
  const recycleRow = page.locator('.recycle-bin-item').filter({ hasText: 'Parent orchestration' });
  await expect(recycleRow).toBeVisible();
  await recycleRow.getByRole('button', { name: 'Delete permanently' }).click();

  await expect(page.locator('.recycle-bin-item')).toHaveCount(0);

  const deleteRequest = await getE2EState(page, () => {
    const value = (
      window as Window & {
        __varroE2E?: { requests: Array<{ method: string; path: string }> };
      }
    ).__varroE2E;
    return (
      value?.requests.find(
        (request) =>
          request.method === 'DELETE' &&
          request.path === '/varro/session-trash/session-parent/delete'
      ) || null
    );
  });

  expect(deleteRequest).toMatchObject({
    method: 'DELETE',
    path: '/varro/session-trash/session-parent/delete',
  });
});
