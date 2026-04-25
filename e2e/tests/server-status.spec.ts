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
