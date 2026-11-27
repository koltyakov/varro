import { expect, test } from '@playwright/test';
import type { ExtensionMessage, ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry, SessionStatus } from '../../src/webview/types';

type CompletionHarness = Window & {
  __varroE2E?: {
    getSessionMessages(sessionId: string): MessageEntry[];
    replayServerEvent(event: ServerEvent): void;
  };
};

for (const scenario of ['rapid-streaming-jitter', 'large-transcript']) {
  test(`Worked waits for idle and disappears on resumed execution in ${scenario}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 494, height: 800 });
    await page.goto(`/e2e/harness/index.html?scenario=${scenario}`);
    await expect(page.locator('[data-msg-id]').last()).toBeVisible();
    const sessionId = `session-${scenario}`;
    const responseId = await page.evaluate((sessionID) => {
      // SAFETY: The isolated E2E page installs the production-event replay transport.
      const harness = (window as CompletionHarness).__varroE2E;
      const info = harness?.getSessionMessages(sessionID).at(-1)?.info;
      if (!harness || info?.role !== 'assistant')
        throw new Error('Missing assistant completion fixture');
      harness.replayServerEvent({
        type: 'session.status',
        properties: { sessionID, status: { type: 'busy' } },
      });
      harness.replayServerEvent({
        type: 'message.updated',
        properties: {
          info: {
            ...info,
            finish: 'stop',
            time: { ...info.time, completed: Date.now() },
          },
        },
      });
      return info.id;
    }, sessionId);

    const sampleWorkingFrames = (workingStatus: SessionStatus) =>
      page.evaluate(
        async ({ sessionID, responseID, status }) => {
          // SAFETY: The isolated E2E page installs the production-event replay transport.
          const harness = (window as CompletionHarness).__varroE2E;
          if (!harness) throw new Error('Missing completion replay transport');
          // The replay transport posts a message task, and a frame callback can
          // run before that task. Wait for delivery so samples cover only paints
          // after the runtime's (earlier-registered) bridge listener applied it.
          const delivered = new Promise<void>((resolve) => {
            const onDelivered = (event: MessageEvent<ExtensionMessage>) => {
              const message = event.data;
              if (
                message?.type !== 'server/event' ||
                message.payload.type !== 'session.status' ||
                message.payload.properties?.sessionID !== sessionID
              )
                return;
              window.removeEventListener('message', onDelivered);
              resolve();
            };
            window.addEventListener('message', onDelivered);
          });
          harness.replayServerEvent({
            type: 'session.status',
            properties: { sessionID, status },
          });
          await delivered;
          const sample = () => ({
            worked: !!document.querySelector('.trailing-assistant-summary-row'),
            rowSummary: !!document.querySelector(
              `[data-msg-id="${responseID}"] .assistant-dialog-summary`
            ),
            final: !!document.querySelector(
              `[data-msg-id="${responseID}"] .assistant-message-flow-item-final`
            ),
            slotHeight: document.querySelector('.interactive-loading-row')?.getBoundingClientRect()
              .height,
          });
          const samples: ReturnType<typeof sample>[] = [];
          const deadline = performance.now() + 800;
          while (performance.now() < deadline) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            samples.push(sample());
          }
          return samples;
        },
        { sessionID: sessionId, responseID: responseId, status: workingStatus }
      );

    for (const status of [
      { type: 'busy' },
      { type: 'retry', attempt: 1, next: Date.now() + 20_000, message: 'Retrying' },
      { type: 'busy' },
    ] satisfies SessionStatus[]) {
      const samples = await sampleWorkingFrames(status);
      await test.info().attach(`${status.type}-completion-frames`, {
        body: JSON.stringify(samples),
        contentType: 'application/json',
      });
      expect(samples.length).toBeGreaterThan(2);
      expect(
        samples.every((sample) => !sample.worked && !sample.rowSummary && !sample.final),
        JSON.stringify({ status, samples })
      ).toBe(true);
      expect(
        samples.every((sample) => sample.slotHeight === 24),
        JSON.stringify(samples)
      ).toBe(true);
      await expect(page.locator('.interactive-loading-row .loading-indicator')).toBeVisible();

      await page.evaluate((sessionID) => {
        // SAFETY: The isolated E2E page installs the production-event replay transport.
        const harness = (window as CompletionHarness).__varroE2E;
        if (!harness) throw new Error('Missing completion replay transport');
        harness.replayServerEvent({
          type: 'session.status',
          properties: { sessionID, status: { type: 'idle' } },
        });
      }, sessionId);
      await expect(page.locator('.trailing-assistant-summary-row')).toBeVisible();
      await expect(
        page.locator(`[data-msg-id="${responseId}"] .assistant-message-flow-item-final`)
      ).toBeVisible();
      await expect(page.locator('.interactive-loading-row .loading-indicator')).toHaveCount(0);
    }
  });
}
