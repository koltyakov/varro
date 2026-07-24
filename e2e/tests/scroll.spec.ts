import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { getScrollMetrics } from './helpers';

async function waitForAnimationFrame(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

async function waitForAnimationFrames(page: Page, count: number) {
  for (let index = 0; index < count; index += 1) {
    await waitForAnimationFrame(page);
  }
}

async function appendDeltaToLastLargeAssistant(
  page: Page,
  delta: string
) {
  await page.evaluate((nextDelta) => {
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'session-large-transcript',
            messageID: 'message-large-assistant-239',
            partID: 'message-large-assistant-239-text-1',
            field: 'text',
            delta: nextDelta,
          },
        },
      },
      '*'
    );
  }, delta);
}

async function getVirtualScrollSample(list: Locator) {
  return list.evaluate((element) => {
    const containerRect = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')];
    const firstVisible = rows.find((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
    });
    const id = firstVisible?.dataset.msgId ?? '';
    const match = /message-heterogeneous-(user|assistant)-(\d+)(?:-([ab]))?/.exec(id);
    const turnIndex = match ? Number(match[2]) : 0;
    const roleOffset = match?.[1] === 'assistant' ? (match[3] === 'b' ? 2 : 1) : 0;
    return {
      scrollTop: element.scrollTop,
      firstIndex: turnIndex * 3 + roleOffset,
      viewportHeight: element.clientHeight,
    };
  });
}

async function getBlankBottomArea(list: Locator) {
  return list.evaluate((element) => {
    const containerRect = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')];
    let lastRenderedBottom = 0;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > lastRenderedBottom) {
        lastRenderedBottom = rect.bottom;
      }
    }
    const viewportBottom = containerRect.bottom;
    const blankPx = Math.max(0, viewportBottom - lastRenderedBottom);
    const hasBottomSpacer = element.querySelector('.interactive-list-track > div:last-child');
    const bottomSpacerHeight = hasBottomSpacer
      ? (hasBottomSpacer as HTMLElement).getBoundingClientRect().height
      : 0;
    return {
      blankPx,
      viewportHeight: element.clientHeight,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      bottomSpacerHeight,
      renderedRowCount: rows.length,
    };
  });
}

async function appendDeltaToRapidStreaming(page: Page, delta: string) {
  await page.evaluate((nextDelta) => {
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'session-rapid-streaming-jitter',
            messageID: 'message-rapid-assistant-streaming',
            partID: 'message-rapid-assistant-streaming-text-1',
            field: 'text',
            delta: nextDelta,
          },
        },
      },
      '*'
    );
  }, delta);
}

async function appendDeltaToMultiAgentStreaming(
  page: Page,
  delta: string
) {
  await page.evaluate((nextDelta) => {
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'session-multi-agent-streaming',
            messageID: 'message-multi-agent-assistant-streaming',
            partID: 'message-multi-agent-assistant-streaming-text-1',
            field: 'text',
            delta: nextDelta,
          },
        },
      },
      '*'
    );
  }, delta);
}

async function updateDiffPreview(
  page: Page,
  messageId: string,
  fileCount: number
) {
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

async function updateExpandableDiffPreview(
  page: Page,
  messageId: string
) {
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

async function updateDiffPreviewWithPatch(
  page: Page,
  messageId: string,
  patchText: string
) {
  const partId = `${messageId}-patch`;

  await page.evaluate(
    ({ id, part, patch }) => {
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'message.part.updated',
            properties: {
              part: {
                id: part,
                sessionID: 'session-diff-preview-large-transcript',
                messageID: id,
                type: 'tool',
                callID: `${part}-call`,
                tool: 'apply_patch',
                state: {
                  status: 'running',
                  input: { patchText: patch },
                  title: 'apply_patch',
                  metadata: {},
                  time: { start: 1 },
                },
              },
            },
          },
        },
        '*'
      );
    },
    { id: messageId, part: partId, patch: patchText }
  );
}

