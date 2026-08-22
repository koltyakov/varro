/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These E2E callbacks install deterministic browser timing fixtures with the asserted global shape. */
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

test('viewport narrowing preserves the first visible row through host-shaped reflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 808 });
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

  const list = page.locator('.interactive-list');
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
    element.scrollTop = Math.floor(element.scrollHeight / 2);
    element.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(300);
  const target = await list.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const card = [...element.querySelectorAll<HTMLElement>('.user-message-card')].find(
      (candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      }
    );
    const row = card?.closest<HTMLElement>('[data-msg-id]');
    if (!row?.dataset.msgId) return null;
    return {
      id: row.dataset.msgId,
      top: card!.getBoundingClientRect().top - element.getBoundingClientRect().top,
    };
  });
  expect(target).not.toBeNull();
  const listBounds = await list.boundingBox();
  await page.mouse.move(listBounds!.x + 20, listBounds!.y + listBounds!.height / 2);
  await page.mouse.wheel(0, target!.top - 9);
  await expect
    .poll(() =>
      list.evaluate((element, anchorId) => {
        const row = element.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(anchorId)}"]`);
        const card = row?.querySelector<HTMLElement>('.user-message-card');
        return card
          ? Math.abs(card.getBoundingClientRect().top - element.getBoundingClientRect().top - 9)
          : Number.POSITIVE_INFINITY;
      }, target!.id)
    )
    .toBeLessThanOrEqual(3);
  const anchor = await list.evaluate((element, anchorId) => {
    const row = element.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(anchorId)}"]`);
    const card = row?.querySelector<HTMLElement>('.user-message-card');
    return card
      ? {
          id: anchorId,
          top: card.getBoundingClientRect().top - element.getBoundingClientRect().top,
        }
      : null;
  }, target!.id);
  expect(anchor).not.toBeNull();

  // Attribute later movement to host reflow, not an unfinished wheel/virtualization handoff.
  const preResizeTops = await list.evaluate(async (element, anchorId) => {
    const values = [];
    for (let frame = 0; frame < 3; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const row = element.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(anchorId)}"]`);
      const card = row?.querySelector<HTMLElement>('.user-message-card');
      values.push(
        card ? card.getBoundingClientRect().top - element.getBoundingClientRect().top : null
      );
    }
    return values;
  }, anchor!.id);
  expect(
    Math.max(
      ...preResizeTops.map((top) => Math.abs((top ?? Number.POSITIVE_INFINITY) - anchor!.top))
    ),
    JSON.stringify(preResizeTops)
  ).toBeLessThanOrEqual(3);

  const samplesPromise = list.evaluate(async (element, anchorId) => {
    const readTop = () => {
      const row = element.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(anchorId)}"]`);
      const card = row?.querySelector<HTMLElement>('.user-message-card');
      return card && row
        ? {
            top: card.getBoundingClientRect().top - element.getBoundingClientRect().top,
            rowTop: row.getBoundingClientRect().top - element.getBoundingClientRect().top,
            scrollTop: element.scrollTop,
          }
        : null;
    };
    const values = [];
    for (let frame = 0; frame < 12; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      values.push(readTop());
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 180));
    values.push(readTop());
    return values;
  }, anchor!.id);
  await page.setViewportSize({ width: 360, height: 786 });
  const samples = await samplesPromise;

  expect(
    samples.every((top) => top !== null),
    JSON.stringify(samples)
  ).toBe(true);
  // The first test RAF can run before ResizeObserver corrects geometry in the same
  // pre-paint turn. Every callback after that handoff represents corrected frames.
  expect(
    Math.max(...samples.slice(1).map((sample) => Math.abs(sample!.top - anchor!.top))),
    JSON.stringify(samples)
  ).toBeLessThanOrEqual(3);
  expect(await getRenderedMessageRowCount(page)).toBeLessThan(90);
});

