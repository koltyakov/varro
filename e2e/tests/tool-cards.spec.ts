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
  expect(new Set(fontWeights)).toEqual(new Set(['300']));

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

test('connects expanded activity rows to the underlined summary', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-cards&expandedActivity=1');

  const summary = page.locator('.assistant-activity-summary').first();
  const summaryText = summary.locator('.assistant-activity-summary-text');
  const details = page.locator('.assistant-activity-details').first();
  const firstDetail = details.locator(':scope > .assistant-activity-detail').first();
  const firstCard = firstDetail.locator('.chat-tool-invocation-part, .chat-thinking-box').first();
  const firstIcon = firstCard.locator('.tool-call-icon, .thinking-topic-icon').first();

  const connector = await firstDetail.evaluate((element) => {
    const style = getComputedStyle(element, '::before');
    const bounds = element.getBoundingClientRect();
    return {
      content: style.content,
      width: style.width,
      height: style.height,
      color: style.backgroundColor,
      center: bounds.left + Number.parseFloat(style.left) + Number.parseFloat(style.width) / 2,
      top: bounds.top + Number.parseFloat(style.top),
      bottom: bounds.top + Number.parseFloat(style.top) + Number.parseFloat(style.height),
    };
  });
  const underline = await summaryText.evaluate((element) => {
    const style = getComputedStyle(element, '::after');
    const main = element.querySelector('.assistant-activity-summary-main');
    if (!(main instanceof HTMLElement)) throw new Error('Activity summary label is missing');
    const bounds = element.getBoundingClientRect();
    return {
      content: style.content,
      height: style.height,
      color: style.backgroundColor,
      bottom: bounds.bottom,
      textGap:
        bounds.bottom - Number.parseFloat(style.height) - main.getBoundingClientRect().bottom,
    };
  });
  const iconCenter = await firstIcon.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left + bounds.width / 2;
  });
  const [activityGap, detailTop, cardBorderColor] = await Promise.all([
    details.evaluate((element) => getComputedStyle(element).gap),
    firstDetail.evaluate((element) => element.getBoundingClientRect().top),
    firstCard.evaluate((element) => getComputedStyle(element).borderTopColor),
  ]);

  expect(connector.content).toBe('""');
  expect(connector.width).toBe('1px');
  expect(activityGap).toBe('9px');
  expect(connector.height).toBe('12px');
  expect(Math.abs(connector.center - iconCenter)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(connector.top - underline.bottom)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(connector.bottom - detailTop)).toBeLessThanOrEqual(0.5);
  expect(underline.content).toBe('""');
  expect(underline.height).toBe('1px');
  expect(underline.color).toBe(cardBorderColor);
  expect(underline.textGap).toBeGreaterThanOrEqual(3);

  const detailConnectors = await details
    .locator(':scope > .assistant-activity-detail')
    .evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element, '::before').content)
    );
  expect(detailConnectors.every((content) => content === '""')).toBe(true);

  const editRows = page.locator('.file-change-card-list > .file-change-card');
  const internalConnector = await editRows.nth(1).evaluate((element) => {
    const previous = element.previousElementSibling;
    if (!(previous instanceof HTMLElement)) throw new Error('Previous file edit row is missing');
    const style = getComputedStyle(element, '::before');
    const bounds = element.getBoundingClientRect();
    return {
      content: style.content,
      top: bounds.top + Number.parseFloat(style.top),
      bottom: bounds.top + Number.parseFloat(style.top) + Number.parseFloat(style.height),
      previousBottom: previous.getBoundingClientRect().bottom,
      rowTop: bounds.top,
    };
  });

  expect(internalConnector.content).toBe('""');
  expect(Math.abs(internalConnector.top - internalConnector.previousBottom)).toBeLessThanOrEqual(
    0.5
  );
  expect(Math.abs(internalConnector.bottom - internalConnector.rowTop)).toBeLessThanOrEqual(0.5);

  const virtualizedBoundary = await page.evaluate(() => {
    const sourceGroup = document.querySelector('.assistant-activity-group');
    if (!(sourceGroup instanceof HTMLElement)) throw new Error('Activity group is missing');

    const track = document.createElement('div');
    track.className = 'interactive-list-track virtualized';
    track.style.position = 'fixed';
    track.style.visibility = 'hidden';

    const createRow = (continues: boolean) => {
      const row = document.createElement('div');
      row.className = `interactive-item-container interactive-response${continues ? ' interactive-response-continues-activity-group interactive-item-follows-bordered-block' : ''}`;
      const flow = document.createElement('div');
      flow.className = 'assistant-message-flow';
      const item = document.createElement('div');
      item.className = 'assistant-message-flow-item';
      item.append(sourceGroup.cloneNode(true));
      flow.append(item);
      row.append(flow);
      return row;
    };

    const previousRow = createRow(false);
    const continuingRow = createRow(true);
    continuingRow.querySelector('.assistant-activity-summary')?.remove();
    track.append(previousRow, continuingRow);
    document.body.append(track);

    const trailingDetail = previousRow.querySelector(
      '.assistant-activity-details > .assistant-activity-detail:last-child'
    );
    const continuingDetail = continuingRow.querySelector(
      '.assistant-activity-details > .assistant-activity-detail:first-child'
    );
    if (!(trailingDetail instanceof HTMLElement) || !(continuingDetail instanceof HTMLElement)) {
      throw new Error('Virtualized activity boundary is incomplete');
    }
    const style = getComputedStyle(continuingDetail, '::before');
    const detailBounds = continuingDetail.getBoundingClientRect();
    const top = detailBounds.top + Number.parseFloat(style.top);
    const result = {
      content: style.content,
      width: style.width,
      height: style.height,
      color: style.backgroundColor,
      top,
      bottom: top + Number.parseFloat(style.height),
      previousDetailBottom: trailingDetail.getBoundingClientRect().bottom,
      continuingDetailTop: detailBounds.top,
      containment: getComputedStyle(continuingRow).contain,
    };
    track.remove();
    return result;
  });

  expect(virtualizedBoundary.content).toBe('""');
  expect(virtualizedBoundary.width).toBe('1px');
  expect(virtualizedBoundary.height).toBe('9px');
  expect(virtualizedBoundary.color).toBe(connector.color);
  expect(
    Math.abs(virtualizedBoundary.top - virtualizedBoundary.previousDetailBottom)
  ).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(virtualizedBoundary.bottom - virtualizedBoundary.continuingDetailTop)
  ).toBeLessThanOrEqual(0.5);
  expect(virtualizedBoundary.containment).toBe('layout style');

  await page.goto('/e2e/harness/index.html?scenario=tool-cards');
  const collapsedSummary = page.locator('.assistant-activity-summary').first();
  await expect(collapsedSummary).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.assistant-activity-details')).toHaveCount(0);
  expect(
    await collapsedSummary
      .locator('.assistant-activity-summary-text')
      .evaluate((element) => getComputedStyle(element, '::after').content)
  ).toBe('none');
});

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