test.describe('auto-scroll', () => {
  test('starts at the bottom of the conversation', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('manual scroll up disengages auto-scroll', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await waitForAnimationFrame(page);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 300);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    const metrics = await getScrollMetrics(page, '.interactive-list');
    expect(metrics.distanceFromBottom).toBeGreaterThan(190);
  });

  test('small upward wheel from bottom does not snap back', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const originalScrollTop = await list.evaluate((element) => element.scrollTop);

    const detachedScrollTop = await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -48, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 48);
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop;
    });

    expect(detachedScrollTop).toBeLessThan(originalScrollTop - 30);

    await page.waitForTimeout(260);
    await waitForAnimationFrames(page, 3);

    const afterSettled = await list.evaluate((element) => element.scrollTop);
    expect(Math.abs(afterSettled - detachedScrollTop)).toBeLessThan(3);
  });

  test('scrolls upward through a large transcript without virtualized content jumps', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const samples: Array<{ target: number; actual: number; visibleRows: number }> = [];
    for (let index = 0; index < 24; index += 1) {
      const sample = await list.evaluate((element) => {
        const target = Math.max(0, element.scrollTop - 700);
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -700, bubbles: true }));
        element.scrollTop = target;
        element.dispatchEvent(new Event('scroll'));
        return { target, actual: element.scrollTop, visibleRows: 0 };
      });
      await waitForAnimationFrames(page, 2);
      const settled = await list.evaluate((element, target) => {
        const containerRect = element.getBoundingClientRect();
        const visibleRows = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].filter(
          (row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
          }
        ).length;
        return { target, actual: element.scrollTop, visibleRows };
      }, sample.target);
      samples.push(settled);
    }

    for (const sample of samples) {
      expect(sample.visibleRows).toBeGreaterThan(0);
      expect(Math.abs(sample.actual - sample.target)).toBeLessThan(90);
    }
  });

  test('mouse wheel upward from mid transcript never jumps backward', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await list.evaluate((element) => {
      element.scrollTop = Math.floor(element.scrollHeight / 2);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    const positions: number[] = [await list.evaluate((element) => element.scrollTop)];
    for (let index = 0; index < 18; index += 1) {
      await page.mouse.wheel(0, -180);
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]).toBeLessThanOrEqual(positions[index - 1]! + 2);
    }

    const visibleRows = await list.evaluate((element) => {
      const containerRect = element.getBoundingClientRect();
      return [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
      }).length;
    });
    expect(visibleRows).toBeGreaterThan(0);
  });

  test('heterogeneous long chat scrolls upward without screen-sized jumps', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=heterogeneous-large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    const samples: Array<{ scrollTop: number; firstIndex: number; viewportHeight: number }> = [
      await getVirtualScrollSample(list),
    ];

    for (let index = 0; index < 35; index += 1) {
      await page.mouse.wheel(0, -180);
      await waitForAnimationFrames(page, 2);
      samples.push(await getVirtualScrollSample(list));
    }

    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1]!;
      const current = samples[index]!;
      const upwardScrollDelta = previous.scrollTop - current.scrollTop;
      expect(current.scrollTop).toBeLessThanOrEqual(previous.scrollTop + 2);
      expect(upwardScrollDelta).toBeLessThan(current.viewportHeight * 0.8);
      expect(current.firstIndex).toBeLessThanOrEqual(previous.firstIndex + 1);
      expect(previous.firstIndex - current.firstIndex).toBeLessThan(14);
    }
  });

  test('keeps visible content anchored while diff previews resize asynchronously', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=diff-preview-large-transcript');
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

    const afterMountedResize = await list.evaluate((element) => {
      const containerRect = element.getBoundingClientRect();
      const firstVisible = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
        (row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
        }
      );
      return {
        anchorId: firstVisible?.dataset.msgId ?? '',
        anchorTop: firstVisible ? firstVisible.getBoundingClientRect().top - containerRect.top : 0,
      };
    });

    expect(afterMountedResize.anchorId).toBe(before.anchorId);
    expect(Math.abs(afterMountedResize.anchorTop - before.anchorTop)).toBeLessThan(3);

    const beforeOffscreenUpdate = afterMountedResize;
    await expect(page.locator('[data-msg-id="message-diff-preview-assistant-0"]')).toHaveCount(0);
    await list.dispatchEvent('wheel', { deltaY: -1 });
    await updateDiffPreview(page, 'message-diff-preview-assistant-0', 24);
    await waitForAnimationFrames(page, 4);

    const afterOffscreenUpdate = await list.evaluate((element) => {
      const containerRect = element.getBoundingClientRect();
      const firstVisible = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
        (row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
        }
      );
      return {
        anchorId: firstVisible?.dataset.msgId ?? '',
        anchorTop: firstVisible ? firstVisible.getBoundingClientRect().top - containerRect.top : 0,
        maxRenderedMessageRows: Number(element.dataset.maxRenderedMessageRows ?? 0),
      };
    });

    expect(afterOffscreenUpdate.anchorId).toBe(beforeOffscreenUpdate.anchorId);
    expect(Math.abs(afterOffscreenUpdate.anchorTop - beforeOffscreenUpdate.anchorTop)).toBeLessThan(
      3
    );
    expect(afterOffscreenUpdate.maxRenderedMessageRows).toBeLessThan(50);
  });

  test('aligns the first changed diff row with the top of the preview', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=diff-preview-large-transcript');
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

  test('shows six collapsed diff rows with the toggle over the final row', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=diff-preview-large-transcript');
    await expect(page.locator('.interactive-list')).toBeVisible();

    const messageId = 'message-diff-preview-assistant-59';
    await updateExpandableDiffPreview(page, messageId);

    const preview = page.locator(`[data-msg-id="${messageId}"] .diff-view-lines`);
    const dimensions = await preview.evaluate((viewport) => {
      const viewportRect = viewport.getBoundingClientRect();
      const rows = Array.from(viewport.querySelectorAll<HTMLElement>('.diff-view-line'));
      const visibleRows = rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top < viewportRect.bottom && rect.bottom > viewportRect.top;
      });
      const finalVisibleRect = visibleRows.at(-1)!.getBoundingClientRect();
      const toggleRect = viewport
        .closest<HTMLElement>('.diff-view-lines-shell')!
        .querySelector<HTMLElement>('.diff-view-toggle')!
        .getBoundingClientRect();
      const fadeHeight = Number.parseFloat(
        getComputedStyle(viewport.closest<HTMLElement>('.diff-view-lines-shell')!, '::after').height
      );

      return {
        clientHeight: viewport.clientHeight,
        fadeHeight,
        finalRowOverlap: finalVisibleRect.bottom - toggleRect.top,
        rowHeight: rows[0]!.getBoundingClientRect().height,
        visibleRowCount: visibleRows.length,
      };
    });

    expect(dimensions.visibleRowCount).toBe(6);
    expect(dimensions.clientHeight).toBe(dimensions.rowHeight * 6);
    expect(dimensions.finalRowOverlap).toBeGreaterThan(0);
    expect(dimensions.fadeHeight).toBe(dimensions.rowHeight / 2);
  });

  test('stays at the bottom when an expanded diff is collapsed', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=diff-preview-large-transcript');
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
      const sample = () =>
        scrollList.scrollHeight - scrollList.clientHeight - scrollList.scrollTop;
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
  });

  test('does not reattach to bottom after a zero-delta layout scroll event', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=diff-preview-large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

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
    await page.goto('/e2e/harness/index.html?scenario=diff-preview-large-transcript');
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
    await page.goto('/e2e/harness/index.html?scenario=diff-preview-large-transcript&windowed=1');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();
    await expect(page.locator('[data-msg-id="message-diff-preview-user-0"]')).toHaveCount(0);

    for (let index = 36; index < 45; index += 1) {
      await updateDiffPreview(page, `message-diff-preview-assistant-${index}`, 12);
    }
    await waitForAnimationFrames(page, 4);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1000, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });

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
    const anchorTop = await boundary.evaluate((row) => {
      const scrollList = row.closest<HTMLElement>('.interactive-list')!;
      return row.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
    });
    expect(Math.abs(anchorTop)).toBeLessThan(80);
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      100
    );
  });

  test('mixed small chat scrolls upward without random jumps', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=mixed-small-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    const positions: number[] = [await list.evaluate((element) => element.scrollTop)];
    for (let index = 0; index < 18; index += 1) {
      await page.mouse.wheel(0, -160);
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    const viewportHeight = await list.evaluate((element) => element.clientHeight);
    for (let index = 1; index < positions.length; index += 1) {
      const upwardDelta = positions[index - 1]! - positions[index]!;
      expect(positions[index]).toBeLessThanOrEqual(positions[index - 1]! + 2);
      expect(upwardDelta).toBeLessThan(viewportHeight * 0.75);
    }
  });

  test('follows assistant response growth while pinned to the bottom', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    for (let index = 0; index < 6; index += 1) {
      await appendDeltaToLastLargeAssistant(
        page,
        `\n\nStreaming bottom follow chunk ${index}: ${'keep following the bottom '.repeat(10)}`
      );
      await waitForAnimationFrame(page);
    }

    await expect(page.locator('.chat-turn-assistant').last()).toContainText(
      'Streaming bottom follow chunk 5'
    );
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('keeps follow disabled after manual scroll and re-enables at bottom', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const detachedScrollTop = await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -160, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 800);
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop;
    });
    await waitForAnimationFrames(page, 2);

    await appendDeltaToLastLargeAssistant(
      page,
      `\n\nDetached streaming chunk: ${'do not steal scroll position '.repeat(18)}`
    );
    await waitForAnimationFrames(page, 3);

    const afterDetachedDelta = await list.evaluate((element) => element.scrollTop);
    expect(Math.abs(afterDetachedDelta - detachedScrollTop)).toBeLessThan(3);
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      200
    );

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 2);

    await appendDeltaToLastLargeAssistant(
      page,
      `\n\nReattached streaming chunk: ${'follow again '.repeat(24)}`
    );

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });
});

