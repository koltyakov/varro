import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry } from '../../src/webview/types';
import { getScrollMetrics, waitForAnimationFrames } from './helpers';

type ModelChangeHarness = Window & {
  __varroE2E?: {
    getSessionMessages(sessionId: string): MessageEntry[];
    replayServerEvent(event: ServerEvent): void;
  };
};

for (const width of [486, 900]) {
  test(`aligns model-change tooltip values at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/e2e/harness/index.html?scenario=message-rendering');
    await expect(page.locator('[data-msg-id="message-rendering-assistant"]')).toBeVisible();
    await page.evaluate(() => {
      // SAFETY: The local E2E harness installs these fixture-only methods.
      const harness = (window as ModelChangeHarness).__varroE2E!;
      const info = harness.getSessionMessages('session-message-rendering').at(-1)!.info;
      if (info.role !== 'assistant') throw new Error('Expected an assistant fixture');
      harness.replayServerEvent({
        type: 'message.updated',
        properties: { info: { ...info, variant: 'low' } },
      });
      harness.replayServerEvent({
        type: 'message.updated',
        properties: { info: { ...info, id: 'model-change-assistant', variant: 'high' } },
      });
    });

    const label = page.locator('[data-msg-id="model-change-assistant"] .model-change-label');
    await expect(label).toBeVisible();
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThanOrEqual(1);
    await waitForAnimationFrames(page, 2);
    await label.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('GPT-5 mini Low (GitHub Copilot)');
    await expect(tooltip).toContainText('GPT-5 mini High (GitHub Copilot)');

    const valuePositions = await tooltip.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const positions: Array<{ left: number; top: number }> = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.startsWith('GPT-5 mini')) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        positions.push({ left: box.left, top: box.top });
      }
      return positions;
    });
    expect(valuePositions).toHaveLength(2);
    expect(valuePositions[0]!.left).toBe(valuePositions[1]!.left);
    expect(valuePositions[1]!.top).toBeGreaterThan(valuePositions[0]!.top);
  });
}
