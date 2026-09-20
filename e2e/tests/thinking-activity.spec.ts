import { expect, test } from '@playwright/test';
import { waitForAnimationFrames } from './helpers';

test('empty pending activity rows never add spacing above Thinking', async ({ page }) => {
  await page.setViewportSize({ width: 494, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=large-transcript&activeReasoningEntrance=1');
  await expect(page.locator('.interactive-loading-row .loading-indicator')).toBeVisible();
  await waitForAnimationFrames(page, 30);
  const samples = await page.evaluate(async () => {
    const loading = document.querySelector('.interactive-loading-row')!;
    const label = loading.querySelector('.loading-verb')!;
    const anchor = [...document.querySelectorAll('[data-msg-id]')]
      .filter((element) => element.getBoundingClientRect().height > 0)
      .at(-1)!;
    const originalGap = label.getBoundingClientRect().top - anchor.getBoundingClientRect().bottom;
    // The reported session briefly renders this empty MessageRow before its semantic
    // render-empty flag catches up. Exercise that browser fallback for each adjacency.
    const pending = document.createElement('div');
    loading.before(pending);
    const result: Array<{ height: number; gapChange: number }> = [];
    try {
      for (const adjacency of [
        'interactive-response-follows-response',
        'interactive-response-follows-response interactive-response-continues-activity-group',
        'interactive-item-follows-bordered-block',
        'interactive-response-follows-response interactive-item-follows-bordered-block',
      ]) {
        pending.className = `interactive-item-container interactive-response ${adjacency}`;
        for (let frame = 0; frame < 5; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          result.push({
            height: pending.getBoundingClientRect().height,
            gapChange:
              label.getBoundingClientRect().top -
              anchor.getBoundingClientRect().bottom -
              originalGap,
          });
        }
      }
      const content = document.createElement('div');
      content.textContent = 'Running tool';
      pending.append(content);
      const filledHeight = pending.getBoundingClientRect().height;
      content.remove();
      return { result, filledHeight, emptyHeight: pending.getBoundingClientRect().height };
    } finally {
      pending.remove();
    }
  });
  expect(samples.result).toHaveLength(20);
  expect(
    samples.result.every(({ height, gapChange }) => height === 0 && gapChange === 0),
    JSON.stringify(samples.result)
  ).toBe(true);
  expect(samples.filledHeight).toBeGreaterThan(0);
  expect(samples.emptyHeight).toBe(0);
});
