import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('shows the missing-cli error state and opens install docs', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-missing-cli');

  await expect(page.getByText('OpenCode is not installed', { exact: true })).toBeVisible();
  await expect(page.getByText('npm i -g opencode-ai', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Learn more at opencode.ai' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: { externalUrls?: string[] };
        }).__varroE2E;
        return value?.externalUrls?.[0] || null;
      })
    )
    .toBe('https://opencode.ai');
});

test('shows a generic startup error message', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-generic');

  await expect(page.getByText('OpenCode could not start', { exact: true })).toBeVisible();
  await expect(page.getByText('Failed to bind local server port', { exact: true })).toBeVisible();
});

test('restarts the server from an error state without the command palette', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-generic');

  await page.getByRole('button', { name: 'Restart Server' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: { serverRestartCount?: number };
        }).__varroE2E;
        return value?.serverRestartCount || 0;
      })
    )
    .toBe(1);
});

test('points at the setting when the configured CLI path is wrong', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-cli-path-invalid');

  await expect(page.getByText('Configured OpenCode path not found', { exact: true })).toBeVisible();
  await expect(page.getByText('/opt/nope/opencode', { exact: true })).toBeVisible();
  // A configured path that does not exist is not a missing install.
  await expect(page.getByText('OpenCode is not installed', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Open settings' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: { settingsQueries?: string[] };
        }).__varroE2E;
        return value?.settingsQueries?.[0] || null;
      })
    )
    .toBe('varro.server.command');
});

test('recommends the install-specific command after a failed update', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-update-failed-windows-lock');

  await expect(page.getByText('OpenCode update failed', { exact: true })).toBeVisible();
  await expect(page.getByText('npm install -g opencode-ai@latest', { exact: true })).toBeVisible();
  await expect(page.getByText(/Close the OpenCode TUI/)).toBeVisible();
  // `opencode upgrade` is the command that just failed; it must not be offered.
  await expect(page.getByText('opencode upgrade', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Open terminal and update' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: { terminalCommands?: Array<{ command: string; title?: string }> };
        }).__varroE2E;
        return value?.terminalCommands?.[0] || null;
      })
    )
    .toEqual({ command: 'npm install -g opencode-ai@latest', title: 'OpenCode Update' });
});

test('presents an update deferred by active sessions as a wait', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-update-blocked-sessions');

  await expect(page.getByText('Waiting to update OpenCode', { exact: true })).toBeVisible();
  await expect(page.getByText(/only restart after the server is idle/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open terminal and update' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check Again' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: { serverRestartCount?: number };
        }).__varroE2E;
        return value?.serverRestartCount || 0;
      })
    )
    .toBe(1);
});

test('opens the blocking setting when auto-update is disabled', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-update-blocked-setting');

  await expect(page.getByText('OpenCode update required', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open Settings' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: { settingsQueries?: string[] };
        }).__varroE2E;
        return value?.settingsQueries?.[0] || null;
      })
    )
    .toBe('varro.server.autoUpdate');
});