test.describe('scroll stability regressions', () => {
  test('rapid streaming at bottom does not oscillate', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    const positions: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      await appendDeltaToLastLargeAssistant(
        page,
        `\n\nRapid chunk ${index}: ${'filling content '.repeat(6)}`
      );
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((el) => el.scrollTop));
    }

    let upwardJumpCount = 0;
    for (let index = 1; index < positions.length; index += 1) {
      if (positions[index]! < positions[index - 1]! - 3) {
        upwardJumpCount++;
      }
    }
    expect(upwardJumpCount).toBeLessThanOrEqual(1);

    let maxJitterAmplitude = 0;
    for (let index = 2; index < positions.length; index += 1) {
      const jitter = Math.abs(
        positions[index]! - positions[index - 1]! - (positions[index - 1]! - positions[index - 2]!)
      );
      maxJitterAmplitude = Math.max(maxJitterAmplitude, jitter);
    }
    expect(maxJitterAmplitude).toBeLessThan(150);

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('user scroll beyond reattach threshold stays detached', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const scrolledPosition = await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 300);
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop;
    });
    await waitForAnimationFrames(page, 4);

    const afterSettled = await list.evaluate((el) => el.scrollTop);
    expect(Math.abs(afterSettled - scrolledPosition)).toBeLessThan(5);
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      190
    );
  });

  test('no jitter when streaming grows content while auto-scroll follows', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    for (let index = 0; index < 10; index += 1) {
      await appendDeltaToLastLargeAssistant(
        page,
        `\n\nGrowing content block ${index}:\n${'Line of streaming text that exercises the auto-follow logic.\n'.repeat(4)}`
      );
      await waitForAnimationFrames(page, 2);
    }

    await expect(page.locator('.chat-turn-assistant').last()).toContainText(
      'Growing content block 9'
    );
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });
});

