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

test('large transcripts keep rendered rows bounded while the chat width changes', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
  await expect.poll(() => getRenderedMessageRowCount(page)).toBeLessThan(90);

  await page.evaluate(() => {
    const list = document.querySelector('.interactive-list');
    if (!list) return;
    list.setAttribute('data-max-resize-rows', String(list.querySelectorAll('[data-msg-id]').length));
    const observer = new MutationObserver((records) => {
      let addedRows = 0;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          addedRows += node.matches('[data-msg-id]') ? 1 : 0;
          addedRows += node.querySelectorAll('[data-msg-id]').length;
        }
      }
      list.setAttribute(
        'data-max-resize-rows',
        String(
          Math.max(
            Number(list.getAttribute('data-max-resize-rows') || 0),
            list.querySelectorAll('[data-msg-id]').length,
            addedRows
          )
        )
      );
    });
    observer.observe(list, { childList: true, subtree: true });
    (list as Element & { resizeRowObserver?: MutationObserver }).resizeRowObserver = observer;
  });

  for (const width of [900, 760, 620, 500, 400, 500, 620, 760, 900]) {
    await page.setViewportSize({ width, height: 800 });
    await waitForAnimationFrame(page);
  }

  const maxRenderedRows = await page.locator('.interactive-list').evaluate((list) => {
    const value = Number(list.getAttribute('data-max-resize-rows') || 0);
    (list as Element & { resizeRowObserver?: MutationObserver }).resizeRowObserver?.disconnect();
    return value;
  });
  expect(maxRenderedRows).toBeLessThan(90);
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

  const list = page.locator('.interactive-list');
  await list.evaluate((element) => {
    element.scrollTop = Math.floor(element.scrollHeight / 2);
    element.dispatchEvent(new Event('scroll'));
  });
  await waitForAnimationFrame(page);
  const visibleRows = await list.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    }).length;
  });
  expect(visibleRows).toBeGreaterThan(0);
  expect(await getRenderedMessageRowCount(page)).toBeLessThan(90);
});
