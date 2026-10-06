import { expect, test } from '@playwright/test';
import { renderWebviewHtml } from '../../src/extension/webview-html';

function renderStartupHtml(baseURL: string, scriptUri: string) {
  return renderWebviewHtml(
    baseURL,
    {
      theme: 'dark',
      serverStatus: { state: 'stopped' },
      editorContext: {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
      terminalSelection: null,
      droppedFiles: [],
      emptyStateLogoUri: `${baseURL}/assets/icon.png`,
      chatFontSize: 13,
      chatEditorFontSize: 12,
      chatFontFamily: 'default',
    },
    {
      scriptUri,
      cssUri: `${baseURL}/src/webview/styles/messages.css`,
      version: 'logo-preload-test',
    }
  );
}

test('loads the chat logo while the webview app module is still pending', async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error('The webview test server URL is missing');
  let releaseScript: (() => void) | undefined;
  const scriptReady = new Promise<void>((resolve) => {
    releaseScript = resolve;
  });
  let logoRequested = false;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/assets/icon.png') logoRequested = true;
  });
  await page.addInitScript(`window.acquireVsCodeApi = () => ({
    postMessage() {}, getState() { return {}; }, setState() {}
  });`);
  await page.route('**/logo-preload-app.mjs*', async (route) => {
    await scriptReady;
    await route.fulfill({ contentType: 'text/javascript', body: 'export {};' });
  });
  await page.route('**/logo-preload.html', async (route) => {
    const html = renderStartupHtml(baseURL, `${baseURL}/logo-preload-app.mjs`);
    await route.fulfill({ contentType: 'text/html', body: html });
  });

  try {
    await page.goto(`${baseURL}/logo-preload.html`, { waitUntil: 'commit' });
    await expect.poll(() => logoRequested, { timeout: 5_000 }).toBe(true);
    const logo = page.locator('.varro-startup-logo');
    await expect(logo).toBeVisible({ timeout: 5_000 });
    await expect(logo).toHaveCSS('animation-name', 'varro-startup-logo-pulse');
    await expect(page.locator('.varro-startup-dots')).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(logo).toHaveCSS('animation-name', 'none');
  } finally {
    releaseScript?.();
  }
});

test('startup shows the animated logo, loading, and restored content in order', async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error('The webview test server URL is missing');
  let releaseScript: (() => void) | undefined;
  const scriptReady = new Promise<void>((resolve) => {
    releaseScript = resolve;
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(`window.acquireVsCodeApi = () => ({
    postMessage() {}, getState() { return {}; }, setState() {}
  });`);
  await page.route('**/e2e/harness/main.ts*', async (route) => {
    await scriptReady;
    await route.continue();
  });
  await page.route('**/e2e/harness/index.html?*', async (route) => {
    const html = renderStartupHtml(baseURL, `${baseURL}/e2e/harness/main.ts`);
    await route.fulfill({ contentType: 'text/html', body: html });
  });

  try {
    await page.goto('/e2e/harness/index.html?scenario=dispose-during-start', {
      waitUntil: 'commit',
    });
    await expect(page.locator('.varro-startup-logo')).toBeVisible();
    await expect(page.locator('.varro-startup-dots')).toHaveCount(0);
    releaseScript?.();

    const loading = page.getByText('Connecting to OpenCode...', { exact: true });
    await expect(loading).toBeVisible();
    await expect(page.locator('.server-status-detecting-logo')).toHaveCount(0);
    await expect(page.locator('.chat-empty-state')).toHaveCount(0);
    await expect(
      page.getByText('Startup completed without losing the restored session.', { exact: true })
    ).toBeVisible();
    await expect(loading).toHaveCount(0);
    await expect(page.locator('.chat-empty-state')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    releaseScript?.();
  }
});