test('viewport narrowing preserves an inner block in a viewport-tall markdown item', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 808 });
  await page.goto('/e2e/harness/index.html?scenario=huge-content-transcript');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

  const list = page.locator('.interactive-list');
  const heading = page.getByRole('heading', { name: 'Huge section 45' });
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
  });
  for (let step = 2; step < 19; step += 1) {
    await list.evaluate((element, ratio) => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * ratio);
      element.dispatchEvent(new Event('scroll'));
    }, step / 20);
    await waitForAnimationFrame(page);
    if ((await heading.count()) > 0) break;
  }
  await expect(heading).toBeAttached();
  await list.evaluate((element) => {
    const target = [...element.querySelectorAll<HTMLElement>('h2')]
      .find((candidate) => candidate.innerText === 'Huge section 45')
      ?.closest<HTMLElement>('[data-msg-id]');
    if (!target) throw new Error('Tall Markdown target row is not mounted');
    element.scrollTop +=
      target.getBoundingClientRect().top - element.getBoundingClientRect().top + 700;
    element.dispatchEvent(new Event('scroll'));
  });

  const listBounds = await list.boundingBox();
  await page.mouse.move(listBounds!.x + 30, listBounds!.y + listBounds!.height / 2);
  await page.mouse.wheel(0, 32);
  await page.waitForTimeout(80);

  const anchor = await list.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const item = [...element.querySelectorAll<HTMLElement>('.rendered-markdown li')].find(
      (candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.top >= bounds.top + 20 && rect.bottom < bounds.bottom;
      }
    );
    if (!item) return null;
    return {
      text: item.innerText,
      top: item.getBoundingClientRect().top - bounds.top,
    };
  });
  expect(anchor).not.toBeNull();

  const samples: Array<{ connected: boolean; top: number | null }> = [];
  await page.setViewportSize({ width: 359, height: 808 });
  for (let frame = 0; frame < 8; frame += 1) {
    await waitForAnimationFrame(page);
    samples.push(
      await list.evaluate((element, text) => {
        const item = [...element.querySelectorAll<HTMLElement>('.rendered-markdown li')].find(
          (candidate) => candidate.innerText === text
        );
        return {
          connected: !!item?.isConnected,
          top: item ? item.getBoundingClientRect().top - element.getBoundingClientRect().top : null,
        };
      }, anchor!.text)
    );
  }

  expect(
    samples.every((sample) => sample.connected),
    JSON.stringify(samples)
  ).toBe(true);
  expect(
    Math.max(...samples.map((sample) => Math.abs(sample.top! - anchor!.top))),
    JSON.stringify({ anchor, samples })
  ).toBeLessThanOrEqual(3);
});

test('cold scrollbar positioning preserves an inner block during width reflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 808 });
  await page.goto('/e2e/harness/index.html?scenario=huge-content-transcript');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

  const list = page.locator('.interactive-list');
  const precedingHeading = page.getByRole('heading', { name: 'Huge section 45' });
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -180 }));
  });
  for (let step = 2; step < 19; step += 1) {
    await list.evaluate((element, ratio) => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * ratio);
      element.dispatchEvent(new Event('scroll'));
    }, step / 20);
    await waitForAnimationFrame(page);
    if ((await precedingHeading.count()) > 0) break;
  }
  await expect(precedingHeading).toBeAttached();
  await list.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    element.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: bounds.right - 1,
        clientY: bounds.top + bounds.height / 2,
        pointerType: 'mouse',
        isPrimary: true,
      })
    );
    const preceding = element.querySelector<HTMLElement>(
      '[data-msg-id="message-huge-assistant-45"]'
    );
    if (!preceding) throw new Error('Preceding tall Markdown row is not mounted');
    element.scrollTop +=
      preceding.getBoundingClientRect().bottom - element.getBoundingClientRect().top + 100;
    element.dispatchEvent(new Event('scroll'));
  });
  await waitForAnimationFrame(page);
  await expect(page.getByRole('heading', { name: 'Huge section 46' })).toBeAttached();
  await list.evaluate((element) => {
    const target = [...element.querySelectorAll<HTMLElement>('h2')]
      .find((candidate) => candidate.innerText === 'Huge section 46')
      ?.closest<HTMLElement>('[data-msg-id]');
    if (!target) throw new Error('Tall Markdown target row is not mounted');
    element.scrollTop +=
      target.getBoundingClientRect().top - element.getBoundingClientRect().top + 1_300;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(80);
  await list.evaluate(() => {
    document.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        button: 0,
        pointerType: 'mouse',
        isPrimary: true,
      })
    );
  });

  const anchor = await list.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const item = [...element.querySelectorAll<HTMLElement>('.rendered-markdown p')].find(
      (candidate) => {
        const rect = candidate.getBoundingClientRect();
        return (
          candidate.innerText.startsWith('Mixed paragraph') &&
          rect.top >= bounds.top + 20 &&
          rect.bottom < bounds.bottom
        );
      }
    );
    return item
      ? {
          text: item.innerText,
          top: item.getBoundingClientRect().top - bounds.top,
          scrollTop: element.scrollTop,
        }
      : null;
  });
  expect(anchor).not.toBeNull();

  const samples: Array<{ connected: boolean; top: number | null; scrollTop: number }> = [];
  await page.setViewportSize({ width: 720, height: 808 });
  for (let frame = 0; frame < 12; frame += 1) {
    await waitForAnimationFrame(page);
    samples.push(
      await list.evaluate((element, text) => {
        const item = [...element.querySelectorAll<HTMLElement>('.rendered-markdown p')].find(
          (candidate) => candidate.innerText === text
        );
        return {
          connected: !!item?.isConnected,
          top: item ? item.getBoundingClientRect().top - element.getBoundingClientRect().top : null,
          scrollTop: element.scrollTop,
        };
      }, anchor!.text)
    );
  }

  expect(
    samples.every((sample) => sample.connected),
    JSON.stringify({ anchor, samples })
  ).toBe(true);
  expect(
    Math.max(...samples.slice(1).map((sample) => Math.abs(sample.top! - anchor!.top))),
    JSON.stringify({ anchor, samples })
  ).toBeLessThanOrEqual(3);
  expect(
    Math.abs(samples.at(-1)!.scrollTop - anchor!.scrollTop),
    JSON.stringify({ anchor, samples })
  ).toBeGreaterThan(100);
});

