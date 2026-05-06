import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('shows no-provider setup actions and triggers provider setup commands', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=no-providers');

  await expect(page.getByText('No providers configured', { exact: true })).toBeVisible();
  await expect(page.getByText('opencode auth login', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Open terminal and add a provider' }).click();
  await page.getByRole('button', { name: 'Provider setup docs' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: {
            terminalCommands?: Array<{ command: string; title?: string }>;
            externalUrls?: string[];
          };
        }).__varroE2E;
        return {
          terminal: value?.terminalCommands?.[0] || null,
          url: value?.externalUrls?.[0] || null,
        };
      })
    )
    .toEqual({
      terminal: { command: 'opencode auth login', title: 'OpenCode Provider Setup' },
      url: 'https://opencode.ai/docs/providers',
    });
});

test('recovers when the webview reloads while startup is still in progress', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=dispose-during-start');

  await expect(page.getByText('Starting OpenCode...', { exact: true })).toBeVisible();

  await page.reload();

  await expect(page.getByText('Starting OpenCode...', { exact: true })).toBeVisible();
  await expect(page.getByTitle('Back to sessions').locator('..').getByText('Startup handoff')).toBeVisible();
  await expect(
    page.getByText('Startup completed without losing the restored session.', { exact: true })
  ).toBeVisible();
  await expect(page.getByText('OpenCode could not start', { exact: true })).toHaveCount(0);
});

test('recovers when the first startup connection attempt loses the race', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=startup-race');

  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = (window as Window & {
          __varroE2E?: { requests: Array<{ method: string; path: string }> };
        }).__varroE2E;
        return value?.requests.filter(
          (request) => request.method === 'GET' && request.path === '/global/health'
        ).length || 0;
      })
    )
    .toBe(2);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = (window as Window & {
          __varroE2E?: { requests: Array<{ method: string; path: string }> };
        }).__varroE2E;
        return (value?.requests || []).map((request) => `${request.method} ${request.path}`);
      })
    )
    .toEqual(
      expect.arrayContaining([
        'GET /global/health',
        'GET /session',
        'GET /agent',
        'GET /config/providers',
      ])
    );

  await expect(page.getByText('Failed to connect to OpenCode server', { exact: true })).toHaveCount(0);
  await expect(page.getByTitle('Back to sessions')).toBeVisible();
  await expect(page.getByTitle('Back to sessions').locator('..').getByText('Startup race recovery')).toBeVisible();
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
