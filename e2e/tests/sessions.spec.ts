import { expect, test } from '@playwright/test';

test('restores a persisted active session', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=restored-session');

  await expect(page.getByTitle('Back to sessions').locator('..').getByText('Restored Session')).toBeVisible();
  await expect(page.getByText('Review the refactor status', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Refactor status looks good. The latest cleanup is ready for review.', {
      exact: true,
    })
  ).toBeVisible();
});

test('filters sessions by running, failed, attention, and plan ready status', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=status-filters');

  await page.locator('.session-item').filter({ hasText: 'Completed sticky cleanup' }).click();
  await expect(
    page.getByTitle('Back to sessions').locator('..').getByText('Completed sticky cleanup')
  ).toBeVisible();
  await page.getByTitle('Back to sessions').click();
  await expect(page.getByText('Sessions', { exact: false })).toBeVisible();

  const visibleSessionTitles = page.locator('.session-item:visible .session-item-title');
  await expect(visibleSessionTitles).toHaveText([
    'Completed sticky cleanup',
    'Plan awaiting implementation',
    'Waiting on permission',
    'Failing provider sync',
    'Running lint repair',
  ]);

  await page.getByRole('button', { name: '1 running session' }).click();
  await expect(page.getByText('Filtered:')).toBeVisible();
  await expect(page.getByText('Running', { exact: true })).toBeVisible();
  await expect(page.locator('.session-item:visible .session-item-title')).toHaveText([
    'Running lint repair',
  ]);
  await expect(page.locator('.session-item')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear Running filter' }).click();
  await expect(page.getByRole('button', { name: 'Failed sessions' })).toBeVisible();

  await page.getByRole('button', { name: 'Failed sessions' }).click();
  await expect(page.getByText('Failed', { exact: true })).toBeVisible();
  await expect(page.locator('.session-item:visible .session-item-title')).toHaveText([
    'Failing provider sync',
  ]);
  await expect(page.locator('.session-item')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear Failed filter' }).click();
  await expect(page.getByRole('button', { name: 'Sessions waiting for input or permission' })).toBeVisible();

  await page.getByRole('button', { name: 'Sessions waiting for input or permission' }).click();
  await expect(page.getByText('Needs attention', { exact: true })).toBeVisible();
  await expect(page.locator('.session-item:visible .session-item-title')).toHaveText([
    'Waiting on permission',
  ]);
  await expect(page.locator('.session-item')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear Needs attention filter' }).click();
  await expect(page.getByRole('button', { name: 'Completed plans ready in another chat' })).toBeVisible();

  await page.getByRole('button', { name: 'Completed plans ready in another chat' }).click();
  await expect(page.getByText('Plan ready', { exact: true })).toBeVisible();
  await expect(page.locator('.session-item:visible .session-item-title')).toHaveText([
    'Plan awaiting implementation',
  ]);
  await expect(page.locator('.session-item')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear Plan ready filter' }).click();
  await expect(page.getByRole('button', { name: 'Completed sessions' })).toHaveCount(0);
});
