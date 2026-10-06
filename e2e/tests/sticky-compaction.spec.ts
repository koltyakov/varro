import { expect, test } from '@playwright/test';
import type { MessageEntry } from '../../src/webview/types';
import type { ServerEvent } from '../../src/shared/protocol';

test('virtualized sticky prompt stays visible across compaction in both directions', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 486, height: 1000 });
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview-large-transcript');
  // Keep the real prompt above the viewport at every sampled boundary offset.
  // Two short response rows can leave it visible at 120px with CI's font metrics.
  await page.evaluate(() => {
    // SAFETY: The isolated E2E fixture exposes this event transport and history lookup.
    const harness = (
      window as typeof window & {
        __varroE2E: {
          replayServerEvent: (event: ServerEvent) => void;
          getSessionMessages: (id: string) => MessageEntry[];
        };
      }
    ).__varroE2E;
    const sessionID = 'session-sticky-preview-large';
    const answer = harness
      .getSessionMessages(sessionID)
      .find((entry) => entry.info.id === 'message-sticky-large-assistant-1')!;
    harness.replayServerEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          ...answer.parts[0]!,
          type: 'text',
          text: [
            'The implementation is in place. Verifying targeted behavior and validation now.',
            'Verification covers the hourglass icon, completed activity, and compaction boundaries.',
            'Retain the real prompt identity when a compaction notice enters or leaves the viewport.',
          ].join('\n\n'),
        },
      },
    });
  });
  await expect(
    page.locator('[data-msg-id="message-sticky-large-assistant-1"] .rendered-markdown p')
  ).toHaveCount(3);
  const list = page.locator('.interactive-list');
  await expect(list.locator('.interactive-list-track')).toHaveClass(/virtualized/);
  await list.hover();
  await page.mouse.wheel(0, -600);
  const compactionRow = page.locator('[data-msg-id="message-sticky-large-compaction-user"]');
  await compactionRow.scrollIntoViewIfNeeded();
  const frames = await list.evaluate(async (element) => {
    const samples = [];
    for (const offset of [120, 80, 40, 10, -10, -60, -120, -60, -10, 10, 40, 80, 120]) {
      const boundary = element.querySelector(
        '[data-msg-id="message-sticky-large-compaction-user"]'
      )!;
      element.scrollTop +=
        boundary.getBoundingClientRect().top - element.getBoundingClientRect().top - offset;
      element.dispatchEvent(new Event('scroll'));
      for (let frame = 0; frame < 3; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const source = element.querySelector(
          '[data-msg-id="message-sticky-large-user-1"] .user-message-card'
        );
        samples.push({
          offset,
          boundaryTop: boundary.getBoundingClientRect().top - element.getBoundingClientRect().top,
          sourceBottom: source
            ? source.getBoundingClientRect().bottom - element.getBoundingClientRect().top
            : null,
          text: element.querySelector('.latest-user-message-sticky')?.textContent ?? null,
        });
      }
    }
    return samples;
  });
  await testInfo.attach('compaction-frames', {
    body: JSON.stringify(frames, null, 2),
    contentType: 'application/json',
  });
  expect(
    frames.filter((sample) => sample.sourceBottom !== null && sample.sourceBottom > 0)
  ).toEqual([]);
  expect(frames.filter((sample) => !sample.text?.includes('Do not animate text'))).toEqual([]);
  expect(frames.filter((sample) => Math.abs(sample.boundaryTop - sample.offset) > 2)).toEqual([]);
});

for (const kind of ['compaction', 'action'] as const) {
  test(`sticky prompt survives scrolling across a ${kind} row`, async ({ page }) => {
    await page.setViewportSize({ width: 486, height: 1000 });
    await page.goto('/e2e/harness/index.html?scenario=sticky-preview');
    await expect(page.locator('[data-msg-id="message-sticky-user-2"]')).toBeVisible();
    await page.evaluate((rowKind) => {
      // SAFETY: The isolated E2E fixture exposes this event transport and history lookup.
      const harness = (
        window as typeof window & {
          __varroE2E: {
            replayServerEvent: (event: ServerEvent) => void;
            getSessionMessages: (id: string) => MessageEntry[];
          };
        }
      ).__varroE2E;
      const sessionID = 'session-sticky-preview';
      const messages = harness.getSessionMessages(sessionID);
      const user = messages.find((m) => m.info.id === 'message-sticky-user-2')!;
      for (const part of user.parts) {
        harness.replayServerEvent({
          type: 'message.part.removed',
          properties: { sessionID, messageID: user.info.id, partID: part.id },
        });
      }
      harness.replayServerEvent({
        type: 'message.part.updated',
        properties: {
          part:
            rowKind === 'compaction'
              ? {
                  id: 'boundary',
                  sessionID,
                  messageID: user.info.id,
                  type: 'compaction',
                  auto: true,
                }
              : {
                  id: 'boundary',
                  sessionID,
                  messageID: user.info.id,
                  type: 'text',
                  synthetic: true,
                  text: 'Background command completed',
                },
        },
      });
      const answer = messages.find((m) => m.info.id === 'message-sticky-assistant-2')!;
      harness.replayServerEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: answer.parts[0]!.id,
            sessionID,
            messageID: answer.info.id,
            type: 'text',
            text: 'Response after the boundary.\n\n'.repeat(60),
          },
        },
      });
    }, kind);
    await expect(
      page.locator('[data-msg-id="message-sticky-assistant-2"] .rendered-markdown p')
    ).toHaveCount(60);
    const list = page.locator('.interactive-list');
    await expect(
      page.locator('[data-msg-id="message-sticky-user-2"] .user-message-card')
    ).toHaveCount(0);
    await list.dispatchEvent('wheel', { deltaY: -100 });
    const frames = await list.evaluate(async (element) => {
      const boundary = element.querySelector('[data-msg-id="message-sticky-user-2"]')!;
      const samples = [];
      for (const offset of [200, 120, 80, 40, 10, -10, -60, -120, -60, -10, 10, 40, 80, 120, 200]) {
        element.scrollTop +=
          boundary.getBoundingClientRect().top - element.getBoundingClientRect().top - offset;
        element.dispatchEvent(new Event('scroll'));
        for (let frame = 0; frame < 3; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          samples.push({
            offset,
            boundaryTop: boundary.getBoundingClientRect().top - element.getBoundingClientRect().top,
            text: element.querySelector('.latest-user-message-sticky')?.textContent ?? null,
          });
        }
      }
      return samples;
    });
    expect(frames.filter((sample) => !sample.text?.includes('Line 1:'))).toEqual([]);
    expect(frames.filter((sample) => Math.abs(sample.boundaryTop - sample.offset) > 2)).toEqual([]);
  });
}
