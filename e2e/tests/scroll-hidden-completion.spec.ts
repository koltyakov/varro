import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry } from '../../src/webview/types';
import { waitForAnimationFrames } from './helpers';

declare global {
  interface Window {
    hiddenCompletionFrames: { paused: boolean; resume(): void };
  }
}

for (const virtual of [false, true]) {
  for (const visibilityEvent of [false, true]) {
    for (const detached of [false, true]) {
      test(`restores real content after hidden completion, virtual=${virtual}, visibility=${visibilityEvent}, detached=${detached}`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width: 480, height: 850 });
        await page.addInitScript(() => {
          const request = window.requestAnimationFrame.bind(window);
          const cancel = window.cancelAnimationFrame.bind(window);
          const held = new Map<number, FrameRequestCallback>();
          window.hiddenCompletionFrames = {
            paused: false,
            resume() {
              this.paused = false;
              const callbacks = [...held.values()];
              held.clear();
              for (const callback of callbacks) request(callback);
            },
          };
          window.requestAnimationFrame = (callback) => {
            const id = request((time) => {
              if (window.hiddenCompletionFrames.paused) held.set(id, callback);
              else callback(time);
            });
            return id;
          };
          window.cancelAnimationFrame = (id) => {
            held.delete(id);
            cancel(id);
          };
        });
        const scenario = virtual ? 'tool-cards-large-transcript' : 'tool-cards';
        await page.goto(
          `/e2e/harness/index.html?scenario=${scenario}&activeTray=1&activeTrayPrefix=1&activeTrayIndex=69&activeTrayCount=1`
        );
        const list = page.locator('.interactive-list');
        await expect(list.locator('.assistant-active-activity-item')).toHaveCount(1);
        // Amplify the disappearing flow space, without setting reserve or scroll-owner state.
        await page.addStyleTag({
          content: '.assistant-active-activity-items { min-height: 2400px; }',
        });
        await list.hover();
        await page.mouse.wheel(0, 100_000);
        await expect
          .poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
          .toBeLessThanOrEqual(1);
        await waitForAnimationFrames(page, 20);
        if (detached) {
          await list.hover();
          await page.mouse.wheel(0, -100_000);
          await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0);
          await waitForAnimationFrames(page, 20);
        }
        await page.evaluate(
          ({ visibilityEvent: notifyVisibility, sessionID }) => {
            window.hiddenCompletionFrames.paused = true;
            if (notifyVisibility) {
              Object.defineProperty(document, 'hidden', { configurable: true, value: true });
              document.dispatchEvent(new Event('visibilitychange'));
            }
            // SAFETY: This is the isolated harness's generated session and event transport.
            const harness = (
              window as typeof window & {
                __varroE2E: {
                  getSessionMessages(id: string): MessageEntry[];
                  replayServerEvent(event: ServerEvent): void;
                };
              }
            ).__varroE2E;
            const messages = harness.getSessionMessages(sessionID);
            for (const message of messages) {
              for (const part of message.parts) {
                if (part.type !== 'tool' || part.state.status !== 'running') continue;
                harness.replayServerEvent({
                  type: 'message.part.updated',
                  properties: {
                    part: {
                      ...part,
                      state: {
                        status: 'completed' as const,
                        input: part.state.input,
                        output: 'Done',
                        title: part.tool,
                        metadata: {},
                        time: { start: part.state.time.start, end: Date.now() },
                      },
                    },
                  },
                });
              }
            }
            const answer = messages.findLast((message) => message.info.role === 'assistant');
            if (!answer || answer.info.role !== 'assistant')
              throw new Error('Missing fixture answer');
            harness.replayServerEvent({
              type: 'message.part.updated',
              properties: {
                part: {
                  id: 'hidden-completion-answer',
                  messageID: answer.info.id,
                  sessionID,
                  type: 'text',
                  text: 'Final answer after hidden completion.',
                },
              },
            });
            harness.replayServerEvent({
              type: 'message.updated',
              properties: {
                info: {
                  ...answer.info,
                  finish: 'stop',
                  time: { ...answer.info.time, completed: Date.now() },
                },
              },
            });
            harness.replayServerEvent({
              type: 'session.status',
              properties: { sessionID, status: { type: 'idle' } },
            });
          },
          { visibilityEvent, sessionID: `session-${scenario}` }
        );
        await expect(list.locator('.assistant-active-activity-item')).toHaveCount(0);
        if (!detached) {
          await expect
            .poll(() =>
              list.evaluate((el) =>
                [
                  ...el.querySelectorAll(
                    '.append-scroll-bottom-reserve, .activity-exit-bottom-reserve'
                  ),
                ].reduce((height, reserve) => height + reserve.getBoundingClientRect().height, 0)
              )
            )
            .toBeGreaterThan(2000);
        }
        // Exercise frame-gap recovery as well as explicit visibility restoration.
        await page.waitForTimeout(1500);
        const frames = await list.evaluate(async (el, notifyVisibility) => {
          const sample = () => {
            const view = el.getBoundingClientRect();
            const answer = el
              .querySelector('[data-assistant-render-key="part:hidden-completion-answer"]')
              ?.getBoundingClientRect();
            return {
              top: el.scrollTop,
              answerVisible:
                !!answer &&
                answer.height > 0 &&
                answer.top < view.bottom &&
                answer.bottom > view.top,
              reserve: [
                ...el.querySelectorAll(
                  '.append-scroll-bottom-reserve, .activity-exit-bottom-reserve'
                ),
              ].reduce((height, reserve) => height + reserve.getBoundingClientRect().height, 0),
              visible: [...el.querySelectorAll('[data-msg-id]')].filter((row) => {
                const box = row.getBoundingClientRect();
                return box.height > 0 && box.top < view.bottom && box.bottom > view.top;
              }).length,
            };
          };
          if (notifyVisibility) {
            Object.defineProperty(document, 'hidden', { configurable: true, value: false });
            document.dispatchEvent(new Event('visibilitychange'));
          }
          const samples = notifyVisibility ? [sample()] : [];
          window.hiddenCompletionFrames.resume();
          for (let frame = 0; frame < 40; frame++) {
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => setTimeout(resolve, 0))
            );
            samples.push(sample());
          }
          Reflect.deleteProperty(document, 'hidden');
          return samples;
        }, visibilityEvent);
        await testInfo.attach('restored-frames', {
          body: JSON.stringify(frames, null, 2),
          contentType: 'application/json',
        });
        await page.screenshot({ path: testInfo.outputPath('restored.png') });
        expect(
          frames.every((frame) => frame.visible > 0),
          JSON.stringify(frames)
        ).toBe(true);
        if (detached)
          expect(
            frames.every((frame) => frame.top === 0),
            JSON.stringify(frames)
          ).toBe(true);
        else {
          expect(
            frames.every((frame) => frame.reserve < 1),
            JSON.stringify(frames)
          ).toBe(true);
          expect(
            frames.every((frame) => frame.answerVisible),
            JSON.stringify(frames)
          ).toBe(true);
        }
      });
    }
  }
}
