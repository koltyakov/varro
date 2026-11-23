/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Browser callbacks access only the isolated E2E harness and its captured send request. */
import { expect, test } from '@playwright/test';
import type { ServerEvent, WebviewMessage } from '../../src/shared/protocol';
import type { SessionSendBody } from '../../src/webview/hooks/session/session-send';
import type { MessageEntry, Part } from '../../src/webview/types';
import { getListDistanceFromBottom, getScrollMetrics, waitForAnimationFrames } from './helpers';

type SteeringWindow = Window & {
  capturedSteer?: { requestId: number; body: SessionSendBody };
  __varroE2E?: {
    getSessionMessages(sessionId: string): MessageEntry[];
    updateMessagePart(part: Part): void;
    replayServerEvent(event: ServerEvent): void;
  };
};

for (const virtual of [false, true]) {
  for (const detach of ['never', 'before steering', 'before admission']) {
    test(`queued steering preserves follow after activity collapse, virtual=${virtual}, detach=${detach}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 500, height: 700 });
      const sessionId = virtual ? 'session-tool-cards-large-transcript' : 'session-tool-cards';
      await page.goto(
        virtual
          ? '/e2e/harness/index.html?scenario=tool-cards-large-transcript&activeTray=1&activeTrayIndex=69&activeTrayCount=1'
          : '/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayPrefix=1&activeTrayCount=1'
      );
      const list = page.locator('.interactive-list');
      const tray = page.locator('.assistant-active-activity-item');
      await expect(tray).toHaveCount(1);
      await expect.poll(() => getListDistanceFromBottom(page)).toBeLessThanOrEqual(1);
      // Preserve production retention, then collapse the live tool into its summary.
      await page.waitForTimeout(2100);
      await page.evaluate((id) => {
        const harness = (window as SteeringWindow).__varroE2E!;
        const running = harness
          .getSessionMessages(id)
          .flatMap((entry) => entry.parts)
          .find((part) => part.type === 'tool' && part.state.status === 'running');
        if (!running || running.type !== 'tool' || running.state.status !== 'running')
          throw new Error('Missing running tool');
        const completed: Part = {
          ...running,
          state: {
            ...running.state,
            status: 'completed',
            title: running.state.title ?? 'Search',
            metadata: running.state.metadata ?? {},
            output: 'Done',
            time: { ...running.state.time, end: Date.now() },
          },
        };
        harness.updateMessagePart(completed);
        harness.replayServerEvent({
          type: 'message.part.updated',
          properties: { part: completed },
        });
      }, sessionId);
      await expect(tray).toHaveCount(0);
      await expect(page.locator('.append-scroll-bottom-reserve')).toHaveCSS('height', /[1-9]/);
      await waitForAnimationFrames(page, 35);

      const text = Array.from(
        { length: 10 },
        (_, index) => `Steering instruction line ${index + 1}.`
      ).join('\n');
      await page.getByRole('textbox', { name: 'Message composer' }).fill(text);
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
      const scrollAway = async () => {
        await list.hover();
        await page.mouse.wheel(0, -300);
        await expect.poll(() => getListDistanceFromBottom(page)).toBeGreaterThan(150);
        await waitForAnimationFrames(page, 10);
      };
      if (detach === 'before steering') await scrollAway();
      const beforeSend = await getScrollMetrics(page, '.interactive-list');
      await page.getByRole('button', { name: 'Send as Steer', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !!(window as SteeringWindow).capturedSteer);
      await waitForAnimationFrames(page, 10);
      if (detach === 'before steering') {
        expect(
          Math.abs(
            (await getScrollMetrics(page, '.interactive-list')).scrollTop - beforeSend.scrollTop
          )
        ).toBeLessThanOrEqual(2);
      }
      if (detach === 'before admission') await scrollAway();
      const beforeAdmission = await getScrollMetrics(page, '.interactive-list');
      await page.evaluate(
        ({ id, text: promptText }) => {
          const harness = window as SteeringWindow;
          const request = harness.capturedSteer!;
          const messageId = request.body.messageID!;
          const entry: MessageEntry = {
            info: {
              id: messageId,
              sessionID: id,
              role: 'user',
              delivery: 'steer',
              agent: request.body.agent ?? 'build',
              model: request.body.model ?? { providerID: 'copilot', modelID: 'gpt-5-mini' },
              time: { created: Date.now() },
            },
            parts: [
              {
                id: `${messageId}-text`,
                messageID: messageId,
                sessionID: id,
                type: 'text',
                text: promptText,
              },
            ],
          };
          harness.__varroE2E!.replayServerEvent({
            type: 'message.updated',
            properties: { info: entry.info },
          });
          for (const part of entry.parts)
            harness.__varroE2E!.replayServerEvent({
              type: 'message.part.updated',
              properties: { part },
            });
          window.postMessage(
            { type: 'api/response', payload: { id: request.requestId, data: null } },
            '*'
          );
        },
        { id: sessionId, text }
      );
      const card = page
        .locator('.user-message-card')
        .filter({ hasText: 'Steering instruction line 1.' });
      await expect(card).toHaveCount(1);
      if (detach === 'never') {
        await expect.poll(() => getListDistanceFromBottom(page)).toBeLessThanOrEqual(1);
        await expect(card).toBeInViewport();
      } else {
        const samples = await list.evaluate(async (element) => {
          const tops: number[] = [];
          for (let frame = 0; frame < 35; frame += 1) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            tops.push(element.scrollTop);
          }
          return tops;
        });
        expect(
          samples.every((top) => Math.abs(top - beforeAdmission.scrollTop) <= 2),
          JSON.stringify(samples)
        ).toBe(true);
      }
    });
  }
}