test('width reflow after PageDown preserves a painted block in a tall response', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 808 });
  await page.goto('/e2e/harness/index.html?scenario=huge-content-transcript');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

  const list = page.locator('.interactive-list');
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
    element.scrollTop = Math.floor(element.scrollHeight / 2);
    element.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(300);
  await list.focus();
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(300);

  const anchor = await list.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const candidates = element.querySelectorAll<HTMLElement>('.rendered-markdown :is(p, li, pre)');
    const item = [...candidates].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const owner = candidate.closest<HTMLElement>('[data-assistant-render-key]');
      return (
        owner &&
        owner.getBoundingClientRect().height > element.clientHeight &&
        rect.top >= viewport.top &&
        rect.bottom <= viewport.bottom
      );
    });
    return item
      ? { text: item.innerText, tagName: item.tagName, top: item.getBoundingClientRect().top }
      : null;
  });
  expect(anchor).not.toBeNull();

  const sample = () =>
    list.evaluate((element, target) => {
      const item = [
        ...element.querySelectorAll<HTMLElement>(`.rendered-markdown ${target.tagName}`),
      ].find((candidate) => candidate.innerText === target.text);
      return item?.getBoundingClientRect().top ?? null;
    }, anchor!);
  const samples = [];
  for (const width of [360, 720]) {
    await page.setViewportSize({ width, height: 808 });
    for (let frame = 0; frame < 12; frame += 1) {
      await waitForAnimationFrame(page);
      samples.push({ width, top: await sample() });
    }
  }

  expect(
    samples.every((entry) => entry.top !== null),
    JSON.stringify({ anchor, samples })
  ).toBe(true);
  expect(
    Math.max(...samples.slice(1).map((entry) => Math.abs(entry.top! - anchor!.top))),
    JSON.stringify({ anchor, samples })
  ).toBeLessThanOrEqual(3);
});

