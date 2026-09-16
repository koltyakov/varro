import { expect, test } from '@playwright/test';
import { renderAboutHtml } from '../../src/extension/about-view';

test('About copies diagnostics without local paths and waits for export acknowledgement', async ({
  page,
}) => {
  const html = renderAboutHtml(
    {
      name: 'Varro',
      description: 'OpenCode workbench',
      logoUri: '',
      varroVersion: '0.28.9',
      cliVersion: '1.18.4',
      installMethod: 'bun',
      binary: '/Users/alex/opencode',
      serverVersion: '1.18.4',
      serverUrl: 'http://localhost:4096',
      ownership: 'Managed by Varro',
      serverStatus: 'Running',
      healthy: true,
      activeAgents: '0',
      autoUpdate: true,
      vscodeVersion: '1.120.0',
      nodeVersion: '24.21.0',
      platform: 'darwin arm64',
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
