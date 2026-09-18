import { expect, test } from '@playwright/test';
import type { MessageEntry } from '../../src/webview/types';
import type { ServerEvent } from '../../src/shared/protocol';

type RetryHarness = Window & {
  __varroE2E?: {
    getSessionMessages(sessionId: string): MessageEntry[];
    replayServerEvent(event: ServerEvent): void;
  };
};

for (const outcome of ['recovered', 'failed'] as const) {
  test(`automatic retry is shown as ${outcome} in a virtualized transcript`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 494, height: 800 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    await expect(page.locator('[data-msg-id="message-large-assistant-239"]')).toBeVisible();

    await page.evaluate(() => {
      // SAFETY: The local E2E harness installs these fixture-only methods.
      const harness = (window as RetryHarness).__varroE2E!;
      const sessionID = 'session-large-transcript';
      const info = harness.getSessionMessages(sessionID).at(-1)!.info;
      if (info.role !== 'assistant') throw new Error('Expected an assistant fixture');
      harness.replayServerEvent({
        type: 'message.updated',
        properties: {
          info: {
            ...info,
            finish: 'error',
            error: {
              name: 'provider.transport',
              data: { message: 'WebSocket closed with code 1006' },
            },
            retry: { attempt: 2, at: Date.now() + 2000 },
          },
        },
      });
      harness.replayServerEvent({
        type: 'session.status',
        properties: {
          sessionID,
          status: {
            type: 'retry',
            attempt: 2,
            next: Date.now() + 2000,
            message: 'Connection lost',
          },
        },
      });
    });
    const notice = page.locator('.assistant-message-flow-item-error-notice');
    await expect(notice).toContainText('Retrying automatically');
    await expect(notice.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);

    await page.evaluate((result) => {
      // SAFETY: The local E2E harness installs these fixture-only methods.
      const harness = (window as RetryHarness).__varroE2E!;
      const sessionID = 'session-large-transcript';
      const info = harness.getSessionMessages(sessionID).at(-1)!.info;
      if (info.role !== 'assistant') throw new Error('Expected an assistant fixture');
      harness.replayServerEvent({
        type: 'message.updated',
        properties: {
          info: {
            ...info,
            id: 'retry-continuation',
            time: { created: Date.now(), completed: Date.now() + 1 },
            finish: result === 'recovered' ? 'tool-calls' : 'error',
            error: result === 'recovered' ? undefined : info.error,
            retry: undefined,
          },
        },
      });
      harness.replayServerEvent({
        type: 'session.status',
        properties: { sessionID, status: { type: 'idle' } },
      });
    }, outcome);
    await expect(notice).toContainText(
      outcome === 'recovered'
        ? 'Recovered after an automatic retry. Work continued.'
        : 'Response interrupted. Retried automatically.'
    );
    await notice.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(notice.locator('pre')).toContainText('provider.transport');
    await expect(notice.locator('pre')).toContainText('WebSocket closed with code 1006');
    expect(await notice.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    );
    if (outcome === 'failed') {
      const failure = page.locator(
        '[data-msg-id="retry-continuation"] .assistant-message-flow-item-error'
      );
      await expect(failure).not.toHaveClass(/error-notice/);
      await expect(failure.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath(`${outcome}.png`) });
    expect(errors).toEqual([]);
  });
}