test.describe('sticky preview overlap', () => {
  test('hides immediately when next user message reaches the sticky bottom', async ({ page }) => {
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
      const stickyEl = document.querySelector('.latest-user-message-sticky');
      const nextPrompt = document.querySelector(
        '[data-msg-id="message-sticky-user-2"] .user-message-card'
      );
      if (!stickyEl || !nextPrompt) return false;

      const step = 5;
      for (let i = 0; i < 600; i++) {
        element.scrollTop += step;
        element.dispatchEvent(new Event('scroll'));

        const currentStickyEl = document.querySelector('.latest-user-message-sticky');
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

test.describe('auto-scroll re-engage', () => {
  test('re-engages when user scrolls within 10px of bottom', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -160, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 800);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      200
    );

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight - element.clientHeight - 8;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    await appendDeltaToLastLargeAssistant(
      page,
      `\n\nRe-engage test chunk: ${'verify auto-scroll re-engages within 10px threshold '.repeat(12)}`
    );
    await waitForAnimationFrames(page, 4);

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('scroll up during streaming disables follow without snap-back', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    for (let i = 0; i < 3; i += 1) {
      await appendDeltaToRapidStreaming(
        page,
        `\n\nPre-wheel chunk ${i}: ${'content before wheel '.repeat(8)}`
      );
      await waitForAnimationFrames(page, 2);
    }

    const detachedScrollTop = await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 200);
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop;
    });
    await waitForAnimationFrames(page, 3);

    for (let i = 0; i < 3; i += 1) {
      await appendDeltaToRapidStreaming(
        page,
        `\n\nPost-wheel chunk ${i}: ${'content after wheel should not snap back '.repeat(10)}`
      );
      await waitForAnimationFrames(page, 2);
    }

    const afterStreaming = await list.evaluate((element) => element.scrollTop);
    expect(Math.abs(afterStreaming - detachedScrollTop)).toBeLessThan(5);
  });

  test('scrolling to bottom during streaming re-engages follow', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -160, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 500);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      200
    );

    await appendDeltaToRapidStreaming(
      page,
      `\n\nDetached chunk: ${'should not follow '.repeat(10)}`
    );
    await waitForAnimationFrames(page, 3);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    for (let i = 0; i < 4; i += 1) {
      await appendDeltaToRapidStreaming(
        page,
        `\n\nRe-engage chunk ${i}: ${'follow after re-engage '.repeat(12)}`
      );
      await waitForAnimationFrames(page, 2);
    }

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });
});

