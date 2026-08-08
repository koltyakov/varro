import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  getScrollMetrics,
  getStickyMessageAlignment,
  getVisibleMessageAnchor,
  installOuterScrollSentinel,
  sampleMessageTopAcrossFrames,
  waitForAnimationFrame,
  waitForAnimationFrames,
} from './helpers';

async function updateDiffPreview(page: Page, messageId: string, fileCount: number) {
  const patchText = [
    '*** Begin Patch',
    ...Array.from({ length: fileCount }, (_, index) =>
      [
        `*** Update File: src/async-report-${index}.ts`,
        '@@',
        `-export const value${index} = 'pending';`,
        `+export const value${index} = 'ready';`,
      ].join('\n')
    ),
    '*** End Patch',
  ].join('\n');
  await updateDiffPreviewWithPatch(page, messageId, patchText);
}

async function updateExpandableDiffPreview(page: Page, messageId: string) {
  const patchText = [
    '*** Begin Patch',
    '*** Update File: src/expanded-report.ts',
    '@@',
    ...Array.from({ length: 30 }, (_, index) => `-export const oldValue${index} = ${index};`),
    ...Array.from({ length: 30 }, (_, index) => `+export const newValue${index} = ${index};`),
    '*** End Patch',
  ].join('\n');
  await updateDiffPreviewWithPatch(page, messageId, patchText);
}

function makeWideDiffPatch(lineCount: number) {
  return [
    '*** Begin Patch',
    '*** Update File: src/wide-report.ts',
    '@@',
    ...Array.from(
      { length: lineCount },
      (_, index) => `+export const value${index} = '${'wide content '.repeat(20)}';`
    ),
    '*** End Patch',
  ].join('\n');
}

async function updateDiffPreviewWithPatch(page: Page, messageId: string, patchText: string) {
  const partId = `${messageId}-patch`;

  await page.evaluate(
    ({ id, part, patch }) => {
      const nextPart = {
        id: part,
        sessionID: 'session-diff-preview-large-transcript',
        messageID: id,
        type: 'tool' as const,
        callID: `${part}-call`,
        tool: 'apply_patch',
        state: {
          status: 'completed' as const,
          input: { patchText: patch },
          output: 'Done',
          title: 'apply_patch',
          metadata: {},
          time: { start: 1, end: 2 },
        },
      };
      const harnessWindow = window as typeof window & {
        __varroE2E?: { updateMessagePart?: (updatedPart: unknown) => void };
      };
      harnessWindow.__varroE2E?.updateMessagePart?.(nextPart);
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'message.part.updated',
            properties: {
              part: nextPart,
            },
          },
        },
        '*'
      );
    },
    { id: messageId, part: partId, patch: patchText }
  );
}

