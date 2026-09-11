/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: This E2E callback updates protocol-shaped tool state owned by the controlled harness fixture. */
import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('renders read, edit, and bash tool cards', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-cards&expandedActivity=1');

  await expect(page.locator('.file-read-card')).toContainText('Read');
  await expect(page.locator('.file-read-card')).toContainText('index.ts');

  await expect(page.locator('.file-change-card').first()).toContainText('Edited');
  await expect(page.locator('.file-change-card').first()).toContainText('+1');
  await expect(page.locator('.file-change-card').first()).toContainText('-1');

  await page.locator('.tool-invocation-header').last().click();
  await expect(page.locator('.terminal-command-card')).toContainText('npm test');
  await expect(page.locator('.terminal-command-card')).toContainText('3 passed');
});

test('keeps compact tool card headers on the same geometry contract', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-cards&expandedActivity=1');

  const headers = page.locator(
    '.file-read-card-header, .file-change-card-header, .tool-invocation-header'
  );
  await expect(headers).toHaveCount(7);
  const heights = await headers.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height)
  );

  expect(heights).toHaveLength(7);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);

  const primaryText = page.locator(
    '.file-read-action-label, .file-read-target, .file-edit-action-label, .file-edit-path-link, .tool-invocation-title'
  );
  const fontWeights = await primaryText.evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).fontWeight)
  );
  expect(new Set(fontWeights)).toEqual(new Set(['400']));

  const iconSizes = await page.locator('.tool-call-icon').evaluateAll((icons) =>
    icons.map((icon) => {
      const bounds = icon.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    })
  );
  expect(iconSizes).toEqual(Array.from({ length: 7 }, () => ({ width: 12, height: 12 })));
});

test('renders each completed file edit as a separate row', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-cards&expandedActivity=1');

  const rows = page.locator('.file-change-card');
  await expect(rows).toHaveCount(4);
  await expect(rows.locator('.file-edit-path-link')).toHaveText([
    'src/index.ts',
    'src/format.ts',
    'src/state.ts',
    'src/types.ts',
  ]);
  await expect(page.locator('.file-edit-more-count')).toHaveCount(0);

  const rowList = page.locator('.file-change-card-list');
  const activityDetails = page.locator('.assistant-activity-details').filter({ has: rowList });
  const [rowGap, activityGap] = await Promise.all([
    rowList.evaluate((element) => getComputedStyle(element).gap),
    activityDetails.evaluate((element) => getComputedStyle(element).gap),
  ]);
  expect(rowGap).toBe(activityGap);
});

test('scales only bordered pairs in compact file-edit stacks', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-cards');
  await expect(page.locator('.assistant-message-flow')).toBeVisible();

  const gaps = await page.evaluate(() => {
    const host = document.querySelector('.assistant-message-flow');
    if (!(host instanceof HTMLElement)) throw new Error('Assistant flow is missing');
    const stack = document.createElement('div');
    stack.className = 'assistant-file-edit-stack';
    stack.style.position = 'absolute';
    stack.style.visibility = 'hidden';
    const blocks: HTMLDivElement[] = [];
    for (const className of [
      'file-change-card',
      'file-change-card',
      'file-change-truncated-summary',
      'file-change-card',
      'file-edit-error-detail',
      'file-change-card',
    ]) {
      const block = document.createElement('div');
      block.className = className;
      block.style.height = '20px';
      blocks.push(block);
    }
    const [first, second, note, third, detail, fourth] = blocks as [
      HTMLDivElement,
      HTMLDivElement,
      HTMLDivElement,
      HTMLDivElement,
      HTMLDivElement,
      HTMLDivElement,
    ];
    stack.append(first, second, note, third, detail, fourth);
    host.append(stack);
    const result = {
      bordered: second.getBoundingClientRect().top - first.getBoundingClientRect().bottom,
      borderedToNote: note.getBoundingClientRect().top - second.getBoundingClientRect().bottom,
      noteToBordered: third.getBoundingClientRect().top - note.getBoundingClientRect().bottom,
      borderedToDetail: detail.getBoundingClientRect().top - third.getBoundingClientRect().bottom,
      detailToBordered: fourth.getBoundingClientRect().top - detail.getBoundingClientRect().bottom,
    };
    stack.remove();
    return result;
  });

  expect(gaps).toEqual({
    bordered: 1.5,
    borderedToNote: 4.5,
    noteToBordered: 1.5,
    borderedToDetail: 2,
    detailToBordered: 2,
  });
});

