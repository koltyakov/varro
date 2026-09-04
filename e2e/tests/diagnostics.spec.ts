import { expect, test } from '@playwright/test';
import { renderAboutHtml } from '../../src/extension/about-view';
import { diagnosticTimeline } from '../../src/extension/diagnostics';

test('About diagnostics preview follows path selection and waits for export acknowledgement', async ({ page }) => {
  const snapshot = '# Varro\nBinary: `/Users/alex/opencode`\napi_key=secret';
  const html = renderAboutHtml({
    name: 'Varro', description: 'OpenCode workbench', logoUri: '', varroVersion: '0.28.9',
    cliVersion: '1.18.4', installMethod: 'bun', binary: '/Users/alex/opencode',
    serverVersion: '1.18.4', serverUrl: 'http://localhost:4096', ownership: 'Managed by Varro',
    serverStatus: 'Running', healthy: true, activeAgents: '0', autoUpdate: true,
    vscodeVersion: '1.120.0', nodeVersion: '24.20.0', platform: 'darwin arm64',
    diagnostics: diagnosticTimeline.export(snapshot), diagnosticsWithPaths: diagnosticTimeline.export(snapshot, false),
  }, 'http://127.0.0.1:4174');
  await page.addInitScript(() => {
    Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: (message: { action: string; includePaths: boolean }) => {
      document.body.dataset.diagnosticAction = JSON.stringify(message);
    } }) });
  });
  await page.route('**/diagnostics-preview', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('/diagnostics-preview');
  await page.getByText('Preview diagnostics', { exact: true }).click();
  const preview = page.locator('#diagnostics-preview');
  await expect(preview).toContainText('[local path]');
  await expect(preview).not.toContainText('secret');
  await page.getByLabel('Include local paths').check();
  await expect(preview).toContainText('/Users/alex/opencode');
  await page.getByRole('button', { name: 'Copy diagnostics' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-diagnostic-action', JSON.stringify({ action: 'copyDiagnostics', includePaths: true }));
  await expect(page.locator('#diagnostics-result')).toBeEmpty();
  await page.evaluate(() => window.postMessage({ type: 'diagnostics-result', text: 'Copied' }, window.location.origin));
  await expect(page.getByRole('status')).toHaveText('Copied');
  await page.getByLabel('Include local paths').uncheck();
  await page.getByRole('button', { name: 'Save diagnostics' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-diagnostic-action', JSON.stringify({ action: 'saveDiagnostics', includePaths: false }));
});
