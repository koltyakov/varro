import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry } from '../../src/webview/types';
import { waitForAnimationFrames } from './helpers';

test('keeps Thinking aligned as an inline edit appears in a measured transcript', async ({
  page,
}) => {
  await page.setViewportSize({ width: 494, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');
  await expect(page.locator('[data-msg-id="message-large-assistant-239"]')).toBeVisible();
  await page.evaluate(() => {
    // SAFETY: The isolated E2E page installs these fixture-only methods.
    const harness = (
      window as Window & {
        __varroE2E?: {
          getSessionMessages(sessionID: string): MessageEntry[];
          replayServerEvent(event: ServerEvent): void;
        };
      }
    ).__varroE2E!;
    const sessionID = 'session-large-transcript';
    const info = harness.getSessionMessages(sessionID).at(-1)!.info;
    if (info.role !== 'assistant') throw new Error('Missing assistant fixture');
    harness.replayServerEvent({
      type: 'session.status',
      properties: { sessionID, status: { type: 'busy' } },
    });
    harness.replayServerEvent({
      type: 'message.updated',
      properties: {
        info: { ...info, id: 'thinking-edit', time: { created: Date.now() }, finish: undefined },
      },
    });
  });
  await expect(page.locator('.interactive-loading-row .loading-indicator')).toBeVisible();
  await waitForAnimationFrames(page, 30);
  const samples = await page.evaluate(async () => {
    // SAFETY: The isolated E2E page installs this fixture-only method.
    const harness = (
      window as Window & { __varroE2E?: { replayServerEvent(event: ServerEvent): void } }
    ).__varroE2E!;
    const sessionID = 'session-large-transcript';
    harness.replayServerEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'thinking-edit-part',
          messageID: 'thinking-edit',
          sessionID,
          type: 'tool',
          tool: 'patch',
          callID: 'thinking-edit-call',
          state: {
            status: 'completed',
            input: {
              patchText:
                '*** Begin Patch\n*** Add File: sample.ts\n+export const value = 1;\n*** End Patch',
            },
            output: 'Success. Updated the following files:\nA sample.ts',
            title: 'Patch',
            metadata: {
              files: [
                {
                  file: 'sample.ts',
                  status: 'added',
                  additions: 1,
                  deletions: 0,
                  patch: '@@ -0,0 +1 @@\n+export const value = 1;',
                },
              ],
            },
            time: { start: Date.now(), end: Date.now() },
          },
        },
      },
    });
    const result: Array<{ gap: number; height: number }> = [];
    for (let frame = 0; frame < 90; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      const card = document.querySelector('[data-msg-id="thinking-edit"] .file-change-card');
      const label = document.querySelector(
        '.interactive-loading-row:not(.is-reserved) .loading-verb'
      );
      if (card && label)
        result.push({
          gap: label.getBoundingClientRect().top - card.getBoundingClientRect().bottom,
          height: card.getBoundingClientRect().height,
        });
    }
    return result;
  });
  expect(samples.length).toBeGreaterThan(30);
  expect(samples.every((sample) => sample.height > 0)).toBe(true);
  expect(
    Math.max(...samples.map((sample) => sample.gap)) -
      Math.min(...samples.map((sample) => sample.gap)),
    JSON.stringify(samples)
  ).toBeLessThan(0.1);
  expect(samples.at(-1)!.gap).toBe(12);
});
