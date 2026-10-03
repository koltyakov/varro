import { expect, test } from '@playwright/test';
import type { WebviewMessage } from '../../src/shared/protocol';
import type { FilePart, Message, Part, UserMessage } from '../../src/shared/opencode-types';

type SendRequest = { id: number; sessionID: string; messageID: string; parts: Part[] };
type HandoffWindow = {
  __sendToExtension?: (message: WebviewMessage) => void;
  __varroE2E?: {
    updateMessageInfo: (info: Message) => void;
    updateMessagePart: (part: Part) => void;
  };
  handoff?: {
    send?: SendRequest;
    thumbnails: Array<{ id: number; index: number }>;
    thumbnailUrls: string[];
    originalRequests: number;
    frames: Array<{
      count: number;
      sources: string[];
      decoded: boolean;
      sameNodes: boolean;
      height: number;
    }>;
    stop?: () => void;
  };
};

for (const [width, order] of [
  [380, 'history-first'],
  [380, 'events-first'],
  [1280, 'history-first'],
  [1280, 'events-first'],
] as const) {
  test(`three pasted images remain painted through ${order} acknowledgement and streaming at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/e2e/harness/index.html?scenario=blank');
    await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
    await page.getByText('GPT-4.1', { exact: true }).click();
    const composer = page.locator('.rich-composer').first();
    await composer.fill('Compare these three images. ');
    await composer.evaluate(async (node) => {
      const clipboard = new DataTransfer();
      for (const [index, color] of ['red', 'green', 'blue'].entries()) {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const context = canvas.getContext('2d')!;
        context.fillStyle = color;
        context.fillRect(0, 0, 320, 180);
        const blob = await new Promise<Blob>((resolve) =>
          canvas.toBlob((value) => resolve(value!), 'image/png')
        );
        clipboard.items.add(new File([blob], `image-${index}.png`, { type: 'image/png' }));
      }
      node.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard })
      );
    });
    await expect(page.locator('.inline-chip[data-chip-type="image"]')).toHaveCount(3);
    await page.evaluate(() => {
      // SAFETY: The test extends the harness window with its own request and frame recorder.
      const target = window as HandoffWindow;
      target.handoff = { thumbnails: [], thumbnailUrls: [], originalRequests: 0, frames: [] };
      const previous = target.__sendToExtension;
      target.__sendToExtension = (message) => {
        if (message.type === 'api/request') {
          const { id, method, path, body } = message.payload;
          const send = path.match(/\/session\/([^/]+)\/(?:prompt_async|prompt)(?:\?|$)/);
          if (method === 'POST' && send) {
            // SAFETY: This test captures the real composer's known prompt request shape.
            const prompt = body as { messageID: string; parts: Part[] };
            target.handoff!.send = { id, sessionID: send[1]!, ...prompt };
            return;
          }
          const attachment = path.match(/\/part\/server-image-(\d+)/);
          if (attachment) {
            if (!path.includes('view=thumbnail')) target.handoff!.originalRequests++;
            target.handoff!.thumbnails.push({ id, index: Number(attachment[1]) });
            return;
          }
        }
        previous?.(message);
      };
    });
    await composer.press('Enter');
    await expect
      .poll(() =>
        page.evaluate(() => {
          // SAFETY: The recorder was installed before sending through the real composer.
          return Boolean((window as HandoffWindow).handoff!.send);
        })
      )
      .toBe(true);
    const images = page.locator('.user-message-card .chat-image-img');
    await expect(images).toHaveCount(3);
    await expect
      .poll(() =>
        page.evaluate(() =>
          [
            ...document.querySelectorAll<HTMLImageElement>('.user-message-card .chat-image-img'),
          ].every((node) => node.complete && node.naturalWidth > 0)
        )
      )
      .toBe(true);
    await page.evaluate(() => {
      // SAFETY: The recorder and harness hooks were installed above.
      const target = window as HandoffWindow;
      const initial = [
        ...document.querySelectorAll<HTMLImageElement>('.user-message-card .chat-image-img'),
      ];
      let active = true;
      target.handoff!.stop = () => {
        active = false;
      };
      const tick = () => {
        if (!active) return;
        const nodes = [
          ...document.querySelectorAll<HTMLImageElement>('.user-message-card .chat-image-img'),
        ];
        target.handoff!.frames.push({
          count: nodes.length,
          sources: nodes.map((node) => node.src),
          decoded: nodes.every((node) => node.complete && node.naturalWidth > 0),
          sameNodes: nodes.every((node, index) => node === initial[index]),
          height:
            document.querySelector('.user-message-image-tiles')?.getBoundingClientRect().height ??
            0,
        });
        requestAnimationFrame(tick);
      };
      tick();
    });
    await page.evaluate(async (eventOrder) => {
      // SAFETY: The captured send and recorder are ready before events are released.
      const target = window as HandoffWindow;
      const send = target.handoff!.send!;
      const { sessionID, messageID } = send;
      const info: UserMessage = {
        id: messageID,
        sessionID,
        role: 'user',
        time: { created: Date.now() },
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-4.1' },
      };
      const files = send.parts.filter(
        (part): part is FilePart => part.type === 'file' && part.mime.startsWith('image/')
      );
      const parts: Part[] = [
        {
          id: 'server-text',
          messageID,
          sessionID,
          type: 'text',
          text: 'Compare these three images. ',
        },
        ...files.map((part, index) => ({
          ...part,
          id: `server-image-${index}`,
          messageID,
          sessionID,
          url: `varro-content:/session/${sessionID}/message/${messageID}/part/server-image-${index}`,
        })),
      ];
      const event = (type: string, properties: { info: Message } | { part: Part }) =>
        window.postMessage({ type: 'server/event', payload: { type, properties } }, '*');
      const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 80));
      target.__varroE2E!.updateMessageInfo(info);
      // REST stores the canonical order even when transport events arrive out of order.
      for (const part of parts) target.__varroE2E!.updateMessagePart(part);
      if (eventOrder === 'events-first') {
        event('message.updated', { info });
        // A partial, out-of-order acknowledgement plus repeated metadata must keep all three slots.
        for (const index of [2, 2, 1, 3, 0]) {
          const part = parts[index]!;
          target.__varroE2E!.updateMessagePart(part);
          event('message.part.updated', { part });
          await wait();
          event('message.updated', { info });
        }
      }
      // The post-send history request uses canonical server order, not event arrival order.
      for (const part of parts) target.__varroE2E!.updateMessagePart(part);
      window.postMessage({ type: 'api/response', payload: { id: send.id, data: null } }, '*');
      await wait();
      event('message.updated', { info });
      for (const part of parts) {
        event('message.part.updated', { part });
        await wait();
      }
      const assistant = {
        id: 'streamed-assistant',
        sessionID,
        role: 'assistant' as const,
        parentID: messageID,
        time: { created: Date.now() },
        modelID: 'gpt-4.1',
        providerID: 'openai',
        mode: 'build',
        agent: 'build',
        path: { cwd: '/test', root: '/test' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      };
      target.__varroE2E!.updateMessageInfo(assistant);
      event('message.updated', { info: assistant });
      for (let index = 1; index <= 6; index++) {
        const part: Part = {
          id: 'streamed-text',
          messageID: assistant.id,
          sessionID,
          type: 'text',
          text: 'Comparing the images. '.repeat(index),
        };
        target.__varroE2E!.updateMessagePart(part);
        event('message.part.updated', { part });
        await wait();
      }
    }, order);
    await expect
      .poll(() =>
        page.evaluate(() => {
          // SAFETY: The recorder was installed before sending.
          return (window as HandoffWindow).handoff!.thumbnails.length;
        })
      )
      .toBeGreaterThan(0);
    // Release delayed thumbnails one at a time while the frame recorder remains active.
    for (let index = 0; index < 3; index++) {
      await expect
        .poll(() =>
          page.evaluate(() => {
            // SAFETY: The recorder was installed before sending.
            return (window as HandoffWindow).handoff!.thumbnails.length;
          })
        )
        .toBeGreaterThan(index);
      await page.evaluate(async (requestIndex) => {
        // SAFETY: Polling above established that the captured thumbnail request exists.
        const target = window as HandoffWindow;
        const request = target.handoff!.thumbnails[requestIndex]!;
        const files = target.handoff!.send!.parts.filter(
          (part): part is FilePart => part.type === 'file' && part.mime.startsWith('image/')
        );
        const image = new Image();
        image.src = files[request.index]!.url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        canvas.getContext('2d')!.drawImage(image, 0, 0, 160, 90);
        const url = canvas.toDataURL('image/webp');
        target.handoff!.thumbnailUrls[request.index] = url;
        window.postMessage(
          {
            type: 'api/response',
            payload: { id: request.id, data: { url } },
          },
          '*'
        );
      }, index);
    }
    await expect(
      page.locator('.user-message-card .chat-image-img[src^="data:image/webp"]')
    ).toHaveCount(3);
    const result = await page.evaluate(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
      // SAFETY: This reads the same recorder installed before acknowledgement.
      const target = window as HandoffWindow;
      target.handoff!.stop!();
      return {
        frames: target.handoff!.frames,
        originalRequests: target.handoff!.originalRequests,
        originalUrls: target
          .handoff!.send!.parts.filter(
            (part): part is FilePart => part.type === 'file' && part.mime.startsWith('image/')
          )
          .map((part) => part.url),
        thumbnailUrls: target.handoff!.thumbnailUrls,
        thumbnailRequests: target.handoff!.thumbnails.length,
      };
    });
    await testInfo.attach('image-handoff-frames', {
      body: JSON.stringify(result),
      contentType: 'application/json',
    });
    expect(result.originalRequests).toBe(0);
    expect(result.thumbnailRequests).toBe(3);
    expect(result.frames.length).toBeGreaterThan(20);
    expect([...new Set(result.frames.map((frame) => frame.count))]).toEqual([3]);
    expect(result.frames.every((frame) => frame.sameNodes)).toBe(true);
    expect(
      result.frames.every(
        (frame) =>
          frame.decoded &&
          frame.sources.every(
            (source, index) =>
              source === result.originalUrls[index] || source === result.thumbnailUrls[index]
          )
      )
    ).toBe(true);
    expect(
      Math.max(...result.frames.map((frame) => frame.height)) -
        Math.min(...result.frames.map((frame) => frame.height))
    ).toBeLessThanOrEqual(1);
  });
}
