import { expect, test } from '@playwright/test';
import type { WebviewMessage } from '../../src/shared/protocol';
import { sampleMessageTopAcrossFrames } from './helpers';

type DeferredImageWindow = {
  __sendToExtension?: Window['__sendToExtension'];
  deferredImageRequests?: Array<{ id: number; path: string }>;
};

for (const [width, height] of [
  [320, 180],
  [180, 320],
] as const) {
  test(`deferred ${width}x${height} thumbnails keep their row fixed and load originals only on opening`, async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=heterogeneous-large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();
    await expect
      .poll(() =>
        list.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
      )
      .toBeLessThan(2);
    await page.evaluate(() => {
      // SAFETY: This test owns the extra request log and wraps the harness's existing bridge.
      const target = window as DeferredImageWindow;
      target.deferredImageRequests = [];
      const send = target.__sendToExtension;
      target.__sendToExtension = (message) => {
        // SAFETY: The application bridge sends the WebviewMessage union to this harness callback.
        const request = message as WebviewMessage;
        if (
          request.type === 'api/request' &&
          request.payload.path.includes('/message/deferred-image/part/')
        ) {
          target.deferredImageRequests!.push(request.payload);
          return;
        }
        send?.(message);
      };
      const sessionID = 'session-heterogeneous-large-transcript';
      const info = {
        id: 'deferred-image',
        sessionID,
        role: 'user',
        time: { created: Date.now() },
        agent: 'build',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      };
      const part = {
        id: 'deferred-file',
        sessionID,
        messageID: info.id,
        type: 'file',
        filename: 'deferred.png',
        mime: 'image/png',
        url: `varro-content:/session/${sessionID}/message/${info.id}/part/deferred-file`,
      };
      for (const event of [
        { type: 'message.updated', properties: { info } },
        { type: 'message.part.updated', properties: { part } },
      ])
        window.postMessage({ type: 'server/event', payload: event }, '*');
    });
    const row = page.locator('[data-msg-id="deferred-image"]');
    await expect(row).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          // SAFETY: The bridge fixture above initializes this log before publishing the message.
          return (window as DeferredImageWindow).deferredImageRequests!.length;
        })
      )
      .toBe(1);
    await expect
      .poll(() =>
        list.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
      )
      .toBeLessThan(2);
    const before = await row.boundingBox();
    const anchorTop = before!.y - (await list.boundingBox())!.y;
    const thumbnail =
      'data:image/svg+xml,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="green"/></svg>`
      );
    await page.evaluate((url) => {
      // SAFETY: The request is captured by this test's bridge fixture.
      const request = (window as DeferredImageWindow).deferredImageRequests![0]!;
      if (!request.path.endsWith('?view=thumbnail'))
        throw new Error('The inline image requested its original');
      window.postMessage({ type: 'api/response', payload: { id: request.id, data: { url } } }, '*');
    }, thumbnail);
    await expect(row.locator('.chat-image-img')).toHaveAttribute('src', thumbnail);
    for (const top of await sampleMessageTopAcrossFrames(list, 'deferred-image', 12)) {
      expect(top).not.toBeNull();
      expect(
        Math.abs(top! - anchorTop),
        JSON.stringify({ before, after: await row.boundingBox(), anchorTop, top })
      ).toBeLessThan(1);
    }
    expect((await row.boundingBox())?.height).toBe(before?.height);
    expect((await row.boundingBox())?.y).toBeCloseTo(before!.y, 0);
    await row.getByRole('button', { name: 'Open image preview: deferred.png' }).click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          // SAFETY: The request log belongs to this test's bridge fixture.
          return (window as DeferredImageWindow).deferredImageRequests!.length;
        })
      )
      .toBe(2);
    const original = thumbnail.replace('green', 'blue');
    await page.evaluate((url) => {
      // SAFETY: The second request is the explicit original-image preview request.
      const request = (window as DeferredImageWindow).deferredImageRequests![1]!;
      if (request.path.includes('view=thumbnail'))
        throw new Error('The overlay did not request the original');
      window.postMessage(
        { type: 'api/response', payload: { id: request.id, data: { type: 'file', url } } },
        '*'
      );
    }, original);
    await expect(page.locator('.chat-image-preview-img')).toHaveAttribute('src', original);
    await expect(row.locator('.chat-image-img')).toHaveAttribute('src', thumbnail);
  });
}
