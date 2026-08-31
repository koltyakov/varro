import { expect, test } from '@playwright/test';

test('uses duty-cycled animations only for persistent session statuses', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=status-filters');

  const statusIndicator = (title: string) =>
    page.locator('.session-item').filter({ hasText: title }).locator('.session-item-indicator');

  for (const title of [
    'Plan awaiting implementation',
    'Waiting on permission',
    'Failing provider sync',
  ]) {
    await expect(statusIndicator(title)).toHaveCSS('animation-name', 'status-pulse');
    await expect(statusIndicator(title)).toHaveCSS('animation-duration', '2s');
  }

  await expect(statusIndicator('Running lint repair')).toHaveCSS('animation-name', 'spin');
  await page.locator('body').evaluate((body) => {
    const indicator = document.createElement('span');
    indicator.className = 'session-item-indicator session-status-indicator is-completed';
    indicator.dataset.testCompletedIndicator = 'true';
    body.append(indicator);
  });
  await expect(page.locator('[data-test-completed-indicator]')).toHaveCSS('animation-name', 'none');

  for (const selector of [
    '.chat-header-plan-dot',
    '.chat-header-attention-dot',
    '.chat-header-failed-dot',
  ]) {
    await expect(page.locator(selector)).toHaveCSS('animation-name', 'status-pulse');
  }
  await expect(page.locator('.chat-header-running-spinner')).toHaveCSS('animation-name', 'spin');
});

test('keeps persistent statuses static and visible with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/e2e/harness/index.html?scenario=status-filters');

  const indicator = page
    .locator('.session-item')
    .filter({ hasText: 'Waiting on permission' })
    .locator('.session-item-indicator');

  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveAttribute('aria-label', 'Permission request pending');
  await expect(indicator).toHaveCSS('animation-iteration-count', '1');
  await expect(indicator).toHaveCSS('opacity', '1');
});

test('restores a persisted active session', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=restored-session');

  await expect(
    page.getByLabel('Back to sessions').locator('..').getByText('Restored Session')
  ).toBeVisible();
  await expect(page.getByText('Review the refactor status', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Refactor status looks good. The latest cleanup is ready for review.', {
      exact: true,
    })
  ).toBeVisible();
});

test('shows queued message counts in the desktop session list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=todo-queue');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Queue this follow-up');
  await page.getByLabel('Add to queue (Enter)').click();

  const sessionRow = page.locator('.session-item').filter({ hasText: 'Queued follow-up coverage' });
  await expect(sessionRow.getByLabel('1 queued message')).toBeVisible();

  await page.getByLabel('Remove from queue').focus();
  await page.keyboard.press('Enter');
  await expect(sessionRow.locator('.session-item-queued-counter')).toHaveCount(0);
});

test('centers the session history scope in the desktop search field', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=todo-queue');

  const sessionsPane = page.getByRole('complementary', { name: 'Sessions' });
  const search = sessionsPane.getByLabel('Search sessions');
  const scope = sessionsPane.getByLabel('Session history: Folder');
  await expect(scope).toBeVisible();

  const centers = await Promise.all([
    search.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    }),
    scope.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    }),
  ]);
  expect(Math.abs(centers[0] - centers[1])).toBeLessThanOrEqual(1);
});

test('filters sessions by running, failed, attention, and plan ready status', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=status-filters');

  await page.locator('.session-item').filter({ hasText: 'Completed sticky cleanup' }).click();
  await expect(
    page.getByLabel('Back to sessions').locator('..').getByText('Completed sticky cleanup')
  ).toBeVisible();
  await page.getByLabel('Back to sessions').click();
  await expect(page.getByText('Sessions', { exact: false })).toBeVisible();

  const visibleSessionTitles = page.locator('.session-item:visible .session-item-title-text');
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
  await expect(page.locator('.session-item:visible .session-item-title-text')).toHaveText([
    'Waiting on permission',
    'Running lint repair',
  ]);
  await expect(page.locator('.session-item')).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear Running filter' }).click();
  await expect(page.getByRole('button', { name: 'Failed sessions' })).toBeVisible();

  await page.getByRole('button', { name: 'Failed sessions' }).click();
  await expect(page.getByText('Failed', { exact: true })).toBeVisible();
  await expect(page.locator('.session-item:visible .session-item-title-text')).toHaveText([
    'Failing provider sync',
  ]);
  await expect(page.locator('.session-item')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear Failed filter' }).click();
  await expect(
    page.getByRole('button', { name: 'Sessions waiting for input or permission' })
  ).toBeVisible();

  await page.getByRole('button', { name: 'Sessions waiting for input or permission' }).click();
  await expect(page.getByText('Needs attention', { exact: true })).toBeVisible();
  await expect(page.locator('.session-item:visible .session-item-title-text')).toHaveText([
    'Waiting on permission',
  ]);
  await expect(page.locator('.session-item')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear Needs attention filter' }).click();
  await expect(
    page.getByRole('button', { name: 'Completed plans ready in another chat' })
  ).toBeVisible();

  await page.getByRole('button', { name: 'Completed plans ready in another chat' }).click();
  await expect(page.getByText('Plan ready', { exact: true })).toBeVisible();
  await expect(page.locator('.session-item:visible .session-item-title-text')).toHaveText([
    'Plan awaiting implementation',
  ]);
  await expect(page.locator('.session-item')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear Plan ready filter' }).click();
  await expect(page.getByRole('button', { name: 'Completed sessions' })).toHaveCount(0);
});
