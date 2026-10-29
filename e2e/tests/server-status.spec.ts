/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These E2E checks inspect controlled restart state exposed by the harness browser global. */
import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('shows restored chat while optional startup status never settles', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=mcp-pickers&startupBackgroundPending');
  await expect(page.getByLabel('Back to sessions')).toBeVisible();
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
  await expect(page.getByText('Restoring workspace', { exact: true })).toHaveCount(0);
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const state = (window as Window & { __varroE2E?: { requests: Array<{ path: string }> } })
          .__varroE2E;
        return state?.requests.map((request) => request.path) ?? [];
      })
    )
    .toEqual(
      expect.arrayContaining([
        '/mcp',
        '/lsp',
        '/provider/auth',
        '/experimental/workspace/status',
        '/varro/session-trash',
      ])
    );
});

test('retries transient startup health without needing another server status event', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=blank&startupHealthRetry');
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const state = (window as Window & { __varroE2E?: { requests: Array<{ path: string }> } })
          .__varroE2E;
        return state?.requests.filter((request) => request.path === '/global/health').length ?? 0;
      })
    )
    .toBe(2);
  await expect(page.getByText(/Failed to connect to OpenCode server/)).toHaveCount(0);
});

test('keeps failed essential catalogs gated and retries without restarting the server', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=blank&startupCatalogFailure');
  await expect(
    page.getByText('Failed to load OpenCode startup data: Could not load routing catalogs', {
      exact: true,
    })
  ).toBeVisible();
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toHaveCount(0);
  await page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('startupCatalogRecovered', '');
    window.history.replaceState(null, '', url);
  });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
  await expect(page.getByText(/Failed to load OpenCode startup data/)).toHaveCount(0);
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const state = (window as Window & { __varroE2E?: { requests: Array<{ path: string }> } })
          .__varroE2E;
        return state?.requests.filter((request) => request.path === '/global/health').length ?? 0;
      })
    )
    .toBe(2);
});

test('finishes startup when catalog events supersede the first routing loads', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank&startupCatalogEvents');
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
  await expect(page.getByText(/Failed to load OpenCode startup data/)).toHaveCount(0);
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const state = (window as Window & { __varroE2E?: { requests: Array<{ path: string }> } })
          .__varroE2E;
        return state?.requests.filter((request) => request.path === '/agent').length ?? 0;
      })
    )
    .toBeGreaterThanOrEqual(2);
});

test('opens provider management and add dialog directly when no providers are configured', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=no-providers');

  await expect(page.locator('.models-panel')).toBeVisible();
  await expect(page.locator('.server-status-surface')).toHaveCount(0);
  await expect(page.getByText('opencode auth login', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Provider setup docs/ })).toHaveCount(0);

  await expect(page.getByLabel('Search providers')).toBeVisible();
  await page
    .locator('.provider-connect-dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await expect(page.locator('.provider-connect-dialog')).toHaveCount(0);
  await expect(page.locator('.models-panel')).toBeVisible();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: {
              terminalCommands?: Array<{ command: string; title?: string }>;
              externalUrls?: string[];
            };
          }
        ).__varroE2E;
        return {
          terminal: value?.terminalCommands ?? [],
          urls: value?.externalUrls ?? [],
        };
      })
    )
    .toEqual({
      terminal: [],
      urls: [],
    });
});

test('recovers when the webview reloads while startup is still in progress', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=dispose-during-start');

  await expect(page.getByText('Connecting to OpenCode...', { exact: true })).toBeVisible();

  await page.reload();

  await expect(page.getByText('Connecting to OpenCode...', { exact: true })).toBeVisible();
  await expect(
    page.getByLabel('Back to sessions').locator('..').getByText('Startup handoff')
  ).toBeVisible();
  await expect(
    page.getByText('Startup completed without losing the restored session.', { exact: true })
  ).toBeVisible();
  await expect(page.getByText('OpenCode is unavailable', { exact: true })).toHaveCount(0);
});

test('recovers when the first startup connection attempt loses the race', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=startup-race');

  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = (
          window as Window & {
            __varroE2E?: { requests: Array<{ method: string; path: string }> };
          }
        ).__varroE2E;
        return (
          value?.requests.filter(
            (request) => request.method === 'GET' && request.path === '/global/health'
          ).length || 0
        );
      })
    )
    .toBe(2);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = (
          window as Window & {
            __varroE2E?: { requests: Array<{ method: string; path: string }> };
          }
        ).__varroE2E;
        return (value?.requests || []).map((request) => `${request.method} ${request.path}`);
      })
    )
    .toEqual(
      expect.arrayContaining([
        'GET /global/health',
        'GET /session?limit=100',
        'GET /agent',
        'GET /config/providers',
      ])
    );

  await expect(page.getByText('Failed to connect to OpenCode server', { exact: true })).toHaveCount(
    0
  );
  await expect(page.getByLabel('Back to sessions')).toBeVisible();
  await expect(
    page.getByLabel('Back to sessions').locator('..').getByText('Startup race recovery')
  ).toBeVisible();
  await expect(
    page.getByText('The second startup attempt connected and restored the session state.', {
      exact: true,
    })
  ).toBeVisible();
});

test('preserves composer input when startup recovers after a race', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=startup-race');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await expect(composer).toBeVisible();

  await expect(
    page.getByText('The second startup attempt connected and restored the session state.', {
      exact: true,
    })
  ).toBeVisible();

  await composer.fill('Keep this draft through startup recovery');
  await expect(composer).toHaveText('Keep this draft through startup recovery');

  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'server/status',
        payload: { state: 'running', url: 'mock://opencode', eventStream: 'healthy' },
      },
      '*'
    );
  });

  await expect(composer).toHaveText('Keep this draft through startup recovery');
  await expect(composer).toBeEditable();
});
