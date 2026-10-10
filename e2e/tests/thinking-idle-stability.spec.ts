import { expect, test } from '@playwright/test';
import type { ServerEvent, WebviewMessage } from '../../src/shared/protocol';
import type { MessageEntry, UserMessage } from '../../src/webview/types';
import { waitForAnimationFrames } from './helpers';

for (const scenario of ['blank', 'mixed-small-transcript', 'large-transcript']) {
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    test(`idle Thinking stays stationary after send: ${scenario}, ${reducedMotion}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 486, height: 850 });
      await page.emulateMedia({ reducedMotion });
      await page.goto(`/e2e/harness/index.html?scenario=${scenario}`);
      await page.addStyleTag({ content: ':root { --varro-chat-font-size: 13.5px; }' });
      await page.evaluate(() => {
        // SAFETY: Acknowledge only the isolated fixture's native send and keep its turn busy.
        const harness = window as {
          __sendToExtension?: (message: WebviewMessage) => void | Promise<void>;
          __varroE2E?: { replayServerEvent(event: ServerEvent): void };
        };
        const send = harness.__sendToExtension;
        harness.__sendToExtension = (message) => {
          if (
            message.type === 'api/request' &&
            /\/prompt_async(?:\?|$)/.test(message.payload.path)
          ) {
            // SAFETY: The native composer creates this request body in the isolated fixture.
            const body = message.payload.body as {
              messageID: string;
              agent: string;
              model: UserMessage['model'];
              parts: MessageEntry['parts'];
            };
            const sessionID = message.payload.path.split('/')[2]!;
            harness.__varroE2E!.replayServerEvent({
              type: 'message.updated',
              properties: {
                info: {
                  id: body.messageID,
                  sessionID,
                  role: 'user',
                  agent: body.agent,
                  model: body.model,
                  time: { created: Date.now() },
                },
              },
            });
            for (const [index, part] of body.parts.entries()) {
              harness.__varroE2E!.replayServerEvent({
                type: 'message.part.updated',
                properties: {
                  part: {
                    ...part,
                    id: `idle-prompt-${index}`,
                    messageID: body.messageID,
                    sessionID,
                  },
                },
              });
            }
            harness.__varroE2E!.replayServerEvent({
              type: 'session.status',
              properties: { sessionID, status: { type: 'busy' } },
            });
            window.postMessage(
              { type: 'api/response', payload: { id: message.payload.id, data: null } },
              '*'
            );
            return;
          }
          return send?.(message);
        };
      });
      const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
      await composer.fill(
        'Check that these messages and the Thinking label stay still while waiting for a response.'
      );
      await page.getByLabel('Send (Enter)').click();
      const list = page.locator('.interactive-list');
      const loadingLabel = list.locator('.interactive-loading-row:not(.is-reserved) .loading-verb');
      await expect(loadingLabel).toBeVisible();
      if (reducedMotion === 'reduce') {
        await expect(loadingLabel).toHaveCSS('animation-name', 'pulse-soft');
        await expect(loadingLabel).toHaveCSS('animation-duration', '2s');
        await expect(loadingLabel).toHaveCSS('animation-iteration-count', 'infinite');
        await expect(loadingLabel).toHaveCSS('background-image', 'none');
        await expect(loadingLabel).toHaveCSS('transform', 'none');
        expect(
          await loadingLabel
            .locator('.chat-animated-ellipsis')
            .evaluate((element) => getComputedStyle(element, '::after').content)
        ).toBe('"…"');
      } else {
        await expect(loadingLabel).not.toHaveCSS('animation-name', 'pulse-soft');
        await expect(loadingLabel).not.toHaveCSS('background-image', 'none');
      }
      // Allow send positioning to finish before checking an untouched, stationary viewport.
      await waitForAnimationFrames(page, 90);
      const result = await list.evaluate(async (element) => {
        const prompt = [...element.querySelectorAll('.user-message-card')].at(-1)!;
        const loading = element.querySelector('.interactive-loading-row:not(.is-reserved)')!;
        const label = loading.querySelector('.loading-verb')!;
        const errors: string[] = [];
        const onError = (event: ErrorEvent) => errors.push(event.message);
        window.addEventListener('error', onError);
        const samples = [];
        const start = performance.now();
        try {
          // Cross two six-second verb rotations, timer width changes, and many dots/shimmer cycles.
          while (performance.now() - start < 13_000) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            samples.push({
              promptTop: prompt.getBoundingClientRect().top,
              labelTop: label.getBoundingClientRect().top,
              labelOpacity: Number.parseFloat(getComputedStyle(label).opacity),
              loadingHeight: loading.getBoundingClientRect().height,
              scrollTop: element.scrollTop,
              scrollHeight: element.scrollHeight,
              clientHeight: element.clientHeight,
              verb: label.textContent,
              elapsed: loading.querySelector('.loading-elapsed')?.textContent,
              connected: prompt.isConnected && loading.isConnected && label.isConnected,
              visible: getComputedStyle(label).visibility === 'visible',
            });
          }
          return { samples, errors };
        } finally {
          window.removeEventListener('error', onError);
        }
      });
      await testInfo.attach('idle-thinking-frames.json', {
        body: JSON.stringify(result),
        contentType: 'application/json',
      });
      expect(result.errors).toEqual([]);
      expect(result.samples.length).toBeGreaterThan(100);
      expect(result.samples.every((sample) => sample.connected)).toBe(true);
      expect(result.samples.every((sample) => sample.visible)).toBe(true);
      expect(new Set(result.samples.map((sample) => sample.verb)).size).toBeGreaterThanOrEqual(3);
      expect(new Set(result.samples.map((sample) => sample.elapsed)).size).toBeGreaterThanOrEqual(
        10
      );
      for (const property of [
        'promptTop',
        'labelTop',
        'loadingHeight',
        'scrollTop',
        'scrollHeight',
      ] as const) {
        const values = result.samples.map((sample) => sample[property]);
        expect(
          Math.max(...values) - Math.min(...values),
          `${property} must not oscillate`
        ).toBeLessThanOrEqual(0.1);
      }
      expect(result.samples.every((sample) => sample.loadingHeight === 24)).toBe(true);
      if (reducedMotion === 'reduce') {
        const opacities = result.samples.map((sample) => sample.labelOpacity);
        expect(Math.min(...opacities)).toBeGreaterThanOrEqual(0.4);
        expect(Math.max(...opacities)).toBeLessThanOrEqual(1);
        expect(Math.max(...opacities) - Math.min(...opacities)).toBeGreaterThan(0.5);
        await expect(list.locator('.loading-elapsed')).toHaveCSS('animation-name', 'none');
        await expect(list.locator('.loading-elapsed')).toHaveCSS('opacity', '0.5');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await expect(loadingLabel).not.toHaveCSS('animation-name', 'pulse-soft');
        await expect(loadingLabel).not.toHaveCSS('background-image', 'none');
      }
      if (scenario === 'blank') {
        expect(
          result.samples.every(
            (sample) => sample.scrollTop === 0 && sample.scrollHeight === sample.clientHeight
          )
        ).toBe(true);
      } else {
        expect(
          result.samples.every(
            (sample) => sample.scrollTop > 0 && sample.scrollHeight > sample.clientHeight
          )
        ).toBe(true);
      }
    });
  }
}