test.describe('diff preview anchoring', () => {
  test('keeps a detached row anchored and its diff visible when the active turn completes', async ({
    page,
  }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&activeTurnCollapse=1&expandedActivity=1'
    );
    const list = page.locator('.interactive-list');
    const editMessageId = 'message-diff-preview-assistant-59';
    const anchorMessageId = 'message-diff-preview-active-step-5';
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect(page.locator(`[data-msg-id="${editMessageId}"] .diff-view-file`)).toBeVisible();

    const anchorRow = page.locator(`[data-msg-id="${anchorMessageId}"]`);
    await anchorRow.scrollIntoViewIfNeeded();
    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 120);
      element.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(300);
    await waitForAnimationFrames(page, 4);
    const before = await getVisibleMessageAnchor(list, anchorMessageId);
    const beforeMetrics = await getScrollMetrics(page, '.interactive-list');
    expect(beforeMetrics.distanceFromBottom).toBeGreaterThan(100);

    await page.evaluate(() => {
      const sessionId = 'session-diff-preview-large-transcript';
      const finalMessageId = 'message-diff-preview-active-step-7';
      const harnessWindow = window as typeof window & {
        __varroE2E?: {
          getSessionMessages?: (id: string) => Array<{ info: Record<string, unknown> }>;
          updateMessageInfo?: (info: Record<string, unknown>) => void;
          updateSessionStatus?: (id: string, status: { type: 'idle' }) => void;
        };
      };
      const info = harnessWindow.__varroE2E
        ?.getSessionMessages?.(sessionId)
        .find((message) => message.info.id === finalMessageId)?.info;
      if (!info) throw new Error('Active turn final assistant is missing');
      info.time = { ...(info.time as Record<string, unknown>), completed: Date.now() };
      harnessWindow.__varroE2E?.updateMessageInfo?.(info);
      harnessWindow.__varroE2E?.updateSessionStatus?.(sessionId, { type: 'idle' });
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'session.status',
            properties: { sessionID: sessionId, status: { type: 'idle' } },
          },
        },
        '*'
      );
    });

    const samples = await sampleMessageTopAcrossFrames(list, before.id, 10);
    expect(
      samples.every((top) => top !== null && Math.abs(top - before.top) < 1.5),
      JSON.stringify({ before, beforeMetrics, samples })
    ).toBe(true);
    expect(await list.locator('[data-msg-id]').count()).toBeLessThan(50);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 4);
    const summary = page.locator(`[data-msg-id="${editMessageId}"] .assistant-activity-summary`);
    await expect(page.locator(`[data-msg-id="${editMessageId}"] .diff-view-file`)).toBeVisible();
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeLessThan(3);
    expect(await list.locator('[data-msg-id]').count()).toBeLessThan(50);

    const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
    await composer.fill('Make one more change');
    await page.getByTitle('Send (Enter)').click();

    await expect(page.locator('.chat-turn-user').last()).toContainText('Make one more change');
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
    await expect(summary).toContainText('Explored: 1 file');
    await expect(summary).not.toContainText('edit');
    await expect(page.locator(`[data-msg-id="${editMessageId}"] .diff-view-file`)).toBeVisible();
  });

  test('centers the expanded diff and strongly obscures the transcript', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    const messageId = 'message-diff-preview-assistant-59';
    await updateExpandableDiffPreview(page, messageId);

    await page
      .locator(`[data-msg-id="${messageId}"] .diff-view-toggle`)
      .evaluate((button) => (button as HTMLButtonElement).click());

    const overlay = page.locator('.diff-view-overlay');
    await expect(overlay).toBeVisible();

    const layout = await overlay.evaluate((element) => {
      const overlayRect = element.getBoundingClientRect();
      const panelRect = element
        .querySelector<HTMLElement>('.diff-view-overlay-panel')!
        .getBoundingClientRect();
      const composerRect = document
        .querySelector<HTMLElement>('.chat-input-container')!
        .getBoundingClientRect();
      const list = element
        .closest<HTMLElement>('.interactive-list-shell')
        ?.querySelector<HTMLElement>(':scope > .interactive-list');

      return {
        centerDelta:
          panelRect.top + panelRect.height / 2 - (overlayRect.top + overlayRect.height / 2),
        leftEdgeDelta: panelRect.left - composerRect.left,
        rightEdgeDelta: panelRect.right - composerRect.right,
        listFilter: list ? getComputedStyle(list).filter : '',
        listOpacity: list ? getComputedStyle(list).opacity : '',
      };
    });

    expect(Math.abs(layout.centerDelta)).toBeLessThan(1);
    expect(Math.abs(layout.leftEdgeDelta)).toBeLessThan(1);
    expect(Math.abs(layout.rightEdgeDelta)).toBeLessThan(1);
    expect(layout.listFilter).toBe('blur(40px)');
    expect(layout.listOpacity).toBe('0.1');
    await expect(overlay.locator('.diff-view-overlay-title .diff-view-file-type')).toHaveText('TS');

    const overlayFilename = overlay.locator('.diff-view-overlay-filename');
    await overlayFilename.click();
    await expect(overlay).toBeVisible();

    const headerGap = await overlay.locator('.diff-view-overlay-header').evaluate((header) => {
      const filenameRect = header
        .querySelector<HTMLElement>('.diff-view-overlay-filename')!
        .getBoundingClientRect();
      const statsRect = header
        .querySelector<HTMLElement>('.diff-view-stats')!
        .getBoundingClientRect();
      return {
        x: (filenameRect.right + statsRect.left) / 2,
        y: filenameRect.top + filenameRect.height / 2,
        width: statsRect.left - filenameRect.right,
      };
    });
    expect(headerGap.width).toBeGreaterThan(20);
    await page.mouse.click(headerGap.x, headerGap.y);
    await expect(overlay).toHaveCount(0);

    await page
      .locator(`[data-msg-id="${messageId}"] .diff-view-toggle`)
      .evaluate((button) => (button as HTMLButtonElement).click());
    await expect(overlay).toBeVisible();
    await overlay.click({ position: { x: 2, y: 2 } });
    await expect(overlay).toHaveCount(0);
  });

  test('keeps visible content anchored while diff previews resize asynchronously', async ({
    page,
  }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => list.evaluate((element) => element.querySelectorAll('[data-msg-id]').length))
      .toBeLessThan(50);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * 0.55);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 4);

    const before = await list.evaluate((element) => {
      const containerRect = element.getBoundingClientRect();
      const rows = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')];
      const firstVisible = rows.find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
      });
      const diffRowsAbove = rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return row.querySelector('.diff-view-widget') && rect.bottom <= containerRect.top;
      });
      const target = diffRowsAbove.at(-1);
      element.dataset.maxRenderedMessageRows = String(rows.length);
      const rowObserver = new MutationObserver((records) => {
        const addedRows = records.reduce((count, record) => {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            count += node.matches('[data-msg-id]') ? 1 : 0;
            count += node.querySelectorAll('[data-msg-id]').length;
          }
          return count;
        }, 0);
        element.dataset.maxRenderedMessageRows = String(
          Math.max(
            Number(element.dataset.maxRenderedMessageRows ?? 0),
            element.querySelectorAll('[data-msg-id]').length,
            addedRows
          )
        );
      });
      rowObserver.observe(element, { childList: true, subtree: true });

      return {
        anchorId: firstVisible?.dataset.msgId ?? '',
        anchorTop: firstVisible ? firstVisible.getBoundingClientRect().top - containerRect.top : 0,
        targetId: target?.dataset.msgId ?? '',
      };
    });

    expect(before.anchorId).not.toBe('');
    expect(before.targetId).not.toBe('');

    await list.dispatchEvent('wheel', { deltaY: -1 });
    await updateDiffPreview(page, before.targetId, 20);
    await expect(page.locator(`[data-msg-id="${before.targetId}"] .diff-view-file`)).toHaveCount(
      20
    );
    await waitForAnimationFrames(page, 4);

    const mountedResizeSamples = await sampleMessageTopAcrossFrames(list, before.anchorId, 4);
    expect(
      mountedResizeSamples.every((top) => top !== null && Math.abs(top - before.anchorTop) < 1.5),
      JSON.stringify({ before, mountedResizeSamples })
    ).toBe(true);

    const beforeOffscreenUpdate = {
      id: before.anchorId,
      top: mountedResizeSamples.at(-1)!,
    };
    await expect(page.locator('[data-msg-id="message-diff-preview-assistant-0"]')).toHaveCount(0);
    await list.dispatchEvent('wheel', { deltaY: -1 });
    await updateDiffPreview(page, 'message-diff-preview-assistant-0', 24);
    await waitForAnimationFrames(page, 4);

    const offscreenUpdateSamples = await sampleMessageTopAcrossFrames(
      list,
      beforeOffscreenUpdate.id,
      4
    );
    expect(
      offscreenUpdateSamples.every(
        (top) => top !== null && Math.abs(top - beforeOffscreenUpdate.top!) < 1.5
      ),
      JSON.stringify({ beforeOffscreenUpdate, offscreenUpdateSamples })
    ).toBe(true);
    expect(
      await list.evaluate((element) => Number(element.dataset.maxRenderedMessageRows ?? 0))
    ).toBeLessThan(50);
  });

  test('aligns the first changed diff row with the top of the preview', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    await expect(page.locator('.interactive-list')).toBeVisible();

    const messageId = 'message-diff-preview-assistant-59';
    await updateDiffPreviewWithPatch(
      page,
      messageId,
      [
        '*** Begin Patch',
        '*** Update File: src/aligned-report.ts',
        '@@ -10,7 +10,8 @@',
        ' context 1',
        ' context 2',
        ' context 3',
        ' context 4',
        ' context 5',
        ' context 6',
        ' context 7',
        '+changed row',
        '*** End Patch',
      ].join('\n')
    );

    const preview = page.locator(`[data-msg-id="${messageId}"] .diff-view-lines`);
    const firstChange = preview.locator('.diff-view-line-addition').first();
    await expect(firstChange).toContainText('changed row');

    const topOffset = await firstChange.evaluate((row) => {
      const viewport = row.closest<HTMLElement>('.diff-view-lines')!;
      return row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    });
    expect(topOffset).toBeGreaterThanOrEqual(0);
    expect(topOffset).toBeLessThan(2);
  });

  test('opens the diff dialog without obscuring horizontal scrolling', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    await expect(page.locator('.interactive-list')).toBeVisible();

    const messageId = 'message-diff-preview-assistant-59';
    await updateDiffPreviewWithPatch(page, messageId, makeWideDiffPatch(8));

    const preview = page.locator(`[data-msg-id="${messageId}"] .diff-view-lines`);
    const dimensions = await preview.evaluate((viewport) => {
      const viewportRect = viewport.getBoundingClientRect();
      const shell = viewport.closest<HTMLElement>('.diff-view-lines-shell')!;
      const rows = Array.from(viewport.querySelectorAll<HTMLElement>('.diff-view-line'));
      const visibleRows = rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top < viewportRect.bottom && rect.bottom > viewportRect.top;
      });
      const toggle = shell
        .closest<HTMLElement>('.diff-view-file')!
        .querySelector<HTMLElement>('.diff-view-toggle')!;
      const fadeHeight = Number.parseFloat(getComputedStyle(shell, '::after').height);

      return {
        clientHeight: viewport.clientHeight,
        fadeHeight,
        hasHorizontalScrollbar: !!shell.querySelector('.diff-view-scrollbar-horizontal'),
        rowHeight: rows[0]!.getBoundingClientRect().height,
        shellHeight: shell.getBoundingClientRect().height,
        toggleInHeader: toggle.parentElement?.classList.contains('diff-view-item-expandable'),
        visibleRowCount: visibleRows.length,
      };
    });

    expect(dimensions.visibleRowCount).toBe(6);
    expect(dimensions.clientHeight).toBe(dimensions.rowHeight * 6);
    expect(dimensions.hasHorizontalScrollbar).toBe(false);
    expect(dimensions.shellHeight).toBe(dimensions.clientHeight + 1);
    expect(dimensions.fadeHeight).toBe(dimensions.rowHeight / 2);
    expect(dimensions.toggleInHeader).toBe(true);

    const toggle = page.locator(`[data-msg-id="${messageId}"] .diff-view-toggle`);
    await expect(toggle).toHaveAttribute('title', 'Expand diff preview');
    await expect
      .poll(() => toggle.evaluate((button) => getComputedStyle(button).opacity))
      .toBe('0.35');

    const header = page.locator(`[data-msg-id="${messageId}"] .diff-view-item`);
    const headerBounds = await header.boundingBox();
    expect(headerBounds).not.toBeNull();
    await page.mouse.move(headerBounds!.x + 4, headerBounds!.y + 4);
    await expect
      .poll(() => toggle.evaluate((button) => getComputedStyle(button).opacity))
      .toBe('0.7');

    await toggle.hover();
    await expect
      .poll(() => toggle.evaluate((button) => getComputedStyle(button).opacity))
      .toBe('1');
    const headerTopBeforeExpansion = await header.evaluate(
      (element) => element.getBoundingClientRect().top
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await waitForAnimationFrames(page, 4);
    const headerTopAfterExpansion = await header.evaluate(
      (element) => element.getBoundingClientRect().top
    );
    expect(Math.abs(headerTopAfterExpansion - headerTopBeforeExpansion)).toBeLessThan(2);

    const expandedPreview = page.locator('.diff-view-overlay-lines');
    await expect(expandedPreview).toBeVisible();
    const expandedLayout = await expandedPreview.evaluate((viewport) => {
      viewport.scrollLeft = viewport.scrollWidth;
      return {
        clientWidth: viewport.clientWidth,
        overflowX: getComputedStyle(viewport).overflowX,
        scrollLeft: viewport.scrollLeft,
        scrollWidth: viewport.scrollWidth,
      };
    });

    expect(expandedLayout.scrollWidth).toBeGreaterThan(expandedLayout.clientWidth);
    expect(expandedLayout.scrollLeft).toBeGreaterThan(0);
    expect(expandedLayout.overflowX).toBe('auto');

    await page.waitForTimeout(300);
    const list = page.locator('.interactive-list');
    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 400);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);
    const expandedOverlayAnchor = await getVisibleMessageAnchor(list);
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      200
    );

    await updateDiffPreviewWithPatch(page, messageId, makeWideDiffPatch(30));
    const expandedOverlaySamples = await sampleMessageTopAcrossFrames(
      list,
      expandedOverlayAnchor.id,
      4
    );

    const expandedMetrics = await getScrollMetrics(page, '.interactive-list');
    expect(
      expandedOverlaySamples.every(
        (top) => top !== null && Math.abs(top - expandedOverlayAnchor.top) < 1.5
      ),
      JSON.stringify({ expandedOverlayAnchor, expandedOverlaySamples })
    ).toBe(true);
    expect(expandedMetrics.distanceFromBottom).toBeGreaterThan(200);
    await expect(page.locator('.jump-to-latest-button')).toHaveCount(0);

    await page.locator('.diff-view-overlay-close').click();
    await expect(page.locator('.diff-view-overlay')).toHaveCount(0);
    const jumpToLatest = page.locator('.jump-to-latest-button');
    await expect(jumpToLatest).toBeVisible();
    await jumpToLatest.click();
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(3);

    const focusPreview = page.locator(
      '[data-msg-id="message-diff-preview-assistant-58"] .diff-view-lines'
    );
    await focusPreview.focus();
    await expect(focusPreview).toBeFocused();
    await waitForAnimationFrames(page, 2);
    const focusedAnchor = await getVisibleMessageAnchor(list);

    await updateDiffPreview(page, messageId, 12);
    const focusedSamples = await sampleMessageTopAcrossFrames(list, focusedAnchor.id, 4);

    const focusedMetrics = await getScrollMetrics(page, '.interactive-list');
    expect(
      focusedSamples.every((top) => top !== null && Math.abs(top - focusedAnchor.top) < 1.5),
      JSON.stringify({ focusedAnchor, focusedSamples })
    ).toBe(true);
    expect(focusedMetrics.distanceFromBottom).toBeGreaterThan(200);

    await page.locator('[contenteditable="true"]').focus();
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(3);
  });

  test('keeps a focused diff header fixed when it is expanded after scrolling', async ({
    page,
  }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    const messageId = 'message-diff-preview-assistant-30';
    await updateExpandableDiffPreview(page, messageId);
    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * 0.5);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 4);

    const toggle = page.locator(`[data-msg-id="${messageId}"] .diff-view-toggle`);
    const header = page.locator(`[data-msg-id="${messageId}"] .diff-view-item`);
    await expect(toggle).toBeAttached();
    await toggle.scrollIntoViewIfNeeded();
    await toggle.focus();

    await list.evaluate((element) => {
      element.scrollTop += 100;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 2);
    const headerTopBeforeExpansion = await header.evaluate((element) => {
      const scrollList = element.closest<HTMLElement>('.interactive-list')!;
      return element.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
    });

    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(300);
    await waitForAnimationFrames(page, 4);

    const headerTopAfterExpansion = await header.evaluate((element) => {
      const scrollList = element.closest<HTMLElement>('.interactive-list')!;
      return element.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
    });
    expect(Math.abs(headerTopAfterExpansion - headerTopBeforeExpansion)).toBeLessThan(2);
  });

  test('stops following the bottom when an expanded diff is collapsed', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    const messageId = 'message-diff-preview-assistant-59';
    await updateExpandableDiffPreview(page, messageId);
    const toggle = page.locator(`[data-msg-id="${messageId}"] .diff-view-toggle`);
    await expect(toggle).toBeAttached();

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    await toggle.evaluate((button) => (button as HTMLButtonElement).click());
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await waitForAnimationFrames(page, 4);
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    await toggle.evaluate((button) => {
      const measure = button.getBoundingClientRect.bind(button);
      button.getBoundingClientRect = () => {
        const rect = measure();
        return button.getAttribute('aria-expanded') === 'false'
          ? new DOMRect(rect.x, rect.y - 800, rect.width, rect.height)
          : rect;
      };
    });

    const collapseDistances = await toggle.evaluate(async (button) => {
      const scrollList = button.closest<HTMLElement>('.interactive-list')!;
      const sample = () => scrollList.scrollHeight - scrollList.clientHeight - scrollList.scrollTop;
      (button as HTMLButtonElement).click();
      const distances = [sample()];
      for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        distances.push(sample());
      }
      return distances;
    });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    expect(Math.max(...collapseDistances)).toBeLessThan(3);

    await page.waitForTimeout(300);
    const detachedAnchor = await getVisibleMessageAnchor(list);
    await updateDiffPreview(page, messageId, 12);
    const detachedSamples = await sampleMessageTopAcrossFrames(list, detachedAnchor.id, 4);

    const detachedMetrics = await getScrollMetrics(page, '.interactive-list');
    expect(
      detachedSamples.every((top) => top !== null && Math.abs(top - detachedAnchor.top) < 1.5),
      JSON.stringify({ detachedAnchor, detachedSamples })
    ).toBe(true);
    expect(detachedMetrics.distanceFromBottom).toBeGreaterThan(200);
  });

  test('does not reattach to bottom after a zero-delta layout scroll event', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect(page.locator('[data-msg-id="message-diff-preview-assistant-59"]')).toBeAttached();
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then(
          (metrics) => metrics.scrollHeight - metrics.clientHeight
        )
      )
      .toBeGreaterThan(1_000);
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(3);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -8, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 8);
    });
    await waitForAnimationFrames(page, 3);

    const detachedDistance = (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom;
    expect(detachedDistance).toBeGreaterThan(3);
    expect(detachedDistance).toBeLessThan(15);

    await list.evaluate((element) => {
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    const afterDistance = (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom;
    expect(afterDistance).toBeGreaterThan(3);
    expect(afterDistance).toBeLessThan(15);
  });

  test('never resumes bottom follow while scrolling through stale diff heights', async ({
    page,
  }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    for (let index = 20; index < 46; index += 1) {
      await updateDiffPreview(page, `message-diff-preview-assistant-${index}`, 8);
    }
    await waitForAnimationFrames(page, 5);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    const distances: number[] = [];
    for (let index = 0; index < 36; index += 1) {
      await page.mouse.wheel(0, -240);
      await waitForAnimationFrames(page, 2);
      distances.push((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom);
    }

    const detachedIndex = distances.findIndex((distance) => distance > 100);
    expect(detachedIndex).toBeGreaterThanOrEqual(0);
    for (const distance of distances.slice(detachedIndex)) {
      expect(distance).toBeGreaterThan(50);
    }
  });

  test('keeps the visible message anchored when older diff history loads', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&windowed=1&deferHistory=1&expandedActivity=1&messagePageSize=50'
    );
    const list = page.locator('.interactive-list');
    const historyBanner = page.locator('.message-history-banner');
    await expect(list).toBeVisible();
    await expect(page.locator('[data-msg-id="message-diff-preview-user-0"]')).toHaveCount(0);
    await expect(historyBanner).toBeVisible();
    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const harness = window as Window & {
            __varroE2E?: { pendingHistoryRequestCount?: () => number };
          };
          return harness.__varroE2E?.pendingHistoryRequestCount?.() ?? 0;
        })
      )
      .toBe(1);

    for (let index = 36; index < 45; index += 1) {
      await updateDiffPreview(page, `message-diff-preview-assistant-${index}`, 12);
    }
    await waitForAnimationFrames(page, 4);

    await page.locator('.chat-main-column-shell').evaluate(async (shell) => {
      shell.style.maxWidth = 'none';
      for (let frame = 0; frame <= 8; frame += 1) {
        shell.style.width = `${760 - frame * 30}px`;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1000, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(historyBanner).toHaveClass(/is-loading/);
    const anchor = await getVisibleMessageAnchor(list);
    expect(anchor.id).toBe('message-diff-preview-user-35');

    const released = await page.evaluate(() => {
      const harness = window as Window & {
        __varroE2E?: { releaseNextHistoryRequest?: () => boolean };
      };
      return harness.__varroE2E?.releaseNextHistoryRequest?.() ?? false;
    });
    expect(released).toBe(true);

    const anchorSamples = await sampleMessageTopAcrossFrames(list, anchor.id, 8);
    expect(
      anchorSamples.every((top) => top !== null && Math.abs(top - anchor.top) < 1.5),
      JSON.stringify({ anchor, anchorSamples })
    ).toBe(true);

    await expect
      .poll(() =>
        list.evaluate((element) => {
          const loadedOlderRow = element.querySelector(
            '[data-msg-id="message-diff-preview-user-10"]'
          );
          const topSpacerHeight =
            element.querySelector<HTMLElement>('.virtual-spacer-top')?.getBoundingClientRect()
              .height ?? 0;
          return !!loadedOlderRow || topSpacerHeight > 100;
        })
      )
      .toBe(true);

    const boundary = page.locator('[data-msg-id="message-diff-preview-user-35"]');
    await expect(boundary).toBeAttached();
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      100
    );
  });

  test('loads and navigates to an unloaded sticky boundary prompt after a width change', async ({
    page,
  }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&windowed=1&boundarySticky=1&expandedActivity=1&messagePageSize=50'
    );
    const list = page.locator('.interactive-list');
    const targetRow = page.locator('[data-msg-id="message-diff-preview-user-35"]');
    const targetCard = targetRow.locator('.user-message-card');
    const sticky = page.locator('.latest-user-message-sticky');
    await expect(list).toBeVisible();
    await expect(targetRow).toHaveCount(0);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      element.scrollTop = 80;
      element.dispatchEvent(new Event('scroll'));
    });

    await expect(sticky).toContainText('Review asynchronous report change 35.');
    await page.locator('.chat-main-column-shell').evaluate(async (shell) => {
      shell.style.maxWidth = 'none';
      for (let frame = 0; frame <= 12; frame += 1) {
        shell.style.width = `${760 - frame * 20}px`;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const outerScrollTop = await installOuterScrollSentinel(page);
    const sawLoading = await sticky.evaluate((card) => {
      (card as HTMLElement).click();
      const loading = card.querySelector<HTMLElement>('.latest-user-message-sticky-loading');
      const spinner = card.querySelector<HTMLElement>('.latest-user-message-sticky-spinner');
      const bounds = loading?.getBoundingClientRect();
      return (
        !(loading?.textContent?.includes('Loading…') ?? false) &&
        !!spinner &&
        !!bounds &&
        bounds.width > 0 &&
        bounds.height > 0
      );
    });
    expect(sawLoading).toBe(true);

    await expect(targetCard).toBeAttached();
    await expect
      .poll(() =>
        getStickyMessageAlignment(targetCard).then((geometry) => Math.abs(geometry.delta))
      )
      .toBeLessThanOrEqual(1);
    expect(await page.locator('#root').evaluate((root) => root.scrollTop)).toBe(outerScrollTop);
  });

  test('navigates after loading assistant-heavy paginated history', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=assistant-heavy-history&windowed=1');
    const list = page.locator('.interactive-list');
    const sticky = page.locator('.latest-user-message-sticky');
    const targetRow = page.locator('[data-msg-id="message-assistant-heavy-target"]');
    const targetCard = targetRow.locator('.user-message-card');
    await expect(list).toBeVisible();
    await expect(targetRow).toHaveCount(0);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      element.scrollTop = 32;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(sticky).toContainText('Apply the needed fixes/improvements');
    const outerScrollTop = await installOuterScrollSentinel(page);
    await sticky.evaluate((card) => (card as HTMLElement).click());

    await expect(targetCard).toBeAttached();
    await page.waitForTimeout(500);
    await expect(targetCard).toBeAttached();
    await expect
      .poll(() =>
        getStickyMessageAlignment(targetCard).then((geometry) => Math.abs(geometry.delta))
      )
      .toBeLessThanOrEqual(1);
    expect(await page.locator('#root').evaluate((root) => root.scrollTop)).toBe(outerScrollTop);
  });
});

