/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These E2E checks inspect controlled restart state exposed by the harness browser global. */
import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('shows the missing-cli error state and offers install actions', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-missing-cli');

  await expect(page.getByText('OpenCode is not installed', { exact: true })).toBeVisible();
  await expect(page.getByText('npm i -g @opencode/cli', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open terminal and install', exact: true }).click();

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

  await page.getByText('Use OpenCode v1 instead', { exact: true }).click();
  await expect(page.getByText('npm i -g opencode-ai', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open terminal and install v1', exact: true }).click();
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { terminalCommands?: Array<{ command: string; title?: string }> };
          }
        ).__varroE2E;
        return value?.terminalCommands?.[1] || null;
      })
    )
    .toEqual({ command: 'npm i -g opencode-ai', title: 'OpenCode Install' });
});

test('centers install button labels without font-metric padding', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-missing-cli');

  const button = page.getByRole('button', { name: 'Open terminal and install', exact: true });
  const label = button.locator('span');
  await expect(label).toHaveCSS('text-box-trim', 'trim-both');
  await expect(label).toHaveCSS('text-box-edge', 'cap alphabetic');

  for (const fontFamily of ['Arial, sans-serif', 'serif', 'monospace']) {
    await button.evaluate((element, font) => {
      element.style.fontFamily = font;
    }, fontFamily);

    const buttonBox = await button.boundingBox();
    const labelBox = await label.boundingBox();
    expect(buttonBox).not.toBeNull();
    expect(labelBox).not.toBeNull();
    if (!buttonBox || !labelBox) throw new Error('Install button or label is not rendered');
    expect(
      Math.abs(labelBox.y + labelBox.height / 2 - (buttonBox.y + buttonBox.height / 2))
    ).toBeLessThanOrEqual(0.5);
    expect(buttonBox.height).toBeGreaterThanOrEqual(32);
    // Cap-height trimming removes the extra leading from the 16.8px line box.
    expect(labelBox.height).toBeLessThan(12);
  }

  await page.setViewportSize({ width: 220, height: 700 });
  // Force wrapping independently of the platform's monospace fallback width.
  await button.evaluate((element) => {
    element.style.maxWidth = '140px';
  });
  await expect(button).toBeVisible();
  await expect.poll(async () => (await label.boundingBox())?.height ?? 0).toBeGreaterThan(12);
  const buttonBox = await button.boundingBox();
  const labelBox = await label.boundingBox();
  if (!buttonBox || !labelBox) throw new Error('Wrapped install button or label is not rendered');
  expect(
    Math.abs(labelBox.y + labelBox.height / 2 - (buttonBox.y + buttonBox.height / 2))
  ).toBeLessThanOrEqual(0.5);
  await button.click();
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
  await expect(page.getByText(/Close the OpenCode TUI/)).toBeVisible();
  // `opencode upgrade` is the command that just failed; it must not be offered.
  await expect(page.getByText('opencode upgrade', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Open terminal and update' }).click();

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
  await expect(page.getByText(/only restart after the server is idle/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open terminal and update' })).toHaveCount(0);
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

test('opens the blocking setting when auto-update is disabled', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-update-blocked-setting');

  await expect(page.getByText('OpenCode update required', { exact: true })).toBeVisible();
  await expect(page.getByText('brew upgrade opencode', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open Settings' }).click();

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
    .toBe('varro.server.autoUpdate');
});
