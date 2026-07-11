import { expect, test, type Locator } from '@playwright/test';
import { getE2EState } from './helpers';

async function moveToRecycleBin(row: Locator) {
  await row.getByRole('button', { name: 'Session actions' }).click();
  await row.getByRole('menuitem', { name: 'Move to Recycle Bin' }).click();
}

test('archives an overflow completed session', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=archive-overflow');

  const firstRow = page.locator('.session-item').filter({ hasText: 'Archive candidate 1' });
  await moveToRecycleBin(firstRow);

  const deleteCount = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ method: string; path: string }> };
    }).__varroE2E;
    return value?.requests.filter((request) => request.method === 'DELETE' && request.path.startsWith('/session/')).length || 0;
  });

  expect(deleteCount).toBeGreaterThan(0);
  await expect(page.locator('.session-item-title')).not.toContainText(['Archive candidate 1']);
  await expect
    .poll(() => page.locator('.session-item').count())
    .toBeLessThan(6);
});

test('restores a recycle-bin session back into the list', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=row-archive');

  const row = page.locator('.session-item').filter({ hasText: 'Archive row target' });
  await moveToRecycleBin(row);

  await expect(page.locator('.session-item-title')).not.toContainText(['Archive row target']);

  await page.getByLabel('Expand Recycle Bin').click();
  const recycleRow = page.locator('.recycle-bin-item').filter({ hasText: 'Archive row target' });
  await expect(recycleRow).toBeVisible();
  await recycleRow.getByRole('button', { name: 'Restore' }).click();

  await expect(page.locator('.recycle-bin-item').filter({ hasText: 'Archive row target' })).toHaveCount(0);

  const restoreRequest = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ method: string; path: string }> };
    }).__varroE2E;
    return (
      value?.requests.find(
        (request) =>
          request.method === 'POST' && request.path === '/varro/session-trash/session-row-archive-a/restore'
      ) || null
    );
  });

  expect(restoreRequest).toMatchObject({
    method: 'POST',
    path: '/varro/session-trash/session-row-archive-a/restore',
  });
});

test('permanently deletes a recycle-bin session', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=row-archive');

  const row = page.locator('.session-item').filter({ hasText: 'Archive row target' });
  await moveToRecycleBin(row);

  await page.getByLabel('Expand Recycle Bin').click();
  const recycleRow = page.locator('.recycle-bin-item').filter({ hasText: 'Archive row target' });
  await expect(recycleRow).toBeVisible();
  await recycleRow.getByRole('button', { name: 'Delete permanently' }).click();

  await expect(page.locator('.recycle-bin-item').filter({ hasText: 'Archive row target' })).toHaveCount(0);
  await expect(page.locator('.session-item-title')).not.toContainText(['Archive row target']);

  const deleteRequest = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ method: string; path: string }> };
    }).__varroE2E;
    return (
      value?.requests.find(
        (request) =>
          request.method === 'DELETE' && request.path === '/varro/session-trash/session-row-archive-a/delete'
      ) || null
    );
  });

  expect(deleteRequest).toMatchObject({
    method: 'DELETE',
    path: '/varro/session-trash/session-row-archive-a/delete',
  });
});

test('empties the recycle bin from the grouped sessions view', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=row-archive');

  const row = page.locator('.session-item').filter({ hasText: 'Archive row target' });
  await moveToRecycleBin(row);

  await page.getByLabel('Expand Recycle Bin').click();
  await expect(page.locator('.recycle-bin-item')).toHaveCount(1);
  await page.getByLabel('Empty Recycle Bin').click();
  await page.getByRole('button', { name: 'Confirm empty Recycle Bin' }).click();
  await expect(page.locator('.recycle-bin-item')).toHaveCount(0);

  const emptyRequest = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ method: string; path: string }> };
    }).__varroE2E;
    return value?.requests.find((request) => request.method === 'DELETE' && request.path === '/varro/session-trash') || null;
  });

  expect(emptyRequest).toMatchObject({
    method: 'DELETE',
    path: '/varro/session-trash',
  });
});