test.describe('sticky preview overlap', () => {
  test('hides immediately when next user message reaches the painted sticky overlay', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=sticky-preview');
    const list = page.locator('.interactive-list');
    const sticky = page.locator('.latest-user-message-sticky');

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);
    await expect(sticky).toBeVisible();

    const overlapDetected = await list.evaluate((element) => {
      const stickyEl = document.querySelector('.latest-user-message-sticky-overlay');
      const nextPrompt = document.querySelector(
        '[data-msg-id="message-sticky-user-2"] .user-message-card'
      );
      if (!stickyEl || !nextPrompt) return false;

      const step = 5;
      for (let i = 0; i < 600; i++) {
        element.scrollTop += step;
        element.dispatchEvent(new Event('scroll'));

        const currentStickyEl = document.querySelector('.latest-user-message-sticky-overlay');
        const currentPromptEl = document.querySelector(
          '[data-msg-id="message-sticky-user-2"] .user-message-card'
        );
        if (!currentStickyEl || !currentPromptEl) break;

        const currentStickyBottom = currentStickyEl.getBoundingClientRect().bottom;
        const currentPromptTop = currentPromptEl.getBoundingClientRect().top;
        if (currentPromptTop < currentStickyBottom) {
          return true;
        }
      }
      return false;
    });

    expect(overlapDetected).toBe(false);
  });

  test('sticky hides when scrolling back up toward its source message', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=sticky-preview');
    const list = page.locator('.interactive-list');
    const sticky = page.locator('.latest-user-message-sticky');

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);
    await expect(sticky).toBeVisible();

    await list.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);
    await waitForAnimationFrame(page);

    await expect(sticky).not.toBeVisible();
  });
});
