import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('shows the missing-cli error state and opens install docs', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-missing-cli');

  await expect(page.getByText('OpenCode is not installed', { exact: true })).toBeVisible();
  await expect(page.getByText('npm i -g opencode-ai', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Learn more at opencode.ai' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: { externalUrls?: string[] };
        }).__varroE2E;
        return value?.externalUrls?.[0] || null;
      })
    )
    .toBe('https://opencode.ai');
});

test('shows a generic startup error message', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-generic');

  await expect(page.getByText('OpenCode could not start', { exact: true })).toBeVisible();
  await expect(page.getByText('Failed to bind local server port', { exact: true })).toBeVisible();
});
