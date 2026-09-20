import { expect, test } from '@playwright/test';
import type { MessageEntry } from '../../src/webview/types';
import type { ServerEvent } from '../../src/shared/protocol';
import { waitForAnimationFrames } from './helpers';

type RetryHarness = Window & {
  __varroE2E?: {
    getSessionMessages(sessionId: string): MessageEntry[];
    replayServerEvent(event: ServerEvent): void;
  };
};

type RetryGapSamples = {
  running: boolean;
  gaps: number[];
  rowCorrections: number[];
  showedWorked: boolean;
};

for (const width of [441, 494]) {
  test(`keeps Thinking adjacent through retry and recovery at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    await expect(
      page.locator('[data-msg-id="message-rapid-assistant-streaming"] .rendered-markdown')
    ).toContainText('Starting...');
    const collector = await page.evaluateHandle(() => {
      const state: RetryGapSamples = {
        running: true,
        gaps: [],
        rowCorrections: [],
        showedWorked: false,
      };
      const sample = () => {
        const notice = document.querySelector('.assistant-message-flow-item-error-notice');
        const thinking = document.querySelector('.interactive-loading-row .loading-verb');
        if (notice) {
          state.showedWorked ||= !!document.querySelector('.trailing-assistant-summary-row');
          if (thinking) {
            state.gaps.push(
              thinking.getBoundingClientRect().top - notice.getBoundingClientRect().bottom
            );
            const row = notice.closest('[data-msg-id]');
            state.rowCorrections.push(
              row
                ? Number.parseFloat(
                    getComputedStyle(row).getPropertyValue('--interactive-item-block-correction')
                  ) || 0
                : 0
            );
          }
        }
        if (state.running) requestAnimationFrame(sample);
      };
      sample();
      return state;
    });
    await page.evaluate(() => {
      // SAFETY: The local E2E harness installs these fixture-only methods.
      const harness = (window as RetryHarness).__varroE2E!;
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
    await expect(page.locator('.trailing-assistant-summary-row')).toHaveCount(0);
    await expect(page.locator('.interactive-loading-row .loading-indicator')).toBeVisible();
    await page.evaluate(() => {
      // SAFETY: The local E2E harness installs these fixture-only methods.
      const harness = (window as RetryHarness).__varroE2E!;
      const sessionID = 'session-rapid-streaming-jitter';
      const info = harness.getSessionMessages(sessionID).at(-1)!.info;
      if (info.role !== 'assistant') throw new Error('Expected an assistant fixture');
      harness.replayServerEvent({
        type: 'message.updated',
        properties: {
          info: {
            ...info,
            id: 'retry-next-attempt',
            time: { created: Date.now() },
            finish: undefined,
            error: undefined,
            retry: undefined,
          },
        },
      });
      harness.replayServerEvent({
        type: 'session.status',
        properties: { sessionID, status: { type: 'busy' } },
      });
    });
    await waitForAnimationFrames(page, 30);
    const retryHeight = await notice.evaluate((element) => element.getBoundingClientRect().height);
    await page.evaluate(() => {
      // SAFETY: The local E2E harness installs these fixture-only methods.
      const harness = (window as RetryHarness).__varroE2E!;
      const info = harness.getSessionMessages('session-rapid-streaming-jitter').at(-1)!.info;
      if (info.role !== 'assistant') throw new Error('Expected an assistant fixture');
      harness.replayServerEvent({
        type: 'message.updated',
        properties: {
          info: { ...info, time: { ...info.time, completed: Date.now() }, finish: 'tool-calls' },
        },
      });
    });
    await expect(notice).toContainText('Recovered after an automatic retry');
    await waitForAnimationFrames(page, 30);
    expect(await notice.evaluate((element) => element.getBoundingClientRect().height)).toBe(
      retryHeight
    );
    const samples = await collector.evaluate((state) => {
      state.running = false;
      return {
        gaps: state.gaps,
        rowCorrections: state.rowCorrections,
        showedWorked: state.showedWorked,
      };
    });
    expect(samples.showedWorked).toBe(false);
    expect(samples.gaps.length).toBeGreaterThan(10);
    expect(
      Math.max(...samples.gaps) - Math.min(...samples.gaps),
      JSON.stringify(samples)
    ).toBeLessThan(1);
    // Virtual rows round their block size up to whole CSS pixels.
    expect(
      samples.gaps.at(-1)! - samples.rowCorrections.at(-1)!,
      JSON.stringify(samples)
    ).toBeCloseTo(12, 0);
    await expect(page.locator('.interactive-loading-row .loading-indicator')).toBeVisible();
  });
}

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
    const disclosure = notice.getByRole('button', {
      name:
        outcome === 'recovered'
          ? 'Recovered after an automatic retry. Work continued.'
          : 'Response interrupted. Retried automatically.',
      exact: true,
    });
    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(notice.locator('pre')).toContainText('provider.transport');
    await expect(notice.locator('pre')).toContainText('WebSocket closed with code 1006');
    expect(await notice.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    );
    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(notice.locator('pre')).toHaveCount(0);
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
