import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { getScrollMetrics, getVisibleMessageAnchor, waitForAnimationFrames } from './helpers';

// Headless Chromium otherwise hides the native scrollbar and makes thumb input inert.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

type ColdPrependWork = {
  initial: string[];
  visibleIds: string[];
  recreated: string[];
  recreatedVisible: string[];
  constructed: string[];
  mounted: string[];
};

async function openColdHistory(page: Page) {
  await page.setViewportSize({ width: 486, height: 794 });
  await page.goto(
    '/e2e/harness/index.html?scenario=cold-large-history&windowed=1&messagePageSize=60&deferHistory=1'
  );
  const list = page.locator('.interactive-list');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
  await expect
    .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
    .toBeLessThanOrEqual(1);
  const thumb = await list.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const track = element.clientHeight;
    const height = Math.max(20, (track * track) / element.scrollHeight);
    return {
      x: rect.right - 6,
      y:
        rect.top +
        ((track - height) * element.scrollTop) / (element.scrollHeight - track) +
        height / 2,
      top: rect.top,
      bottom: rect.bottom,
    };
  });
  await page.mouse.move(thumb.x, thumb.y);
  await page.mouse.down();
  await expect(list).toHaveAttribute('data-pointer-scroll-owned', '');
  await page.mouse.move(thumb.x, thumb.top - 30, { steps: 12 });
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(page.locator('.message-history-banner')).toHaveClass(/is-loading/);
  await waitForAnimationFrames(page, 4);
  return { list, thumb };
}

async function releaseHistory(page: Page) {
  await page.evaluate(() => {
    // SAFETY: This helper is installed only by the isolated E2E harness.
    const harness = (
      window as Window & {
        __varroE2E?: { releaseNextHistoryRequest(): boolean };
      }
    ).__varroE2E;
    if (!harness?.releaseNextHistoryRequest()) throw new Error('Missing deferred history page');
  });
  await expect(page.locator('.message-history-banner')).not.toHaveClass(/is-loading/);
  await waitForAnimationFrames(page, 4);
}

test('cold prepend does not reconstruct an obsolete viewport under the held thumb', async ({
  page,
}, testInfo) => {
  const { list } = await openColdHistory(page);
  try {
    await list.evaluate((element) => {
      const initial = new Map(
        [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].map((row) => [
          row.dataset.msgId!,
          row,
        ])
      );
      const nodes = new Map(initial);
      const view = element.getBoundingClientRect();
      const visibleIds = [...initial]
        .filter(([, row]) => {
          const rect = row.getBoundingClientRect();
          return rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom;
        })
        .map(([id]) => id);
      const recreated: string[] = [];
      const constructed: string[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const added of record.addedNodes) {
            if (!(added instanceof HTMLElement)) continue;
            const rows = [
              ...(added.matches('[data-msg-id]') ? [added] : []),
              ...added.querySelectorAll<HTMLElement>('[data-msg-id]'),
            ];
            for (const row of rows) {
              const id = row.dataset.msgId!;
              if (nodes.get(id) === row) continue;
              if (initial.has(id)) recreated.push(id);
              nodes.set(id, row);
              constructed.push(id);
            }
          }
        }
      });
      observer.observe(element, { subtree: true, childList: true });
      // SAFETY: Test-owned probe holds DOM identity only until this page is disposed.
      (window as Window & { coldPrependRows?: () => ColdPrependWork }).coldPrependRows = () => {
        observer.disconnect();
        const mounted = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')];
        return {
          initial: [...initial.keys()],
          visibleIds,
          recreated,
          recreatedVisible: recreated.filter((id) => visibleIds.includes(id)),
          constructed,
          mounted: mounted.map((row) => row.dataset.msgId!),
        };
      };
    });
    await releaseHistory(page);
    const counts = await page.evaluate(() => {
      // SAFETY: Installed above before publishing the deferred history page.
      return (
        window as Window & {
          coldPrependRows?: () => ColdPrependWork;
        }
      ).coldPrependRows!();
    });
    await testInfo.attach('cold-prepend-work', {
      body: JSON.stringify(counts),
      contentType: 'application/json',
    });
    expect(counts.initial.length).toBeGreaterThan(9);
    expect(counts.visibleIds.length).toBeGreaterThan(1);
    expect(counts.recreatedVisible).toEqual([]);
    // Guard the stall's redundant construction work, not a machine-dependent frame deadline.
    expect(counts.constructed.length).toBeLessThan(30);
    expect(counts.mounted.length).toBeLessThan(60);
  } finally {
    await page.mouse.up();
  }
});

