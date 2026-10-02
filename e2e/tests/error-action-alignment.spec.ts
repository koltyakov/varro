import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry } from '../../src/webview/types';

type ErrorActionHarness = Window & {
  __varroE2E?: {
    getSessionMessages(sessionId: string): MessageEntry[];
    replayServerEvent(event: ServerEvent): void;
  };
};

for (const action of ['Re-authenticate', 'Retry']) {
  test(`centers ${action} text independently of font metrics`, async ({ page }) => {
    await page.setViewportSize({ width: 470, height: 800 });
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    await expect(page.locator('[data-msg-id="message-rapid-assistant-streaming"]')).toBeVisible();
    await page.evaluate((label) => {
      // SAFETY: These fixture-only methods are installed by the local E2E harness.
      const harness = (window as ErrorActionHarness).__varroE2E!;
      const sessionID = 'session-rapid-streaming-jitter';
      const info = harness.getSessionMessages(sessionID).at(-1)!.info;
      if (info.role !== 'assistant') throw new Error('Expected an assistant fixture');
      harness.replayServerEvent({
        type: 'message.updated',
        properties: {
          info: {
            ...info,
            time: { ...info.time, completed: Date.now() },
            finish: 'error',
            error:
              label === 'Re-authenticate'
                ? {
                    name: 'ProviderAuthError',
                    data: { providerID: info.providerID, message: 'Token refresh failed: 401' },
                  }
                : { name: 'UnknownError', data: { message: 'Request failed' } },
          },
        },
      });
      harness.replayServerEvent({
        type: 'session.status',
        properties: { sessionID, status: { type: 'idle' } },
      });
    }, action);

    const button = page.locator('.assistant-message-flow-item-error-action');
    const label = button.locator('.assistant-message-flow-item-error-action-label');
    await expect(button).toHaveAccessibleName(action);
    await expect(label).toBeVisible();
    await expect(label).toHaveCSS('text-box-trim', 'trim-both');
    await expect(label).toHaveCSS('text-box-edge', 'cap alphabetic');

    for (const fontFamily of ['Arial, sans-serif', 'serif', 'monospace']) {
      const geometry = await button.evaluate((element, font) => {
        element.style.fontFamily = font;
        const labelElement = element.querySelector(
          '.assistant-message-flow-item-error-action-label'
        );
        const icon = element.querySelector('.ui-icon');
        if (!labelElement || !icon) throw new Error('Expected an error action label and icon');
        const buttonBox = element.getBoundingClientRect();
        const labelBox = labelElement.getBoundingClientRect();
        const iconBox = icon.getBoundingClientRect();
        return {
          height: buttonBox.height,
          labelOffset: labelBox.top + labelBox.height / 2 - (buttonBox.top + buttonBox.height / 2),
          iconOffset: iconBox.top + iconBox.height / 2 - (buttonBox.top + buttonBox.height / 2),
          labelHeight: labelBox.height,
          lineHeight: Number.parseFloat(getComputedStyle(labelElement).lineHeight),
        };
      }, fontFamily);
      expect(geometry.height, fontFamily).toBe(26);
      expect(Math.abs(geometry.labelOffset), fontFamily).toBeLessThan(0.1);
      expect(Math.abs(geometry.iconOffset), fontFamily).toBeLessThan(0.1);
      expect(geometry.labelHeight, fontFamily).toBeLessThan(geometry.lineHeight);
    }
  });
}
