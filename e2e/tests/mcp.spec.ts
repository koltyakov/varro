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

for (const width of [390, 1050]) {
  test(`opens a separate MCP settings screen at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto('/e2e/harness/index.html?scenario=mcp-pickers');
    const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
    await composer.fill('Keep this draft');
    const mcpButton = page.getByRole('button', { name: /MCPs? enabled/i });
    await mcpButton.click();
    const popup = page.locator('.dropdown-menu');
    await expect(popup.locator('select')).toHaveCount(0);
    await expect(popup.getByRole('button')).toHaveCount(5);
    await popup.getByRole('button', { name: 'Manage MCPs', exact: true }).click();
    const settings = page.getByRole('region', { name: 'MCP settings', exact: true });
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('heading', { name: 'This session', exact: true })).toHaveCount(
      0
    );
    await expect(settings).not.toContainText('Connections are shared');
    await expect(mcpButton).not.toBeVisible();
    await expect(popup).toHaveCount(0);
    await expect(settings.locator('select')).toHaveCount(0);
    const projectTab = settings.getByRole('tab', { name: 'This project', exact: true });
    const globalTab = settings.getByRole('tab', { name: 'Global', exact: true });
    const server = settings.getByRole('checkbox', { name: 'playwright', exact: true });
    const useGlobal = settings.getByRole('button', {
      name: 'Use global setting for playwright',
      exact: true,
    });
    await expect(globalTab).toHaveAttribute('aria-selected', 'true');
    await expect(server).not.toBeChecked();
    await server.check();
    await expect(server).toBeEnabled();
    await expect(server).toBeChecked();
    await projectTab.click();
    await expect(server).toBeChecked();
    await expect(useGlobal).toHaveCount(0);
    await server.uncheck();
    await expect(server).toBeEnabled();
    await expect(server).not.toBeChecked();
    await expect(useGlobal).toBeVisible();
    await globalTab.click();
    await expect(server).toBeChecked();
    await expect(settings).toContainText('Off in this project');
    await projectTab.click();
    expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    );
    await page.screenshot({ path: testInfo.outputPath('mcp-settings.png') });
    await useGlobal.click();
    await expect(useGlobal).toHaveCount(0);
    await expect(server).toBeChecked();
    await settings.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(settings).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveText('Keep this draft');
    await mcpButton.click();
    await popup.getByRole('button', { name: 'Manage MCPs', exact: true }).click();
    await expect(settings).toBeVisible();
    await settings.getByRole('heading', { name: 'MCP settings', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
    await expect(mcpButton).toBeVisible();
    await expect(composer).toBeFocused();
  });
}
