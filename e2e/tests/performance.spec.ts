import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EState, waitForAnimationFrame } from './helpers';

async function getRenderedMessageRowCount(page: Page) {
  return getE2EState(page, () => document.querySelectorAll('[data-msg-id]').length);
}

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

test('large transcripts keep rendered rows bounded while the chat width changes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
  await expect.poll(() => getRenderedMessageRowCount(page)).toBeLessThan(90);

  const list = page.locator('.interactive-list');
  await list.evaluate((element) => {
    element.scrollTop = Math.floor(element.scrollHeight / 2);
    element.dispatchEvent(new Event('scroll'));
  });
  await waitForAnimationFrame(page);
  const initialAnchor = await list.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
    if (!row) return null;
    return { id: row.dataset.msgId, top: row.getBoundingClientRect().top - bounds.top };
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

  await page.locator('.chat-main-column-shell').evaluate(async (shell) => {
    shell.style.maxWidth = 'none';
    for (let frame = 0; frame <= 120; frame += 1) {
      const progress = frame <= 60 ? frame / 60 : (120 - frame) / 60;
      shell.style.width = `${900 - progress * 480}px`;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  await page.waitForTimeout(120);
  await waitForAnimationFrame(page);

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

  const finalViewport = await list.evaluate((element, anchorId) => {
    const bounds = element.getBoundingClientRect();
    const visibleRows = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].filter(
      (row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      }
    );
    const anchor = visibleRows.find((row) => row.dataset.msgId === anchorId);
    return {
      visibleRows: visibleRows.length,
      anchorTop: anchor ? anchor.getBoundingClientRect().top - bounds.top : null,
    };
  }, initialAnchor!.id);
  expect(finalViewport.visibleRows).toBeGreaterThan(0);
  expect(finalViewport.anchorTop).not.toBeNull();
  expect(Math.abs(finalViewport.anchorTop! - initialAnchor!.top)).toBeLessThanOrEqual(3);

  await page.locator('.chat-main-column-shell').evaluate(async (shell) => {
    for (let frame = 0; frame <= 40; frame += 1) {
      shell.style.width = `${900 - frame * 12}px`;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  await page.waitForTimeout(120);
  await list.evaluate((element) => {
    element.scrollTop = Math.floor(element.scrollHeight * 0.75);
    element.dispatchEvent(new Event('scroll'));
  });
  await waitForAnimationFrame(page);
  const visibleAfterOneWayResize = await list.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    }).length;
  });
  expect(visibleAfterOneWayResize).toBeGreaterThan(0);
  expect(await getRenderedMessageRowCount(page)).toBeLessThan(90);
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
