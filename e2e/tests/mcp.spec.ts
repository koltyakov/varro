/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: This E2E callback updates protocol-shaped MCP state owned by the controlled harness fixture. */
import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

for (const scope of ['Global', 'This project'] as const) {
  test(`adds MCP JSON to ${scope} from the empty-state management screen`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 850 });
    await page.goto('/e2e/harness/index.html?scenario=mcp-pickers&mcpEmpty=1');
    const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
    await composer.fill(scope === 'Global' ? '/mcp' : '/mcps');
    await composer.press('Enter');
    const settings = page.getByRole('region', { name: 'MCP settings', exact: true });
    await expect(settings).toBeVisible();
    await expect(settings).toContainText('No MCP servers configured.');
    await expect(settings.getByRole('textbox', { name: 'MCP JSON', exact: true })).toHaveAttribute(
      'placeholder',
      /\n  "browser-bridge": \{/
    );
    await expect(page.locator('.dropdown-menu')).toHaveCount(0);
    await settings.getByRole('tab', { name: scope, exact: true }).click();
    await settings.getByRole('button', { name: 'Open OpenCode config', exact: true }).click();
    const json =
      scope === 'Global'
        ? '{"url":"https://example.com/mcp"}'
        : '{"mcpServers":{"docs":{"command":"npx","args":["-y","docs-mcp"]}}}';
    await settings.getByRole('textbox', { name: 'MCP JSON', exact: true }).fill(json);
    if (scope === 'Global') {
      await expect(
        settings.getByRole('button', { name: 'Add MCP servers', exact: true })
      ).toBeDisabled();
      await settings.getByRole('textbox', { name: 'Server name', exact: true }).fill('docs');
    }
    await expect(settings).toContainText(`Detected servers: docs. Add to ${scope}.`);
    await settings.getByRole('button', { name: 'Add MCP servers', exact: true }).click();
    await expect(settings).toContainText(`Added docs to ${scope}.`);
    await expect(settings.getByRole('checkbox', { name: 'docs', exact: true })).toBeChecked();
    await expect(settings.getByRole('textbox', { name: 'MCP JSON', exact: true })).toBeEmpty();
    const requests = await getE2EState(
      page,
      () =>
        (
          window as Window & {
            __varroE2E?: { requests: Array<{ path: string; body?: unknown }> };
          }
        ).__varroE2E?.requests.filter((request) => request.path.startsWith('/varro/mcp-config')) ??
        []
    );
    const importBody =
      scope === 'Global' ? { scope: 'global', json, name: 'docs' } : { scope: 'project', json };
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/varro/mcp-config/open',
        body: { scope: scope === 'Global' ? 'global' : 'project' },
      },
      {
        method: 'POST',
        path: '/varro/mcp-config',
        body: importBody,
      },
    ]);
    expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    );
    await page.screenshot({ path: testInfo.outputPath('mcp-json-import.png') });
  });
}

for (const [width, command] of [
  [390, '/mcp'],
  [500, '/mcps'],
] as const) {
  test(`${command} keeps sign-in usable with long errors at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto('/e2e/harness/index.html?scenario=mcp-pickers&mcpAuth=1');
    const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
    await composer.fill(`${command} at`);
    await composer.press('Enter');
    const picker = page.locator('.dropdown-menu');
    await expect(picker).toBeVisible();
    await expect(composer).toBeEmpty();
    await expect(picker.getByRole('textbox', { name: 'Search MCPs' })).toHaveValue('at');
    await expect(picker.locator('.dropdown-name')).toHaveText('atlassian');
    const server = picker.getByRole('button', { name: 'atlassian Sign in', exact: true });
    await expect(server.locator('.mcp-picker-action')).toHaveText('Sign in');
    await expect(server.locator('.mcp-status-tag')).toHaveCount(0);
    await expect(server.locator('.mcp-picker-error')).toHaveCount(0);
    const geometry = await server.evaluate((element) => {
      const name = element.querySelector('.dropdown-name')!;
      const bounds = element.getBoundingClientRect();
      const nameBounds = name.getBoundingClientRect();
      return {
        overflows: element.scrollWidth > element.clientWidth,
        nameWidth: nameBounds.width,
        nameInside: nameBounds.left >= bounds.left && nameBounds.right <= bounds.right,
      };
    });
    expect(geometry.overflows).toBe(false);
    expect(geometry.nameWidth).toBeGreaterThan(40);
    expect(geometry.nameInside).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('mcp-sign-in-picker.png') });
    await server.click();
    const dialog = page.getByRole('dialog', { name: 'Authorize MCP server' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('updates automatically');
    await dialog.locator('summary').click();
    const code = dialog.getByRole('textbox', { name: 'Authorization code' });
    await code.click();
    await code.fill('test-oauth-code');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(picker).toBeVisible();
    await server.click();
    await dialog.locator('summary').click();
    await code.fill('test-oauth-code');
    await dialog.getByRole('button', { name: 'Complete authorization', exact: true }).click();
    await expect(dialog).toContainText('Authorization successful');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('button', { name: /atlassian connected/ })).toBeVisible();
    await expect(page.locator('.user-message-card')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await page.getByRole('button', { name: /MCPs? enabled/i }).click();
    await expect(picker.locator('.dropdown-name')).toHaveCount(3);
  });
}

test('opens the MCP picker and syncs connection requests', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=mcp-pickers');

  await page.getByRole('button', { name: /MCPs? enabled/i }).click();

  await expect(page.getByText('chrome', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'figma Sign in', exact: true })).toBeVisible();
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

test('recognizes a completed browser callback without asking for an authorization code', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await page.goto('/e2e/harness/index.html?scenario=mcp-pickers&mcpAuth=1');
  const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
  await composer.fill('/mcps at');
  await composer.press('Enter');
  await page.getByRole('button', { name: 'atlassian Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Authorize MCP server' });
  await expect(dialog).toContainText('updates automatically');
  await expect(dialog.getByRole('textbox', { name: 'Authorization code' })).not.toBeVisible();
  await expect
    .poll(() =>
      getE2EState(
        page,
        () =>
          (window as Window & { __varroE2E?: { externalUrls: string[] } }).__varroE2E?.externalUrls
            .length ?? 0
      )
    )
    .toBe(1);
  await page.evaluate(() => {
    const harness = (
      window as Window & {
        __varroE2E?: { updateMcpStatus?: (name: string, status: { status: 'connected' }) => void };
      }
    ).__varroE2E;
    if (!harness?.updateMcpStatus) throw new Error('MCP callback fixture is unavailable');
    harness.updateMcpStatus('atlassian', { status: 'connected' });
  });
  await expect(dialog).toContainText('Authorization successful');
  await expect(dialog).toContainText('atlassian is connected');
  await expect(dialog.getByRole('textbox', { name: 'Authorization code' })).toHaveCount(0);
  expect(
    await getE2EState(
      page,
      () =>
        (
          window as Window & { __varroE2E?: { requests: Array<{ path: string }> } }
        ).__varroE2E?.requests.filter((request) => request.path.endsWith('/auth/callback')) ?? []
    )
  ).toEqual([]);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'atlassian connected', exact: true })
  ).toBeVisible();
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
