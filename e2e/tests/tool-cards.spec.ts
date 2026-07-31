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

test('keeps compact tool card headers on the same geometry contract', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-cards');

  const headers = page.locator(
    '.file-read-card-header, .file-change-card-header, .tool-invocation-header'
  );
  await expect(headers).toHaveCount(4);
  const heights = await headers.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height)
  );

  expect(heights).toHaveLength(4);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);

  const iconSizes = await page.locator('.tool-call-icon').evaluateAll((icons) =>
    icons.map((icon) => {
      const bounds = icon.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    })
  );
  expect(iconSizes).toEqual(Array.from({ length: 4 }, () => ({ width: 12, height: 12 })));
});

test('renders search tool details in the same framed card as other tool details', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-cards');

  const searchTool = page
    .locator('.chat-tool-invocation-part')
    .filter({ hasText: 'Search: --color-vscode-input-border' });
  await expect
    .poll(() =>
      searchTool
        .locator('.tool-invocation-header')
        .evaluate((header) => getComputedStyle(header).columnGap)
    )
    .toBe('6px');
  await searchTool.locator('.tool-invocation-header').click();

  const card = searchTool.locator('.structured-tool-card');
  await expect(card).toContainText('pattern');
  await expect(card).toContainText('path');
  await expect(card).toContainText('results');
  await expect(card).toContainText('session-list.css:413');
  // The unframed generic body must not also render the output.
  await expect(searchTool.locator('.tool-invocation-output')).toHaveCount(0);
  await expect(searchTool.locator('.tool-invocation-input')).toHaveCount(0);
});

test('fills expanded details with terminal and structured cards', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-cards');

  const tools = [
    page
      .locator('.chat-tool-invocation-part')
      .filter({ hasText: 'Search: --color-vscode-input-border' }),
    page.locator('.chat-tool-invocation-part').last(),
  ];

  for (const tool of tools) {
    await tool.locator('.tool-invocation-header').click();
    const detail = tool.locator('.tool-invocation-detail');
    const card = detail.locator('.structured-tool-card, .terminal-command-card');

    await expect(detail).toHaveCSS('padding', '0px');
    await expect(card).toHaveCSS('border-radius', '0px');
    await expect
      .poll(() =>
        card.evaluate((element) => {
          const cardBounds = element.getBoundingClientRect();
          const detailBounds = element.parentElement!.getBoundingClientRect();
          return {
            left: Math.abs(cardBounds.left - detailBounds.left),
            right: Math.abs(cardBounds.right - detailBounds.right),
            bottom: Math.abs(cardBounds.bottom - detailBounds.bottom),
          };
        })
      )
      .toEqual({ left: 0, right: 0, bottom: 0 });
  }
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
          __varroE2E?: { openTargets?: Array<{ path: string; kind?: string; line?: number }> };
        }).__varroE2E;
        return value?.openTargets || [];
      })
    )
    .toEqual([
      { path: '/workspace/varro/src/components/App.tsx', kind: 'file', line: 2 },
      { path: '/workspace/varro/src/components', kind: 'directory' },
    ]);
});