test.describe('multi-agent scroll stability', () => {
  test('no jitter when streaming at bottom with multiple completed agent responses', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    const positions: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      await appendDeltaToMultiAgentStreaming(
        page,
        `\n\nMulti-agent streaming chunk ${i}: ${`Streaming into a chat with multiple completed agent turns. This exercises the scroll anchoring logic. `.repeat(4)}`
      );
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    let maxFrameDelta = 0;
    for (let i = 1; i < positions.length; i += 1) {
      const frameDelta = Math.abs(positions[i]! - positions[i - 1]!);
      maxFrameDelta = Math.max(maxFrameDelta, frameDelta);
    }

    expect(maxFrameDelta).toBeLessThan(120);

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('no jump to previous agent message during streaming', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    const positions: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      await appendDeltaToMultiAgentStreaming(
        page,
        `\n\nNo-backward-jump chunk ${i}: ${'Verify scroll position only moves forward during streaming. '.repeat(6)}`
      );
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]! - 3);
    }

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });
});

test.describe('rapid streaming jitter resistance', () => {
  test('no jitter at exact bottom during streaming with varying content sizes', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    const positions: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const size =
        i % 2 === 0
          ? 'short'
          : 'long with extra padding to vary content sizes significantly. '.repeat(8);
      await appendDeltaToRapidStreaming(page, `\n\nVarying-size chunk ${i}: ${size}`);
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    let maxOscillation = 0;
    for (let i = 2; i < positions.length; i += 1) {
      const oscillation = Math.abs(
        positions[i]! - positions[i - 1]! - (positions[i - 1]! - positions[i - 2]!)
      );
      maxOscillation = Math.max(maxOscillation, oscillation);
    }

    expect(maxOscillation).toBeLessThan(200);

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('auto-scroll follows rapid sequential streaming deltas', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    for (let i = 0; i < 20; i += 1) {
      await appendDeltaToRapidStreaming(
        page,
        `\n\nRapid sequential chunk ${i}: ${'fast follow delta '.repeat(4)}`
      );
    }
    await waitForAnimationFrames(page, 5);

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(10);
  });

  test('scroll position holds when streaming arrives while scrolled to middle near threshold', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const midScrollTop = await list.evaluate((element) => {
      const mid = Math.floor(element.scrollHeight / 2);
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = mid;
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop;
    });
    await waitForAnimationFrames(page, 3);

    for (let i = 0; i < 8; i += 1) {
      await appendDeltaToRapidStreaming(
        page,
        `\n\nMid-scroll streaming chunk ${i}: ${'viewport should not move while detached '.repeat(6)}`
      );
      await waitForAnimationFrames(page, 2);
    }

    const afterStreaming = await list.evaluate((element) => element.scrollTop);
    expect(Math.abs(afterStreaming - midScrollTop)).toBeLessThan(5);
  });
});

