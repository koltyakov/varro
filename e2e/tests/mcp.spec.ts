/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: This E2E callback updates protocol-shaped MCP state owned by the controlled harness fixture. */
import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('opens the MCP picker and syncs connection requests', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=mcp-pickers');

  await page.getByRole('button', { name: /MCPs? enabled/i }).click();

  await expect(page.getByText('chrome', { exact: true })).toBeVisible();
  await expect(page.getByText('needs auth', { exact: true })).toBeVisible();
  await expect(page.getByText('cli not authenticated', { exact: false })).toBeVisible();
  const mcpList = page.locator('.model-picker-list');
  await expect(mcpList.locator('.dropdown-item').first()).toHaveCSS('border-radius', '0px');

  await mcpList.getByRole('button', { name: /github/i }).click();

  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('varro.sessionSelectedMcps')))
    .toContain('github');
  await expect(mcpList.getByRole('button', { name: /github connected/i })).toBeVisible();

  await mcpList.getByRole('button', { name: /github connected/i }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { requests: Array<{ method: string; path: string }> };
          }
        ).__varroE2E;
        return (
          value?.requests
            .filter((request) => request.path.startsWith('/mcp/github/'))
            .map((request) => `${request.method} ${request.path}`) || []
        );
      })
    )
    .toEqual(['POST /mcp/github/connect', 'POST /mcp/github/disconnect']);
});

test('restores preselected MCPs after reload', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=mcp-pickers');

  const mcpButton = page.getByRole('button', { name: /MCPs? enabled/i });
  await mcpButton.click();

  await expect(page.getByRole('button', { name: /chrome connected/i })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.reload();
  await mcpButton.click();

  await expect(page.getByRole('button', { name: /chrome connected/i })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('varro.sessionSelectedMcps')))
    .toContain('chrome');
});
