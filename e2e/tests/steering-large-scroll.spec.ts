/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Browser callbacks access only the isolated E2E harness and its captured send request. */
import { expect, test } from '@playwright/test';
import type { ServerEvent, WebviewMessage } from '../../src/shared/protocol';
import type { SessionSendBody } from '../../src/webview/hooks/session/session-send';
import type { MessageEntry, Part } from '../../src/webview/types';
import { getListDistanceFromBottom, postWebviewMessage, waitForAnimationFrames } from './helpers';

type SteeringWindow = Window & {
  capturedSteer?: { requestId: number; body: SessionSendBody };
  __varroE2E?: {
    getSessionMessages(sessionId: string): MessageEntry[];
    updateMessagePart(part: Part): void;
    replayServerEvent(event: ServerEvent): void;
  };
};

interface FollowSample {
  distance: number;
  cardBottom: number | null;
  listBottom: number;
}

// The optimistic card already paints the complete steer. Admission groups the running tool into
// a summary above that card, so no response text changes after the collapse to release its owner.
for (const virtual of [false, true]) {
  for (const content of ['large text', 'image', 'terminal'] as const) {
    test(`admitted ${content} steer during a running tool is followed into view, virtual=${virtual}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 500, height: 700 });
      const sessionId = virtual ? 'session-tool-cards-large-transcript' : 'session-tool-cards';
      await page.goto(
        virtual
          ? '/e2e/harness/index.html?scenario=tool-cards-large-transcript&activeTray=1&activeTrayIndex=69&activeTrayCount=1'
          : '/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayPrefix=1&activeTrayCount=1'
      );
      await expect(page.locator('.assistant-active-activity-item')).toHaveCount(1);
      await expect.poll(() => getListDistanceFromBottom(page)).toBeLessThanOrEqual(1);
      await waitForAnimationFrames(page, 35);

      const composer = page.getByRole('textbox', { name: 'Message composer' });
      if (content === 'large text') {
        await composer.fill(
          [
            'Steer marker',
            ...Array.from({ length: 30 }, (_, index) => `Steering instruction line ${index + 1}.`),
          ].join('\n')
        );
      } else {
        await composer.fill('Steer marker');
      }
      if (content === 'image') {
        await composer.evaluate(async (node) => {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 180;
          const context = canvas.getContext('2d')!;
          context.fillStyle = 'teal';
          context.fillRect(0, 0, 320, 180);
          const blob = await new Promise<Blob>((resolve) =>
            canvas.toBlob((value) => resolve(value!), 'image/png')
          );
          const clipboard = new DataTransfer();
          clipboard.items.add(new File([blob], 'steer.png', { type: 'image/png' }));
          node.dispatchEvent(
            new ClipboardEvent('paste', {
              bubbles: true,
              cancelable: true,
              clipboardData: clipboard,
            })
          );
        });
        await expect(page.locator('.inline-chip[data-chip-type="image"]')).toHaveCount(1);
      }
      if (content === 'terminal') {
        await postWebviewMessage(page, {
          type: 'terminal-selection/update',
          payload: {
            terminalName: 'zsh',
            text: Array.from({ length: 20 }, (_, index) => `output line ${index + 1}`).join('\n'),
          },
        });
        await expect(
          page.locator('.chat-attachment-chip').filter({ hasText: 'zsh' })
        ).toBeVisible();
      }
      await page.getByLabel('Add to queue (Enter)').click();
      await expect(page.getByRole('list', { name: 'Queued messages' })).toBeVisible();
      await page.evaluate(() => {
        const harness = window as SteeringWindow;
        const send = harness.__sendToExtension;
        harness.__sendToExtension = (message) => {
          const request = message as
            | Partial<Extract<WebviewMessage, { type: 'api/request' }>>
            | null
            | undefined;
          if (
            request?.type === 'api/request' &&
            request.payload &&
            /\/prompt_async(?:\?|$)/.test(request.payload.path)
          ) {
            harness.capturedSteer = {
              requestId: request.payload.id,
              body: request.payload.body as SessionSendBody,
            };
            return;
          }
          return send?.(message);
        };
      });
      await page.getByRole('button', { name: 'Send as Steer', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !!(window as SteeringWindow).capturedSteer);
      await waitForAnimationFrames(page, 10);

      const samples = await page.evaluate(async (id) => {
        const harness = window as SteeringWindow;
        const request = harness.capturedSteer!;
        const messageId = request.body.messageID!;
        const info: MessageEntry['info'] = {
          id: messageId,
          sessionID: id,
          role: 'user',
          delivery: 'steer',
          agent: request.body.agent ?? 'build',
          model: request.body.model ?? { providerID: 'copilot', modelID: 'gpt-5-mini' },
          time: { created: Date.now() },
        };
        harness.__varroE2E!.replayServerEvent({ type: 'message.updated', properties: { info } });
        // Publish exactly what the composer sent, as OpenCode does for the admitted steer.
        for (const [index, sent] of request.body.parts.entries()) {
          harness.__varroE2E!.replayServerEvent({
            type: 'message.part.updated',
            properties: {
              part: {
                ...sent,
                id: `${messageId}-part-${index}`,
                messageID: messageId,
                sessionID: id,
              } as Part,
            },
          });
        }
        window.postMessage(
          { type: 'api/response', payload: { id: request.requestId, data: null } },
          '*'
        );
        const list = document.querySelector<HTMLElement>('.interactive-list')!;
        const result: FollowSample[] = [];
        for (let frame = 0; frame < 60; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const card = document.querySelector<HTMLElement>(
            `[data-msg-id="${messageId}"] .user-message-card`
          );
          result.push({
            distance: Math.round(list.scrollHeight - list.clientHeight - list.scrollTop),
            cardBottom: card ? Math.round(card.getBoundingClientRect().bottom) : null,
            listBottom: Math.round(list.getBoundingClientRect().bottom),
          });
        }
        return result;
      }, sessionId);

      // Follow eases toward the card. A retained summary owner instead holds the viewport for its
      // whole settle window (about 30 frames), and indefinitely while a bottom reserve remains.
      let longestStall = 0;
      let stall = 0;
      for (const [index, sample] of samples.entries()) {
        stall =
          sample.distance > 2 && index > 0 && samples[index - 1]!.distance === sample.distance
            ? stall + 1
            : 0;
        longestStall = Math.max(longestStall, stall);
      }
      expect(longestStall, JSON.stringify(samples)).toBeLessThanOrEqual(12);
      const last = samples.at(-1)!;
      expect(last.cardBottom, JSON.stringify(samples)).not.toBeNull();
      expect(last.cardBottom!, JSON.stringify(samples)).toBeLessThanOrEqual(last.listBottom);
      expect(last.distance, JSON.stringify(samples)).toBeLessThanOrEqual(1);
    });
  }
}
