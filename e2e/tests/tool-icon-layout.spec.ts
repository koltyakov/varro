import { expect, test } from '@playwright/test';
import type { ToolPart, ToolState } from '../../src/shared/opencode-types';
import type { ExtensionMessage } from '../../src/shared/protocol';

const input = { code: 'return 1;' };
const time = { start: 1_000, end: 2_000 };
const states: ToolState[] = [
  { status: 'pending', input, raw: JSON.stringify(input) },
  { status: 'running', input, title: 'execute', time: { start: Date.now() } },
  { status: 'completed', input, output: '1', title: 'execute', metadata: {}, time },
  { status: 'error', input, error: 'Execution failed', time },
];

for (const state of states) {
  test(`centers the generic tool icon in its ${state.status} header`, async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayCount=1');
    await expect(page.locator('.assistant-active-activity-item')).toHaveCount(1);

    const part: ToolPart = {
      id: `tool-icon-${state.status}`,
      sessionID: 'session-tool-cards',
      messageID: 'message-tool-cards-assistant',
      type: 'tool',
      callID: `tool-icon-call-${state.status}`,
      tool: 'execute',
      state,
    };
    await page.evaluate((updatedPart) => {
      // SAFETY: The controlled E2E harness exposes this fixture update method.
      const harnessWindow = window as typeof window & {
        __varroE2E?: { updateMessagePart?: (part: ToolPart) => void };
      };
      harnessWindow.__varroE2E?.updateMessagePart?.(updatedPart);
      const message: ExtensionMessage = {
        type: 'server/event',
        payload: { type: 'message.part.updated', properties: { part: updatedPart } },
      };
      window.postMessage(message, '*');
    }, part);

    const summary = page.locator('button.assistant-activity-summary');
    if (state.status === 'completed' || state.status === 'error') {
      await expect(summary).toBeVisible();
      if ((await summary.getAttribute('aria-expanded')) !== 'true') await summary.click();
    }

    const icon = page.locator('.tool-call-icon-tools');
    await expect(icon).toBeVisible();
    const header = page.locator('.tool-invocation-header').filter({ has: icon });
    const measureOffset = () =>
      header.evaluate((element) => {
        const iconElement = element.querySelector('.tool-call-icon');
        if (!iconElement) throw new Error('Tool icon is missing');
        const headerBox = element.getBoundingClientRect();
        const iconBox = iconElement.getBoundingClientRect();
        return Math.abs(iconBox.top + iconBox.height / 2 - headerBox.top - headerBox.height / 2);
      });
    await expect.poll(measureOffset).toBeLessThan(0.1);

    if (await header.isEnabled()) {
      await header.click();
      await expect(header).toHaveAttribute('aria-expanded', 'true');
      await expect.poll(measureOffset).toBeLessThan(0.1);
    }
  });
}