test.describe('viewport content coverage', () => {
  test('no blank bottom space when scrolled to top of a large transcript', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 4);

    const result = await getBlankBottomArea(list);
    expect(result.blankPx).toBeLessThan(result.viewportHeight * 0.5);
    expect(result.renderedRowCount).toBeGreaterThan(0);
  });

  test('virtual spacers keep their measured height in a long varied chat', async ({ page }) => {
    // Principle: virtual spacers represent exact offscreen layout height. If they shrink or collapse,
    // scroll offsets and visible content drift apart even when row math looks otherwise correct.
    await page.goto('/e2e/harness/index.html?scenario=heterogeneous-large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    async function sampleAt(targetRatio: number) {
      await list.evaluate((element, ratio) => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
        element.scrollTop = Math.floor(element.scrollHeight * ratio);
        element.dispatchEvent(new Event('scroll'));
      }, targetRatio);
      await waitForAnimationFrames(page, 4);

      return list.evaluate((element) => {
        const topSpacer = element.querySelector<HTMLElement>('.virtual-spacer-top');
        const bottomSpacer = element.querySelector<HTMLElement>('.virtual-spacer-bottom');
        const rows = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')];
        const containerRect = element.getBoundingClientRect();
        const visibleRows = rows.filter((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
        });

        return {
          topStyleHeight: topSpacer ? Number.parseFloat(topSpacer.style.height) : 0,
          topRenderedHeight: topSpacer?.getBoundingClientRect().height ?? 0,
          topFlexShrink: topSpacer ? getComputedStyle(topSpacer).flexShrink : '',
          bottomStyleHeight: bottomSpacer ? Number.parseFloat(bottomSpacer.style.height) : 0,
          bottomRenderedHeight: bottomSpacer?.getBoundingClientRect().height ?? 0,
          bottomFlexShrink: bottomSpacer ? getComputedStyle(bottomSpacer).flexShrink : '',
          renderedRowCount: rows.length,
          visibleRowCount: visibleRows.length,
          viewportHeight: element.clientHeight,
        };
      });
    }

    const nearTop = await sampleAt(0);
    const midChat = await sampleAt(0.5);
    const samples = [nearTop, midChat];

    const topSpacerSample = samples.find((sample) => sample.topStyleHeight > sample.viewportHeight);
    const bottomSpacerSample = samples.find(
      (sample) => sample.bottomStyleHeight > sample.viewportHeight
    );

    expect(topSpacerSample).toBeTruthy();
    expect(bottomSpacerSample).toBeTruthy();
    expect(
      Math.abs((topSpacerSample?.topRenderedHeight ?? 0) - (topSpacerSample?.topStyleHeight ?? 0))
    ).toBeLessThan(1);
    expect(
      Math.abs(
        (bottomSpacerSample?.bottomRenderedHeight ?? 0) -
          (bottomSpacerSample?.bottomStyleHeight ?? 0)
      )
    ).toBeLessThan(1);
    expect(topSpacerSample?.topFlexShrink).toBe('0');
    expect(bottomSpacerSample?.bottomFlexShrink).toBe('0');

    for (const sample of samples) {
      expect(sample.renderedRowCount).toBeGreaterThan(0);
      expect(sample.visibleRowCount).toBeGreaterThan(0);
    }
  });

  test('huge transcript has a measured scrollbar range', async ({ page }) => {
    // Principle: dragging the native scrollbar in a huge chat must map to real message position.
    // The range must be established from measured layout before virtualization owns the scrollbar.
    await page.goto('/e2e/harness/index.html?scenario=huge-content-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const initial = await list.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      viewportHeight: element.clientHeight,
      renderedRowCount: element.querySelectorAll('[data-msg-id]').length,
    }));

    expect(initial.scrollHeight).toBeGreaterThan(100_000);
    expect(initial.renderedRowCount).toBeLessThan(40);

    const samples: Array<{ ratio: number; firstIndex: number; scrollTop: number }> = [];
    for (const ratio of [0.25, 0.5, 0.75]) {
      const sample = await list.evaluate((element, targetRatio) => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
        element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * targetRatio);
        element.dispatchEvent(new Event('scroll'));
        return { targetRatio, scrollTop: element.scrollTop };
      }, ratio);
      await waitForAnimationFrames(page, 4);
      const firstIndex = await list.evaluate((element) => {
        const containerRect = element.getBoundingClientRect();
        const rows = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')];
        const firstVisible = rows.find((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
        });
        const id = firstVisible?.dataset.msgId ?? '';
        const match = /message-huge-(user|assistant)-(\d+)/.exec(id);
        if (!match) return -1;
        return Number(match[2]) * 2 + (match[1] === 'assistant' ? 1 : 0);
      });
      samples.push({ ratio: sample.targetRatio, firstIndex, scrollTop: sample.scrollTop });
    }

    for (const sample of samples) {
      expect(sample.firstIndex).toBeGreaterThanOrEqual(0);
      expect(Math.abs(sample.firstIndex / 180 - sample.ratio)).toBeLessThan(0.14);
    }

    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]!.firstIndex).toBeGreaterThan(samples[index - 1]!.firstIndex);
      expect(samples[index]!.scrollTop).toBeGreaterThan(samples[index - 1]!.scrollTop);
    }
  });

  test('huge transcript keeps scrollbar mapping stable across repeated jumps', async ({ page }) => {
    // Principle: repeated large scrollbar jumps must preserve both bounded rendering and monotonic
    // position mapping. This catches regressions that only show up after multiple remaps.
    await page.goto('/e2e/harness/index.html?scenario=huge-content-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const samples: Array<{
      ratio: number;
      firstIndex: number;
      renderedRowCount: number;
      topSpacerHeight: number;
      bottomSpacerHeight: number;
    }> = [];

    for (const ratio of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      await list.evaluate((element, targetRatio) => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
        element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * targetRatio);
        element.dispatchEvent(new Event('scroll'));
      }, ratio);
      await waitForAnimationFrames(page, 4);

      const sample = await list.evaluate((element, targetRatio) => {
        const containerRect = element.getBoundingClientRect();
        const rows = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')];
        const firstVisible = rows.find((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
        });
        const id = firstVisible?.dataset.msgId ?? '';
        const match = /message-huge-(user|assistant)-(\d+)/.exec(id);
        return {
          ratio: targetRatio,
          firstIndex: match ? Number(match[2]) * 2 + (match[1] === 'assistant' ? 1 : 0) : -1,
          renderedRowCount: rows.length,
          topSpacerHeight:
            element.querySelector<HTMLElement>('.virtual-spacer-top')?.getBoundingClientRect()
              .height ?? 0,
          bottomSpacerHeight:
            element.querySelector<HTMLElement>('.virtual-spacer-bottom')?.getBoundingClientRect()
              .height ?? 0,
        };
      }, ratio);
      samples.push(sample);
    }

    for (const sample of samples) {
      expect(sample.firstIndex).toBeGreaterThanOrEqual(0);
      expect(sample.renderedRowCount).toBeLessThan(40);
      expect(sample.topSpacerHeight + sample.bottomSpacerHeight).toBeGreaterThan(1000);
      expect(Math.abs(sample.firstIndex / 180 - sample.ratio)).toBeLessThan(0.14);
    }

    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]!.firstIndex).toBeGreaterThan(samples[index - 1]!.firstIndex);
    }
  });

  test('no blank bottom space when scrolling from bottom to top step by step', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const viewportHeight = await list.evaluate((element) => element.clientHeight);
    const steps = 30;
    const stepSize = Math.floor((await list.evaluate((el) => el.scrollHeight)) / steps);

    for (let i = 0; i < steps; i += 1) {
      await list.evaluate((element, target) => {
        element.scrollTop = Math.max(0, element.scrollTop - target);
        element.dispatchEvent(new Event('scroll'));
      }, stepSize);
      await waitForAnimationFrames(page, 2);

      const result = await getBlankBottomArea(list);
      expect(result.renderedRowCount).toBeGreaterThan(0);
      expect(result.blankPx).toBeLessThan(viewportHeight * 0.6);
    }
  });

  test('no blank bottom space when scrolling from top to bottom in heterogeneous chat', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=heterogeneous-large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await list.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    const viewportHeight = await list.evaluate((element) => element.clientHeight);
    const stepSize = Math.floor(viewportHeight * 0.8);

    for (let i = 0; i < 30; i += 1) {
      await list.evaluate((element, step) => {
        element.scrollTop = element.scrollTop + step;
        element.dispatchEvent(new Event('scroll'));
      }, stepSize);
      await waitForAnimationFrames(page, 2);

      const result = await getBlankBottomArea(list);
      expect(result.renderedRowCount).toBeGreaterThan(0);
      if (result.scrollTop + viewportHeight < result.scrollHeight - 50) {
        expect(result.blankPx).toBeLessThan(viewportHeight * 0.6);
      }
    }
  });

  test('viewport always has rendered rows at every scroll position in multi-agent chat', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const scrollHeight = await list.evaluate((el) => el.scrollHeight);
    const viewportHeight = await list.evaluate((el) => el.clientHeight);
    const positions = [
      0,
      scrollHeight * 0.25,
      scrollHeight * 0.5,
      scrollHeight * 0.75,
      scrollHeight - viewportHeight,
    ];

    for (const targetScrollTop of positions) {
      await list.evaluate((element, target) => {
        element.scrollTop = target;
        element.dispatchEvent(new Event('scroll'));
      }, targetScrollTop);
      await waitForAnimationFrames(page, 3);

      const result = await getBlankBottomArea(list);
      expect(result.renderedRowCount).toBeGreaterThan(0);
    }
  });

  test('scroll position stable after scrolling to top and back to bottom', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    const topScrollTop = await list.evaluate((element) => element.scrollTop);
    expect(topScrollTop).toBeLessThan(50);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    const metrics = await getScrollMetrics(page, '.interactive-list');
    expect(metrics.distanceFromBottom).toBeLessThan(15);

    const result = await getBlankBottomArea(list);
    expect(result.blankPx).toBeLessThan(result.viewportHeight * 0.3);
  });
});

