import { expect, test } from '@playwright/test';

test('initial load uses the dark theme from the harness', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await expect(page.locator('textarea')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/\bvscode-dark\b/);
});

test('theme/update message switches body to light theme', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await expect(page.locator('textarea')).toBeVisible();

  await page.evaluate(() => {
    window.postMessage({ type: 'theme/update', payload: { theme: 'light' } }, '*');
  });

  await expect(page.locator('body')).toHaveClass(/\bvscode-light\b/);
  await expect(page.locator('body')).not.toHaveClass(/\bvscode-dark\b/);
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.vscodeThemeKind))
    .toBe('light');
});

test('theme/update message switches body to high-contrast theme', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await expect(page.locator('textarea')).toBeVisible();

  await page.evaluate(() => {
    window.postMessage(
      { type: 'theme/update', payload: { theme: 'high-contrast' } },
      '*'
    );
  });

  await expect(page.locator('body')).toHaveClass(/\bvscode-high-contrast\b/);
  await expect(page.locator('body')).not.toHaveClass(/\bvscode-dark\b/);
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.vscodeThemeKind))
    .toBe('high-contrast');
});

test('rapid consecutive theme updates settle on the final value', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await expect(page.locator('textarea')).toBeVisible();

  await page.evaluate(() => {
    window.postMessage({ type: 'theme/update', payload: { theme: 'light' } }, '*');
    window.postMessage(
      { type: 'theme/update', payload: { theme: 'high-contrast-light' } },
      '*'
    );
  });

  await expect(page.locator('body')).toHaveClass(/\bvscode-high-contrast-light\b/);
  await expect(page.locator('body')).not.toHaveClass(/\bvscode-dark\b/);
  await expect(page.locator('body')).not.toHaveClass(/\bvscode-light\b/);
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.vscodeThemeKind))
    .toBe('high-contrast-light');
});
