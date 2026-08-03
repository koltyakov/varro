import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { getScrollMetrics, waitForAnimationFrames } from './helpers';

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

  test('virtualized message blocks stay aligned to whole CSS pixels', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=heterogeneous-large-transcript');
    const track = page.locator('.interactive-list-track');
    await expect(track).toHaveClass(/virtualized/);

    const geometry = await track.evaluate((element) => {
      const blocks = [...element.children].filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement &&
          (child.matches('[data-msg-id]') || child.matches('.virtual-spacer'))
      );
      const rects = blocks.map((block) => block.getBoundingClientRect());
      return {
        heights: rects.map((rect) => rect.height),
        boundaryGaps: rects.slice(1).map((rect, index) => rect.top - rects[index]!.bottom),
        spacerStyleHeights: blocks
          .filter((block) => block.matches('.virtual-spacer'))
          .map((block) => Number.parseFloat(block.style.height)),
      };
    });

    expect(geometry.heights.length).toBeGreaterThan(1);
    for (const height of geometry.heights) {
      expect(Math.abs(height - Math.round(height))).toBeLessThan(0.001);
    }
    for (const gap of geometry.boundaryGaps) {
      expect(Math.abs(gap)).toBeLessThan(0.001);
    }
    for (const height of geometry.spacerStyleHeights) {
      expect(Number.isInteger(height)).toBe(true);
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

  test('top-to-bottom range traversal restores bottom viewport coverage', async ({ page }) => {
    // This checks scrollbar boundaries and rendered coverage, not intermediate jump geometry.
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