test('width reflow preserves the PageDown destination after crossing tall responses', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 808 });
  await page.goto('/e2e/harness/index.html?scenario=huge-content-transcript');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

  const list = page.locator('.interactive-list');
  const heading = page.getByRole('heading', { name: 'Huge section 45' });
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
  });
  for (let step = 2; step < 19; step += 1) {
    await list.evaluate((element, ratio) => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * ratio);
      element.dispatchEvent(new Event('scroll'));
    }, step / 20);
    await waitForAnimationFrame(page);
    if ((await heading.count()) > 0) break;
  }
  await expect(heading).toBeAttached();
  await list.evaluate((element) => {
    const target = [...element.querySelectorAll<HTMLElement>('h2')]
      .find((candidate) => candidate.innerText === 'Huge section 45')
      ?.closest<HTMLElement>('[data-msg-id]');
    if (!target) throw new Error('Source tall response is not mounted');
    const viewport = element.getBoundingClientRect();
    element.scrollTop += target.getBoundingClientRect().bottom - viewport.bottom + 100;
    element.dispatchEvent(new Event('scroll'));
  });
  await list.focus();
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(300);

  const anchor = await list.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const item = [...element.querySelectorAll<HTMLElement>('.rendered-markdown p')].find(
      (candidate) => {
        const rect = candidate.getBoundingClientRect();
        return (
          candidate.innerText.startsWith('Mixed paragraph') &&
          rect.top >= bounds.top &&
          rect.bottom <= bounds.bottom
        );
      }
    );
    return item
      ? {
          text: item.innerText,
          top: item.getBoundingClientRect().top - bounds.top,
        }
      : null;
  });
  expect(anchor).not.toBeNull();

  const samples = [];
  for (const width of [360, 720]) {
    await page.setViewportSize({ width, height: 808 });
    for (let frame = 0; frame < 12; frame += 1) {
      await waitForAnimationFrame(page);
      samples.push({
        width,
        top: await list.evaluate((element, text) => {
          const item = [...element.querySelectorAll<HTMLElement>('.rendered-markdown p')].find(
            (candidate) => candidate.innerText === text
          );
          return item
            ? item.getBoundingClientRect().top - element.getBoundingClientRect().top
            : null;
        }, anchor!.text),
      });
    }
  }

  expect(
    samples.every((entry) => entry.top !== null),
    JSON.stringify({ anchor, samples })
  ).toBe(true);
  expect(
    Math.max(...samples.slice(1).map((entry) => Math.abs(entry.top! - anchor!.top))),
    JSON.stringify({ anchor, samples })
  ).toBeLessThanOrEqual(3);
});

test('viewport narrowing replaces a stale tall-row anchor after sticky navigation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 808 });
  await page.goto('/e2e/harness/index.html?scenario=huge-content-transcript');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

  const list = page.locator('.interactive-list');
  const heading = page.getByRole('heading', { name: 'Huge section 45' });
  const source = page.locator('[data-msg-id="message-huge-user-45"] .user-message-card');
  const sticky = page.locator('.latest-user-message-sticky');
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
  });
  for (let step = 2; step < 19; step += 1) {
    await list.evaluate((element, ratio) => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * ratio);
      element.dispatchEvent(new Event('scroll'));
    }, step / 20);
    await waitForAnimationFrame(page);
    if ((await heading.count()) > 0) break;
  }
  await expect(heading).toBeAttached();
  await list.evaluate((element) => {
    const response = element.querySelector<HTMLElement>(
      '[data-msg-id="message-huge-assistant-45"]'
    );
    if (!response) throw new Error('Tall response is not mounted');
    element.scrollTop +=
      response.getBoundingClientRect().top - element.getBoundingClientRect().top + 1_200;
    element.dispatchEvent(new Event('scroll'));
  });
  const listBounds = await list.boundingBox();
  await page.mouse.move(listBounds!.x + 30, listBounds!.y + listBounds!.height / 2);
  await page.mouse.wheel(0, 32);
  await expect(sticky).toContainText('Review huge-content section 45.');

  await sticky.click();
  await expect(source).toBeVisible();
  await expect
    .poll(() =>
      source.evaluate(
        (element) =>
          element.getBoundingClientRect().top -
          document.querySelector('.interactive-list')!.getBoundingClientRect().top
      )
    )
    .toBeLessThanOrEqual(50);
  const anchorTop = await source.evaluate(
    (element) =>
      element.getBoundingClientRect().top -
      document.querySelector('.interactive-list')!.getBoundingClientRect().top
  );

  const samplesPromise = list.evaluate(async (element, messageId) => {
    const readTop = () => {
      const card = element.querySelector<HTMLElement>(
        `[data-msg-id="${CSS.escape(messageId)}"] .user-message-card`
      );
      return card ? card.getBoundingClientRect().top - element.getBoundingClientRect().top : null;
    };
    const values = [];
    for (let frame = 0; frame < 12; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      values.push(readTop());
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 180));
    values.push(readTop());
    return values;
  }, 'message-huge-user-45');
  await page.setViewportSize({ width: 360, height: 786 });
  const samples = await samplesPromise;

  expect(
    samples.every((top) => top !== null),
    JSON.stringify(samples)
  ).toBe(true);
  expect(
    Math.max(...samples.slice(1).map((top) => Math.abs(top! - anchorTop))),
    JSON.stringify({ anchorTop, samples })
  ).toBeLessThanOrEqual(3);
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
