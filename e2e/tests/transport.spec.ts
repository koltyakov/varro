import { expect, test } from '@playwright/test';

test('shows the degraded transport banner while keeping chat usable', async ({ page }) => {
  await page.clock.install();
  await page.goto('/e2e/harness/index.html?scenario=transport-degraded');
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeEditable();
  await page.clock.fastForward(10_000);

  await expect(page.getByRole('status').filter({ hasText: 'Live updates are reconnecting' })).toBeVisible();
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
});

test('clears the reconnect banner after live updates recover for an active session', async ({ page }) => {
  await page.clock.install();
  await page.goto('/e2e/harness/index.html?scenario=restored-session');

  await expect(page.getByTitle('Back to sessions').locator('..').getByText('Restored Session')).toBeVisible();

  const banner = page.getByRole('status').filter({ hasText: 'Live updates are reconnecting' });
  await expect(banner).toHaveCount(0);

  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'server/status',
        payload: { state: 'running', url: 'mock://opencode', eventStream: 'degraded' },
      },
      '*'
    );
  });

  await page.clock.fastForward(10_000);
  await expect(banner).toBeVisible();
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeEditable();

  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'server/status',
        payload: { state: 'running', url: 'mock://opencode', eventStream: 'healthy' },
      },
      '*'
    );
  });

  await expect(banner).toBeVisible();
  await page.clock.fastForward(2_000);
  await expect(banner).toHaveCount(0);
  await expect(
    page.getByText('Refactor status looks good. The latest cleanup is ready for review.', {
      exact: true,
    })
  ).toBeVisible();
});

test('keeps the active session visible through a maintenance reconnect cycle', async ({ page }) => {
  await page.clock.install();
  await page.goto('/e2e/harness/index.html?scenario=maintenance-reconnect');

  await expect(
    page.getByTitle('Back to sessions').locator('..').getByText('Maintenance reconnect')
  ).toBeVisible();
  await expect(
    page.getByText('The previous response should stay visible while the stream reconnects.', {
      exact: true,
    })
  ).toBeVisible();

  const banner = page.getByRole('status').filter({ hasText: 'Live updates are reconnecting' });
  await page.clock.fastForward(2_000);
  await expect(banner).toHaveCount(0);
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeEditable();

  await expect(
    page.getByText('The previous response should stay visible while the stream reconnects.', {
      exact: true,
    })
  ).toBeVisible();
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeEditable();
});

test('preserves composer input through a maintenance reconnect cycle', async ({ page }) => {
  await page.clock.install();
  await page.goto('/e2e/harness/index.html?scenario=maintenance-reconnect');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Keep this draft while transport reconnects');

  const banner = page.getByRole('status').filter({ hasText: 'Live updates are reconnecting' });
  await page.clock.fastForward(2_000);
  await expect(banner).toHaveCount(0);

  await expect(composer).toHaveText('Keep this draft while transport reconnects');
  await expect(composer).toBeEditable();
});