async function appendDeltaToMultiAgentLargeStreaming(
  page: Page,
  delta: string
) {
  await page.evaluate((nextDelta) => {
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'session-multi-agent-large-streaming',
            messageID: 'message-mla-assistant-streaming',
            partID: 'message-mla-assistant-streaming-text-1',
            field: 'text',
            delta: nextDelta,
          },
        },
      },
      '*'
    );
  }, delta);
}

test.describe('multi-agent large virtualized scroll stability', () => {
  test('no jitter when scrolling upward through large multi-agent transcript', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-large-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    const positions: number[] = [await list.evaluate((element) => element.scrollTop)];
    for (let index = 0; index < 40; index += 1) {
      await page.mouse.wheel(0, -200);
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]).toBeLessThanOrEqual(positions[index - 1]! + 2);
    }

    const viewportHeight = await list.evaluate((element) => element.clientHeight);
    for (let index = 1; index < positions.length; index += 1) {
      const upwardDelta = positions[index - 1]! - positions[index]!;
      expect(upwardDelta).toBeLessThan(viewportHeight * 0.8);
    }
  });

  test('scroll position stable after top-to-bottom round trip in multi-agent transcript', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-large-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 4);

    const topScrollTop = await list.evaluate((element) => element.scrollTop);
    expect(topScrollTop).toBeLessThan(50);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight - element.clientHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 5);

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom), {
        timeout: 8000,
      })
      .toBeLessThan(80);
  });

  test('no backward jumps during streaming in large multi-agent transcript', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-large-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    const positions: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const size =
        i % 3 === 0
          ? 'Short chunk.'
          : `Longer streaming chunk with varied content. ${'This exercises scroll anchoring with multiple agent responses above. '.repeat(4 + (i % 6))}`;
      await appendDeltaToMultiAgentLargeStreaming(
        page,
        `\n\nMulti-agent large chunk ${i}: ${size}`
      );
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]! - 3);
    }

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('detached scroll holds while streaming in large multi-agent transcript', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-large-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const detachedScrollTop = await list.evaluate((element) => {
      const mid = Math.floor(element.scrollHeight / 2);
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = mid;
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop;
    });
    await waitForAnimationFrames(page, 3);

    for (let i = 0; i < 10; i += 1) {
      await appendDeltaToMultiAgentLargeStreaming(
        page,
        `\n\nDetached streaming chunk ${i}: ${'content should not move viewport '.repeat(6)}`
      );
      await waitForAnimationFrames(page, 2);
    }

    const afterStreaming = await list.evaluate((element) => element.scrollTop);
    expect(Math.abs(afterStreaming - detachedScrollTop)).toBeLessThan(10);
  });

  test('no viewport blank space at any scroll position in multi-agent large transcript', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-large-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const scrollHeight = await list.evaluate((el) => el.scrollHeight);
    const viewportHeight = await list.evaluate((el) => el.clientHeight);
    const positions = [
      0,
      scrollHeight * 0.2,
      scrollHeight * 0.4,
      scrollHeight * 0.6,
      scrollHeight * 0.8,
      scrollHeight - viewportHeight,
    ];

    for (const targetScrollTop of positions) {
      await list.evaluate((element, target) => {
        element.scrollTop = target;
        element.dispatchEvent(new Event('scroll'));
      }, targetScrollTop);
      await waitForAnimationFrames(page, 3);

      const renderedRowCount = await list.evaluate((element) => {
        const containerRect = element.getBoundingClientRect();
        return [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].filter((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
        }).length;
      });
      expect(renderedRowCount).toBeGreaterThan(0);
    }
  });
});