for (const theme of ['dark', 'light']) {
  test(`${theme} shows a compact activity log and frames only opened tool details`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 496, height: 850 });
    await page.goto(`/e2e/harness/index.html?scenario=tool-cards&theme=${theme}`);
    const summary = page.locator('.assistant-activity-summary').first();
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.assistant-activity-details')).toHaveCount(0);

    await summary.focus();
    await expect(summary).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Enter');
    await expect(summary).toHaveAttribute('aria-expanded', 'true');

    const details = page.locator('.assistant-activity-details').first();
    const cards = details.locator('.chat-tool-invocation-part');
    await expect(cards).toHaveCount(7);
    const rows = await cards.evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          top: bounds.top,
          bottom: bounds.bottom,
          border: getComputedStyle(element).borderTopColor,
          connector: getComputedStyle(element, '::before').content,
        };
      })
    );
    for (const [index, row] of rows.entries()) {
      expect(row.border).toBe('rgba(0, 0, 0, 0)');
      expect(row.connector).toBe('none');
      if (index === 0) continue;
      const gap = row.top - rows[index - 1]!.bottom;
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(2);
    }

    const command = cards.last();
    await command.locator('.tool-invocation-header').click();
    await expect(command.locator('.terminal-command-card')).toContainText('3 passed');
    await expect(command).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await command.locator('.tool-invocation-header').click();
    await page.mouse.move(0, 0);
    const groupBounds = await page.locator('.assistant-activity-group').first().boundingBox();
    if (!groupBounds) throw new Error('Expanded activity group is missing');
    await page.screenshot({
      path: testInfo.outputPath('explored-activity.png'),
      animations: 'disabled',
      clip: { x: 0, y: groupBounds.y, width: 496, height: groupBounds.height },
    });

    await page.setViewportSize({ width: 280, height: 850 });
    const summaryText = summary.locator('.assistant-activity-summary-text');
    await expect(summaryText.locator('.assistant-activity-kind-icon')).not.toHaveCount(0);
    await expect
      .poll(() =>
        summary.evaluate((element) => {
          const label = element.querySelector('.assistant-activity-summary-main')!;
          const chevron = element.querySelector('.assistant-activity-chevron')!;
          return label.getBoundingClientRect().right <= chevron.getBoundingClientRect().left;
        })
      )
      .toBe(true);

    await summary.focus();
    await page.keyboard.press('Space');
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.assistant-activity-details')).toHaveCount(0);
  });
}

test('prevents selection from starting on expandable tool headers', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-cards&expandedActivity=1');

  const expandableHeaders = page.locator(
    '.file-change-card-header.is-expandable, .tool-invocation-header:not(:disabled)'
  );
  await expect(expandableHeaders).not.toHaveCount(0);

  for (const header of await expandableHeaders.all()) {
    await expect(header).toHaveCSS('user-select', 'none');
  }
});

test('renders search tool details in the same framed card as other tool details', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-cards&expandedActivity=1');

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
  await page.goto('/e2e/harness/index.html?scenario=tool-cards&expandedActivity=1');

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
  await page.goto('/e2e/harness/index.html?scenario=tool-card-errors&expandedActivity=1');

  await expect(page.locator('.file-read-card')).toContainText('missing.ts');
  await expect(page.locator('.file-read-error-label.is-aborted')).toContainText('aborted');

  const bashTool = page.locator('.chat-tool-invocation-part').filter({ hasText: 'npm test' });
  await expect(bashTool).toContainText('failed');

  await bashTool.getByRole('button').click();
  await expect(page.locator('.tool-invocation-error')).toContainText(
    'Command failed with exit code 1'
  );
});

test('opens files and directories from tool cards', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-open-actions&expandedActivity=1');

  await page.getByRole('link', { name: 'App.tsx' }).click();
  await page.getByRole('link', { name: 'src/components' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { openTargets?: Array<{ path: string; kind?: string; line?: number }> };
          }
        ).__varroE2E;
        return value?.openTargets || [];
      })
    )
    .toEqual([
      { path: '/workspace/varro/src/components/App.tsx', kind: 'file', line: 2 },
      { path: '/workspace/varro/src/components', kind: 'directory' },
    ]);
});
