/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These E2E checks inspect controlled restart state exposed by the harness browser global. */
import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('shows the missing-cli error state and offers install actions', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-missing-cli');

  await expect(page.getByText('OpenCode is not installed', { exact: true })).toBeVisible();
  await expect(page.getByText('npm i -g @opencode/cli', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run install command in terminal', exact: true }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { terminalCommands?: Array<{ command: string; title?: string }> };
          }
        ).__varroE2E;
        return value?.terminalCommands?.[0] || null;
      })
    )
    .toEqual({ command: 'npm i -g @opencode/cli', title: 'OpenCode Install' });

  await page.getByRole('button', { name: 'Learn more at opencode.ai' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { externalUrls?: string[] };
          }
        ).__varroE2E;
        return value?.externalUrls?.[0] || null;
      })
    )
    .toBe('https://opencode.ai/v2/docs/');

  await expect(page.getByText('Use OpenCode v1 instead', { exact: true })).toHaveCount(0);
});

test('centers install command icons across fonts and narrow layouts', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-missing-cli');

  const field = page.getByRole('group', { name: 'Install command', exact: true });
  const run = field.getByRole('button', { name: 'Run install command in terminal', exact: true });
  const copy = field.getByRole('button', { name: 'Copy command: npm i -g @opencode/cli' });
  await expect(run).toBeVisible();
  await expect(copy).toBeVisible();

  for (const width of [470, 220]) {
    await page.setViewportSize({ width, height: 700 });
    for (const fontFamily of ['Arial, sans-serif', 'serif', 'monospace']) {
      await field.evaluate((element, font) => {
        element.style.fontFamily = font;
      }, fontFamily);

      const fieldBox = await field.boundingBox();
      if (!fieldBox) throw new Error('Install command field is not rendered');
      for (const button of [run, copy]) {
        const buttonBox = await button.boundingBox();
        const iconBox = await button.locator('.ui-icon').boundingBox();
        if (!buttonBox || !iconBox)
          throw new Error('Install command button or icon is not rendered');
        expect(buttonBox.width).toBe(24);
        expect(buttonBox.height).toBe(24);
        expect(
          Math.abs(iconBox.x + iconBox.width / 2 - (buttonBox.x + buttonBox.width / 2))
        ).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(iconBox.y + iconBox.height / 2 - (buttonBox.y + buttonBox.height / 2))
        ).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(buttonBox.y + buttonBox.height / 2 - (fieldBox.y + fieldBox.height / 2))
        ).toBeLessThanOrEqual(0.5);
        expect(buttonBox.x).toBeGreaterThanOrEqual(fieldBox.x);
        expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(fieldBox.x + fieldBox.width);
      }
    }
  }

  await run.click();
});

test('shows a generic startup error message', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-generic');

  await expect(page.getByText('OpenCode is unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('Failed to bind local server port', { exact: true })).toBeVisible();
});

test('restarts the server from an error state without the command palette', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-generic');

  await page.getByRole('button', { name: 'Restart Server' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { serverRestartCount?: number };
          }
        ).__varroE2E;
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
        const value = (
          window as Window & {
            __varroE2E?: { settingsQueries?: string[] };
          }
        ).__varroE2E;
        return value?.settingsQueries?.[0] || null;
      })
    )
    .toBe('varro.server.command');
});

test('recommends the install-specific command after a failed update', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-update-failed-windows-lock');

  await expect(page.getByText('OpenCode update failed', { exact: true })).toBeVisible();
  await expect(page.getByText('npm install -g opencode-ai@latest', { exact: true })).toBeVisible();
  await expect(page.getByText('The automatic update failed.', { exact: true })).toBeVisible();
  // `opencode upgrade` is the command that just failed; it must not be offered.
  await expect(page.getByText('opencode upgrade', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Run update command in terminal', exact: true }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { terminalCommands?: Array<{ command: string; title?: string }> };
          }
        ).__varroE2E;
        return value?.terminalCommands?.[0] || null;
      })
    )
    .toEqual({ command: 'npm install -g opencode-ai@latest', title: 'OpenCode Update' });
});

test('presents an update deferred by active sessions as a wait', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-update-blocked-sessions');

  await expect(page.getByText('Waiting to update OpenCode', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'The server has active sessions and was not stopped to avoid interrupting work.',
      {
        exact: true,
      }
    )
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run update command in terminal' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Restart Server' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check Again' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { serverRestartCount?: number };
          }
        ).__varroE2E;
        return value?.serverRestartCount || 0;
      })
    )
    .toBe(1);
});

test('offers manual update when auto-update is disabled', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-update-blocked-setting');

  await expect(page.getByText('OpenCode update required', { exact: true })).toBeVisible();
  await expect(page.getByText('brew upgrade opencode', { exact: true })).toBeVisible();
  await expect(page.getByText(/Automatic updates are disabled\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Settings' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Run update command in terminal', exact: true }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { terminalCommands?: Array<{ command: string; title?: string }> };
          }
        ).__varroE2E;
        return value?.terminalCommands?.[0] || null;
      })
    )
    .toEqual({ command: 'brew upgrade opencode', title: 'OpenCode Update' });
});