test.describe('bottom scroll stability during height changes', () => {
  test('downward wheel at bottom during streaming does not cause jitter', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.hover();
    const positions: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      await page.mouse.wheel(0, 50);
      await appendDeltaToRapidStreaming(
        page,
        `\n\nBottom-wheel chunk ${i}: ${'content growing while user scrolls down '.repeat(4)}`
      );
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    let maxBackwardJump = 0;
    for (let i = 1; i < positions.length; i += 1) {
      const backward = positions[i - 1]! - positions[i]!;
      maxBackwardJump = Math.max(maxBackwardJump, backward);
    }
    expect(maxBackwardJump).toBeLessThan(25);

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('no oscillation when streaming content varies height significantly', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-large-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    const positions: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const content =
        i % 2 === 0
          ? 'Short.'
          : `${'Long paragraph with significant height variation to test scroll stability during rapid content size changes. '.repeat(6)}`;
      await appendDeltaToMultiAgentLargeStreaming(page, `\n\n${content}`);
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    let oscillationCount = 0;
    for (let i = 2; i < positions.length; i += 1) {
      const d1 = positions[i - 1]! - positions[i - 2]!;
      const d2 = positions[i]! - positions[i - 1]!;
      if ((d1 > 5 && d2 < -5) || (d1 < -5 && d2 > 5)) {
        oscillationCount++;
      }
    }
    expect(oscillationCount).toBeLessThanOrEqual(1);

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('re-engage after detach works smoothly in large multi-agent transcript', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-large-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -160, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 600);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      200
    );

    await appendDeltaToMultiAgentLargeStreaming(
      page,
      `\n\nDetached chunk: ${'should not follow '.repeat(8)}`
    );
    await waitForAnimationFrames(page, 3);
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      200
    );

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight - element.clientHeight - 5;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    for (let i = 0; i < 6; i += 1) {
      await appendDeltaToMultiAgentLargeStreaming(
        page,
        `\n\nRe-engage chunk ${i}: ${'follow after re-engage '.repeat(8)}`
      );
      await waitForAnimationFrames(page, 2);
    }

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });
});
