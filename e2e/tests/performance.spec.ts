import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EState, waitForAnimationFrame } from './helpers';

async function getRenderedMessageRowCount(page: Page) {
  return getE2EState(page, () => document.querySelectorAll('[data-msg-id]').length);
}

test('persistent status pulses visibly alternate between held states', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=status-filters');

  const result = await page
    .locator('.session-item-indicator.is-attention')
    .evaluate(async (element) => {
      const animation = element
        .getAnimations()
        .find(
          (candidate) =>
            candidate instanceof CSSAnimation && candidate.animationName === 'status-pulse'
        );
      if (!(animation?.effect instanceof KeyframeEffect)) {
        throw new Error('status-pulse keyframes are unavailable');
      }

      const startTime = Number(animation.currentTime);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const advanced = Number(animation.currentTime) > startTime;
      animation.pause();

      const sample = (time: number) => {
        animation.currentTime = time;
        const style = getComputedStyle(element);
        return Number(style.opacity);
      };

      return {
        advanced,
        bright: sample(200),
        dim: sample(1200),
      };
    });

  expect(result.advanced).toBe(true);
  expect(result.bright).toBe(1);
  expect(result.dim).toBe(0.4);
});

test('large transcripts keep rendered rows bounded while scrolling', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');

  await expect(page.locator('.chat-header-title-text').first()).toHaveText('Large transcript');
  const list = page.locator('.interactive-list');
  await expect(list).toBeVisible();

  await expect.poll(() => getRenderedMessageRowCount(page)).toBeLessThan(90);

  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
    element.dispatchEvent(new Event('scroll'));
  });
  await waitForAnimationFrame(page);
  await expect.poll(() => getRenderedMessageRowCount(page)).toBeLessThan(90);

  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await waitForAnimationFrame(page);
  await expect.poll(() => getRenderedMessageRowCount(page)).toBeLessThan(90);

  await list.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 40);
    element.dispatchEvent(new Event('scroll'));
  });
  await waitForAnimationFrame(page);
  await expect.poll(() => getRenderedMessageRowCount(page)).toBeLessThan(90);

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
});

test('burst scrolling avoids synchronous mounted-row geometry scans', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');
  const list = page.locator('.interactive-list');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
    element.scrollTop = element.scrollHeight / 2;
    element.dispatchEvent(new Event('scroll'));
  });
  await waitForAnimationFrame(page);

  const rowRectReads = await list.evaluate((element) => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    let reads = 0;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.hasAttribute('data-msg-id')) reads += 1;
      return originalGetBoundingClientRect.call(this);
    };

    try {
      const initialTop = element.scrollTop;
      for (let step = 1; step <= 40; step += 1) {
        element.scrollTop = initialTop + step * 5;
        element.dispatchEvent(new Event('scroll'));
      }
      return reads;
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  expect(rowRectReads).toBeLessThan(100);
});

test('appending a message does not remount the full transcript', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
  await expect.poll(() => getRenderedMessageRowCount(page)).toBeLessThan(90);

  const stats = await page.locator('.interactive-list').evaluate(async (element) => {
    // Playwright serializes this callback, so the helper must remain inside its browser scope.
    // oxlint-disable-next-line consistent-function-scoping
    const countRows = (node: Node) => {
      if (!(node instanceof Element)) return 0;
      return (
        (node.matches('[data-msg-id]') ? 1 : 0) + node.querySelectorAll('[data-msg-id]').length
      );
    };
    let mountedRows = element.querySelectorAll('[data-msg-id]').length;
    let peakMountedRows = mountedRows;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) mountedRows -= countRows(node);
        for (const node of record.addedNodes) {
          mountedRows += countRows(node);
          peakMountedRows = Math.max(peakMountedRows, mountedRows);
        }
      }
    });
    observer.observe(element, { childList: true, subtree: true });

    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'message-large-assistant-appended',
              sessionID: 'session-large-transcript',
              role: 'assistant',
              time: { created: Date.now() },
              parentID: 'message-large-user-239',
              modelID: 'model-test',
              providerID: 'provider-test',
              mode: 'primary',
              path: { cwd: '/workspace', root: '/workspace' },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          },
        },
      },
      '*'
    );

    for (let frame = 0; frame < 6; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    observer.disconnect();
    return {
      peakMountedRows,
      finalMountedRows: element.querySelectorAll('[data-msg-id]').length,
    };
  });

  expect(stats.peakMountedRows).toBeLessThan(90);
  expect(stats.finalMountedRows).toBeLessThan(90);
});

