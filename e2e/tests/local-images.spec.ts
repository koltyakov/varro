import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { MessageEntry, TextPart } from '../../src/webview/types';
import type { ServerEvent } from '../../src/shared/protocol';
import { scrollToBottom } from './helpers';

async function installImage(page: Page, source: string) {
  await page.evaluate((path) => {
    // SAFETY: Only the isolated E2E fixture exposes this playback transport.
    const harness = (
      window as Window & {
        __varroE2E?: {
          getSessionMessages(id: string): MessageEntry[];
          replayServerEvent(event: ServerEvent): void;
        };
      }
    ).__varroE2E;
    if (!harness) throw new Error('Image fixture transport unavailable');
    const message = harness
      .getSessionMessages('session-large-transcript')
      .find((entry) => entry.info.id === 'message-large-assistant-239');
    if (!message) throw new Error('Image fixture message unavailable');
    const previous = message.parts.find((part) => part.type === 'text');
    const part: TextPart = {
      id: previous?.id ?? 'local-image',
      sessionID: message.info.sessionID,
      messageID: message.info.id,
      type: 'text',
      text: `![Local screenshot](${path})\n\nAfter image.`,
    };
    harness.replayServerEvent({ type: 'message.part.updated', properties: { part } });
    window.postMessage(
      {
        type: 'config/update',
        payload: {
          remoteImages: 'off',
          desktopSessionPaneSide: 'right',
          defaultPermissionMode: 'default',
          chatFontSize: 13,
          chatEditorFontSize: 12,
          chatFontFamily: 'default',
        },
      },
      window.location.origin
    );
  }, source);
}

async function requestBodies(page: Page) {
  // SAFETY: The isolated harness records host API requests for assertions.
  return page.evaluate(
    () =>
      (
        window as Window & {
          __varroE2E?: {
            requests: Array<{ path: string; body: { original?: boolean; directory?: string } }>;
          };
        }
      ).__varroE2E?.requests
        .filter((request) => request.path === '/varro/local-image')
        .map((request) => request.body) ?? []
  );
}

for (const width of [360, 960]) {
  test(`local images load with remote images off and retain geometry at ${width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await installImage(page, 'artifacts/status-slot-explanation/44px-activity-row.png');
    const row = page.locator('[data-msg-id="message-large-assistant-239"]');
    const frame = row.locator('[data-local-image]');
    await expect(frame.locator('.local-markdown-image-placeholder')).toBeVisible();
    const before = await frame.boundingBox();
    const beforeRow = await row.boundingBox();
    expect(before?.width).toBeGreaterThan(150);
    expect(before?.height).toBeGreaterThan(80);
    await expect(frame.locator('img')).toBeVisible();
    const after = await frame.boundingBox();
    expect(after?.width).toBe(before?.width);
    expect(after?.height).toBe(before?.height);
    expect(await row.boundingBox().then((box) => box?.height)).toBe(beforeRow?.height);
    const requests = await requestBodies(page);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.original).not.toBe(true);
    await frame.getByRole('button', { name: 'Open image preview: Local screenshot' }).click();
    const preview = page.locator('.chat-image-preview-img');
    await expect(preview).toBeVisible();
    await expect
      .poll(() =>
        preview.evaluate((image) => {
          if (!(image instanceof HTMLImageElement)) throw new Error('Expected image preview');
          return image.naturalWidth;
        })
      )
      .toBe(960);
    expect((await requestBodies(page)).filter((body) => body.original)).toHaveLength(1);
    await page.getByRole('button', { name: 'Close image preview', exact: true }).click();
    await page.screenshot({ path: test.info().outputPath('local-image-loaded.png') });

    const list = page.locator('.interactive-list');
    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -10000, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(row).toHaveCount(0);
    await scrollToBottom(list);
    await expect(frame.locator('img')).toBeVisible();
    expect(await frame.boundingBox().then((box) => box?.height)).toBe(before?.height);
    expect(errors).toEqual([]);
  });
}

for (const source of ['/workspace/chart.png', 'file:///workspace/chart.png']) {
  test(`supports an explicit local image target: ${source}`, async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    await installImage(page, source);
    await expect(page.locator('[data-local-image] img')).toBeVisible();
    await expect(page.locator('[data-remote-image]')).toHaveCount(0);
  });
}
