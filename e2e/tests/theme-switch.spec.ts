import { expect, test } from '@playwright/test';

test('initial load uses the dark theme from the harness', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/\bvscode-dark\b/);
});

test('theme=light query renders the light VSCode variables', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank&theme=light');

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/\bvscode-light\b/);

  const editorBackground = await page.evaluate(() =>
    getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim()
  );
  expect(editorBackground).toBe('#ffffff');
});

test('theme=high-contrast query renders the high-contrast VSCode variables', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank&theme=high-contrast');

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();

  const values = await page.evaluate(() => {
    const styles = getComputedStyle(document.body);
    return {
      editorBackground: styles.getPropertyValue('--vscode-editor-background').trim(),
      contrastBorder: styles.getPropertyValue('--vscode-contrastBorder').trim(),
    };
  });
  expect(values.editorBackground).toBe('#000000');
  expect(values.contrastBorder).toBe('#ffffff');
});

test('theme/update message switches body to light theme', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();

  await page.evaluate(() => {
    window.postMessage({ type: 'theme/update', payload: { theme: 'light' } }, '*');
  });

  await expect(page.locator('body')).toHaveClass(/\bvscode-light\b/);
  await expect(page.locator('body')).not.toHaveClass(/\bvscode-dark\b/);
  await expect.poll(() => page.evaluate(() => document.body.dataset.vscodeThemeKind)).toBe('light');
});
