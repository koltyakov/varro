import { expect, test } from '@playwright/test';

test('a deferred provider refresh does not block the composer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.pressSequentially('Send while refresh is deferred', { delay: 10 });

  // Active agents can defer a provider refresh. Existing routes remain usable.
  await page.evaluate(() => {
    window.postMessage({ type: 'providers/status', payload: { pending: true } }, '*');
  });

  await expect(page.locator('.chat-send-button')).toBeEnabled();

  expect(errors).toEqual([]);
});

test('a deferred provider refresh still changes Stop to Add to queue', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=busy-stop-send');
  await page.evaluate(() => {
    window.postMessage({ type: 'providers/status', payload: { pending: true } }, '*');
  });

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Queue while refresh is deferred');

  await expect(page.getByLabel('Stop')).toBeHidden();
  await expect(page.getByLabel('Add to queue (Enter)')).toBeEnabled();
});
