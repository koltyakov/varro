import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('renders read, edit, and bash tool cards', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-cards');

  await expect(page.locator('.file-read-card')).toContainText('Read');
  await expect(page.locator('.file-read-card')).toContainText('index.ts');

  await expect(page.locator('.file-change-card')).toContainText('Edited');
  await expect(page.locator('.file-change-card')).toContainText('+1');
  await expect(page.locator('.file-change-card')).toContainText('-1');

  await page.locator('.tool-invocation-header').last().click();
  await expect(page.locator('.terminal-command-card')).toContainText('npm test');
  await expect(page.locator('.terminal-command-card')).toContainText('3 passed');
});

test('renders aborted and failed tool card states', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-card-errors');

  await expect(page.locator('.file-read-card')).toContainText('missing.ts');
  await expect(page.locator('.file-read-error-label.is-aborted')).toContainText('aborted');

  const bashTool = page.locator('.chat-tool-invocation-part').filter({ hasText: 'npm test' });
  await expect(bashTool).toContainText('failed');

  await bashTool.getByRole('button').click();
  await expect(page.locator('.tool-invocation-error')).toContainText('Command failed with exit code 1');
});

test('opens files and directories from tool cards', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-open-actions');

  await page.getByRole('link', { name: 'App.tsx' }).click();
  await page.getByRole('link', { name: 'src/components' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: { openTargets?: Array<{ path: string; kind?: string }> };
        }).__varroE2E;
        return value?.openTargets || [];
      })
    )
    .toEqual([
      { path: '/workspace/varro/src/components/App.tsx', kind: 'file' },
      { path: '/workspace/varro/src/components', kind: 'directory' },
    ]);
});
