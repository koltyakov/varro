import { expect, test } from '@playwright/test';
import { renderAboutHtml } from '../../src/extension/about-view';

test('About copies diagnostics without local paths and waits for export acknowledgement', async ({
  page,
}) => {
  const data = {
    name: 'Varro',
    description: 'OpenCode workbench',
    logoUri: '',
    varroVersion: '0.28.9',
    cliVersion: '1.18.4',
    installMethod: 'bun',
    installedOn: 'Oct 1, 2026, 9:45:12 AM',
    binary: '/Users/alex/opencode',
    serverVersion: '1.18.4',
    serverUrl: 'http://localhost:4096',
    serverProcessId: '1234',
    ownership: 'Managed by Varro',
    serverStatus: 'Running',
    healthy: true,
    activeAgents: '0',
    serverStartedOn: 'Oct 1, 2026, 10:00:00 AM',
    vscodeClients: '1',
    otherClients: '0',
    databaseLocation: '/Users/alex/.local/share/opencode/opencode.db',
    databaseSize: '1.2 GB',
    databaseReusable: '300.0 MB',
    databaseAge: '9 months',
    databaseProjects: '12',
    databaseSessions: '345',
    databaseNote: 'Stored V1 and V2 records. Size includes the SQLite WAL.',
    autoUpdate: true,
    vscodeVersion: '1.120.0',
    nodeVersion: '24.21.0',
    platform: 'darwin arm64',
  };
  const html = renderAboutHtml(
    {
      ...data,
      loading: true,
      healthy: false,
      serverStatus: 'Loading server details...',
      serverProcessId: 'Loading...',
      databaseSize: 'Loading...',
      databaseReusable: 'Loading...',
      databaseAge: 'Loading...',
      databaseProjects: 'Loading...',
      databaseSessions: 'Loading...',
    },
    'http://127.0.0.1:4174'
  );
  await page.addInitScript(() => {
    Object.assign(window, {
      acquireVsCodeApi: () => ({
        postMessage: (message: { action: string; includePaths: boolean }) => {
          document.body.dataset.diagnosticAction = JSON.stringify(message);
        },
      }),
    });
  });
  await page.route('**/about-diagnostics', (route) =>
    route.fulfill({ contentType: 'text/html', body: html })
  );
  await page.goto('/about-diagnostics');
  await expect(page.locator('[data-about-field="statusLabel"]')).toHaveText('Loading details...');
  await expect(page.getByRole('heading', { name: 'OpenCode database' })).toBeVisible();
  await expect(page.locator('[data-about-field="databaseAge"]')).toHaveText('Loading...');
  await page.evaluate(
    (details) =>
      window.postMessage({ type: 'about-update', data: details }, window.location.origin),
    data
  );
  await expect(page.locator('[data-about-field="statusLabel"]')).toHaveText('System ready');
  await expect(page.locator('#server-status')).not.toHaveClass(/loading/);
  await expect(page.locator('[data-about-field="serverProcessId"]')).toHaveText('1234');
  const database = page.getByRole('region', { name: 'OpenCode database' });
  await expect(database.getByRole('heading', { name: 'OpenCode database' })).toBeVisible();
  await expect(database.locator('[data-about-field="databaseLocation"]')).toHaveText(
    '/Users/alex/.local/share/opencode/opencode.db'
  );
  await expect(database.locator('[data-about-field="databaseSize"]')).toHaveText('1.2 GB');
  await expect(database.locator('[data-about-field="databaseReusable"]')).toHaveText('300.0 MB');
  await expect(database.locator('[data-about-field="databaseAge"]')).toHaveText('9 months');
  await expect(database.getByText('History age', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Compact database...' }).click();
  await expect(page.locator('body')).toHaveAttribute(
    'data-diagnostic-action',
    JSON.stringify({ action: 'compactDatabase' })
  );
  await expect(database.locator('[data-about-field="databaseProjects"]')).toHaveText('12');
  await expect(database.locator('[data-about-field="databaseSessions"]')).toHaveText('345');
  await expect(database.locator('[data-about-field="databaseTurns"]')).toHaveCount(0);
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(database).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    ).toBe(true);
  }
  await page.getByRole('button', { name: 'Copy diagnostics' }).click();
  await expect(page.locator('body')).toHaveAttribute(
    'data-diagnostic-action',
    JSON.stringify({ action: 'copyDiagnostics', includePaths: false })
  );
  await expect(page.locator('#diagnostics-result')).toBeEmpty();
  await page.evaluate(() =>
    window.postMessage({ type: 'diagnostics-result', text: 'Copied' }, window.location.origin)
  );
  await expect(page.getByRole('status')).toHaveText('Copied');
});