test('large transcripts keep rendered rows bounded while narrowing a detached chat', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
  await expect.poll(() => getRenderedMessageRowCount(page)).toBeLessThan(90);

  const list = page.locator('.interactive-list');
  const shell = page.locator('.chat-main-column-shell');
  await shell.evaluate(async (element) => {
    element.style.maxWidth = 'none';
    element.style.width = '900px';
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await list.evaluate((element) => {
    // Scroll coordinates only place the fixture; same-row viewport geometry is the jump oracle.
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
    element.scrollTop = Math.floor(element.scrollHeight / 2);
    element.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(300);
  await waitForAnimationFrame(page);
  const initialAnchor = await list.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
    if (!row?.dataset.msgId) return null;
    return {
      id: row.dataset.msgId,
      top: row.getBoundingClientRect().top - bounds.top,
      width: bounds.width,
    };
  });
  expect(initialAnchor).not.toBeNull();

  await page.evaluate(() => {
    const listElement = document.querySelector('.interactive-list');
    if (!listElement) return;
    listElement.setAttribute(
      'data-max-resize-rows',
      String(listElement.querySelectorAll('[data-msg-id]').length)
    );
    listElement.setAttribute('data-added-resize-rows', '0');
    listElement.setAttribute('data-removed-resize-rows', '0');
    const observer = new MutationObserver((records) => {
      let addedRows = 0;
      let removedRows = 0;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          addedRows += node.matches('[data-msg-id]') ? 1 : 0;
          addedRows += node.querySelectorAll('[data-msg-id]').length;
        }
        for (const node of record.removedNodes) {
          if (!(node instanceof Element)) continue;
          removedRows += node.matches('[data-msg-id]') ? 1 : 0;
          removedRows += node.querySelectorAll('[data-msg-id]').length;
        }
      }
      listElement.setAttribute(
        'data-added-resize-rows',
        String(Number(listElement.getAttribute('data-added-resize-rows') || 0) + addedRows)
      );
      listElement.setAttribute(
        'data-removed-resize-rows',
        String(Number(listElement.getAttribute('data-removed-resize-rows') || 0) + removedRows)
      );
      listElement.setAttribute(
        'data-max-resize-rows',
        String(
          Math.max(
            Number(listElement.getAttribute('data-max-resize-rows') || 0),
            listElement.querySelectorAll('[data-msg-id]').length,
            addedRows
          )
        )
      );
    });
    observer.observe(listElement, { childList: true, subtree: true });
    (listElement as Element & { resizeRowObserver?: MutationObserver }).resizeRowObserver =
      observer;
  });

  const resizeSamples = await shell.evaluate(async (element, anchorId) => {
    const listElement = document.querySelector<HTMLElement>('.interactive-list')!;
    const sample = (stage: string) => {
      const anchor = listElement.querySelector<HTMLElement>(
        `[data-msg-id="${CSS.escape(anchorId)}"]`
      );
      const rows = [...listElement.querySelectorAll<HTMLElement>('[data-msg-id]')];
      const anchorIndex = rows.indexOf(anchor!);
      const previousRow = anchorIndex > 0 ? rows[anchorIndex - 1] : null;
      return {
        stage,
        width: listElement.getBoundingClientRect().width,
        scrollTop: listElement.scrollTop,
        topPad: Number.parseFloat(
          listElement.querySelector<HTMLElement>('.virtual-spacer-top')?.style.height || '0'
        ),
        top: anchor?.isConnected
          ? anchor.getBoundingClientRect().top - listElement.getBoundingClientRect().top
          : null,
        height: anchor?.isConnected ? anchor.getBoundingClientRect().height : null,
        previousId: previousRow?.dataset.msgId ?? null,
        previousTop: previousRow
          ? previousRow.getBoundingClientRect().top - listElement.getBoundingClientRect().top
          : null,
        previousHeight: previousRow?.getBoundingClientRect().height ?? null,
      };
    };
    const samples = [sample('before')];
    for (let frame = 1; frame <= 40; frame += 1) {
      element.style.width = `${900 - frame * 12}px`;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(sample(`resize-${frame}`));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 180));
    for (let frame = 1; frame <= 3; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(sample(`settled-${frame}`));
    }
    return samples;
  }, initialAnchor!.id);

  const resizeStats = await list.evaluate((element) => {
    const result = {
      maxRenderedRows: Number(element.getAttribute('data-max-resize-rows') || 0),
      addedRows: Number(element.getAttribute('data-added-resize-rows') || 0),
      removedRows: Number(element.getAttribute('data-removed-resize-rows') || 0),
    };
    (element as Element & { resizeRowObserver?: MutationObserver }).resizeRowObserver?.disconnect();
    return result;
  });
  expect(resizeStats.maxRenderedRows).toBeLessThan(90);
  expect(resizeStats.addedRows).toBeLessThan(90);
  expect(resizeStats.removedRows).toBeLessThan(90);
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

  const finalVisibleRows = await list.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    }).length;
  });
  expect(finalVisibleRows).toBeGreaterThan(0);
  expect(await getRenderedMessageRowCount(page)).toBeLessThan(90);

  const mountedSamples = resizeSamples.filter(
    (sample): sample is typeof sample & { top: number } => sample.top !== null
  );
  const geometry = {
    anchorId: initialAnchor!.id,
    initialTop: initialAnchor!.top,
    initialWidth: initialAnchor!.width,
    finalTop: resizeSamples.at(-1)?.top ?? null,
    finalWidth: resizeSamples.at(-1)?.width ?? null,
    maxDelta: Math.max(
      ...mountedSamples.map((sample) => Math.abs(sample.top - initialAnchor!.top))
    ),
    samples: resizeSamples,
  };
  expect(mountedSamples, JSON.stringify(geometry)).toHaveLength(resizeSamples.length);
  expect(geometry.finalWidth!, JSON.stringify(geometry)).toBeLessThan(geometry.initialWidth - 400);
  expect(geometry.maxDelta, JSON.stringify(geometry)).toBeLessThanOrEqual(3);
});

test('width resizing preserves bottom follow and respects user detachment', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');
  const list = page.locator('.interactive-list');
  const shell = page.locator('.chat-main-column-shell');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await shell.evaluate(async (element) => {
    element.style.maxWidth = 'none';
    for (let frame = 0; frame <= 40; frame += 1) {
      element.style.width = `${900 - frame * 10.5}px`;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  await page.waitForTimeout(120);
  await expect
    .poll(() =>
      list.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
    )
    .toBeLessThanOrEqual(3);

  await shell.evaluate(async (element) => {
    const messageList = document.querySelector<HTMLElement>('.interactive-list')!;
    for (let frame = 0; frame <= 40; frame += 1) {
      element.style.width = `${480 + frame * 10.5}px`;
      if (frame === 10) {
        messageList.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
        messageList.scrollTop = Math.max(0, messageList.scrollTop - 300);
        messageList.dispatchEvent(new Event('scroll'));
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  await page.waitForTimeout(120);

  const detachedDistance = await list.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight
  );
  expect(detachedDistance).toBeGreaterThan(100);
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
  expect(await getRenderedMessageRowCount(page)).toBeLessThan(90);
});