async function sampleHeldPosition(list: Locator, messageId: string, count: number) {
  return list.evaluate(
    async (element, { messageId: targetId, count: frames }) => {
      const samples = [];
      for (let frame = 0; frame < frames; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const view = element.getBoundingClientRect();
        const row = element.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(targetId)}"]`);
        samples.push({
          top: element.scrollTop,
          anchor: row ? row.getBoundingClientRect().top - view.top : null,
          covered: [
            ...element.querySelectorAll('[data-msg-id]:not(.interactive-item-virtual-placeholder)'),
          ].some((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom;
          }),
        });
      }
      return samples;
    },
    { messageId, count }
  );
}

test('cold history alignment yields to the held thumb through continued movement and release', async ({
  page,
}, testInfo) => {
  const { list, thumb } = await openColdHistory(page);
  try {
    await list.evaluate((element) => {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
      const writes: Array<{ top: number; held: boolean }> = [];
      Object.defineProperty(element, 'scrollTop', {
        configurable: true,
        get() {
          return descriptor.get!.call(this);
        },
        set(value: number) {
          writes.push({ top: value, held: element.hasAttribute('data-pointer-scroll-owned') });
          descriptor.set!.call(this, value);
        },
      });
      // SAFETY: Test-owned probe is read before the isolated page is disposed.
      (window as Window & { readColdThumbWrites?: () => typeof writes }).readColdThumbWrites = () =>
        writes;
    });
    await releaseHistory(page);
    // The pointer remains above the track. Native scrolling owns numeric zero even after
    // prepending changes which message is painted there; an old history marker must not win.
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0);
    const anchor = await getVisibleMessageAnchor(list);
    const aligned = await sampleHeldPosition(list, anchor.id, 65);
    await testInfo.attach('cold-prepend-alignment', {
      body: JSON.stringify({ anchor, aligned }),
      contentType: 'application/json',
    });
    expect(aligned.every((s) => s.anchor !== null && Math.abs(s.anchor - anchor.top) <= 1)).toBe(
      true
    );
    expect(aligned.every((s) => s.covered)).toBe(true);
    expect(new Set(aligned.map((s) => s.top)).size).toBe(1);
    await page.mouse.move(thumb.x, thumb.top + (thumb.bottom - thumb.top) * 0.4, { steps: 12 });
    await waitForAnimationFrames(page, 3);
    const destination = await getScrollMetrics(page, '.interactive-list');
    expect(destination.scrollTop).toBeGreaterThan(aligned[0]!.top + 100);
    const moved = await getVisibleMessageAnchor(list);
    const held = await sampleHeldPosition(list, moved.id, 65);
    await testInfo.attach('cold-prepend-continued-hold', {
      body: JSON.stringify({ destination, moved, held }),
      contentType: 'application/json',
    });
    expect(
      held.every(
        (s) =>
          s.top === destination.scrollTop &&
          s.anchor !== null &&
          Math.abs(s.anchor - moved.top) <= 1 &&
          s.covered
      )
    ).toBe(true);
    await page.mouse.up();
    const released = await sampleHeldPosition(list, moved.id, 12);
    const writes = await page.evaluate(() => {
      // SAFETY: Installed above before continued native input.
      return (
        window as Window & { readColdThumbWrites?: () => Array<{ top: number; held: boolean }> }
      ).readColdThumbWrites!();
    });
    expect(
      released.every(
        (s) =>
          Math.abs(s.top - destination.scrollTop) <= 1 &&
          s.anchor !== null &&
          Math.abs(s.anchor - moved.top) <= 1 &&
          s.covered
      )
    ).toBe(true);
    await testInfo.attach('cold-prepend-thumb', {
      body: JSON.stringify({ anchor, aligned, destination, moved, held, released, writes }),
      contentType: 'application/json',
    });
    expect(writes.filter((write) => write.held)).toEqual([]);
  } finally {
    await page.mouse.up();
  }
});
