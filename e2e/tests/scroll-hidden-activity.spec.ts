import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry, ToolPart } from '../../src/webview/types';

declare global {
  interface Window {
    hiddenActivityFrames: { paused: boolean; resume(): void };
  }
}

for (const width of [480, 1442]) {
  for (const mode of ['busy', 'late-completion', 'detached'] as const) {
    test(`retires unpainted activity reserve after suspended frames at ${width}px, ${mode}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1092 });
      await page.addInitScript(() => {
        const request = window.requestAnimationFrame.bind(window);
        const cancel = window.cancelAnimationFrame.bind(window);
        const held = new Map<number, FrameRequestCallback>();
        const resumed = new Map<number, number>();
        window.hiddenActivityFrames = {
          paused: false,
          resume() {
            this.paused = false;
            const callbacks = [...held];
            held.clear();
            for (const [id, callback] of callbacks) {
              resumed.set(
                id,
                request((time) => {
                  resumed.delete(id);
                  callback(time);
                })
              );
            }
          },
        };
        window.requestAnimationFrame = (callback) => {
          const id = request((time) => {
            if (window.hiddenActivityFrames.paused) held.set(id, callback);
            else callback(time);
          });
          return id;
        };
        window.cancelAnimationFrame = (id) => {
          held.delete(id);
          const resumedId = resumed.get(id);
          if (resumedId !== undefined) {
            cancel(resumedId);
            resumed.delete(id);
          }
          cancel(id);
        };
      });
      await page.goto(
        '/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayPrefix=1&activeTrayCompletedPrefix=1&activeTrayCount=1'
      );
      const list = page.locator('.interactive-list');
      await expect(list.locator('.assistant-active-activity-item')).toHaveCount(1);
      await page.waitForTimeout(2300);
      await expect
        .poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
        .toBeLessThanOrEqual(1);
      if (mode === 'detached') {
        await list.hover();
        await page.mouse.wheel(0, -180);
        await expect
          .poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
          .toBeGreaterThan(100);
        await page.waitForTimeout(200);
      }
      const before = await list.evaluate((el) => {
        window.hiddenActivityFrames.paused = true;
        return { top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight };
      });
      // Keep the same visible document and real tool heights. Only rendering callbacks stop:
      // timers and server events continue, as when a retained VS Code overlay is off screen.
      for (let cycle = 0; cycle < 12; cycle++) {
        await page.evaluate(() => {
          // SAFETY: Only the isolated fixture's generated session and replay transport are used.
          const harness = (
            window as typeof window & {
              __varroE2E: {
                getSessionMessages(id: string): MessageEntry[];
                replayServerEvent(event: ServerEvent): void;
              };
            }
          ).__varroE2E;
          const assistant = harness
            .getSessionMessages('session-tool-cards')
            .findLast((message) => message.info.role === 'assistant');
          if (!assistant) throw new Error('Missing fixture assistant');
          for (const part of assistant.parts) {
            if (part.type !== 'tool' || part.state.status !== 'running') continue;
            harness.replayServerEvent({
              type: 'message.part.updated',
              properties: {
                part: {
                  ...part,
                  state: {
                    status: 'completed' as const,
                    input: part.state.input,
                    title: part.tool,
                    output: 'Done',
                    metadata: {},
                    time: { start: part.state.time.start, end: Date.now() },
                  },
                },
              },
            });
          }
        });
        await page.waitForTimeout(180);
        if (cycle === 11) continue;
        await page.evaluate((index) => {
          // SAFETY: The fixture owns this session and all of these tool events.
          const harness = (
            window as typeof window & {
              __varroE2E: {
                getSessionMessages(id: string): MessageEntry[];
                replayServerEvent(event: ServerEvent): void;
              };
            }
          ).__varroE2E;
          const assistant = harness
            .getSessionMessages('session-tool-cards')
            .findLast((message) => message.info.role === 'assistant');
          if (!assistant) throw new Error('Missing fixture assistant');
          const part: ToolPart = {
            id: `hidden-activity-${index}`,
            sessionID: assistant.info.sessionID,
            messageID: assistant.info.id,
            callID: `hidden-activity-call-${index}`,
            type: 'tool',
            tool: 'bash',
            state: {
              status: 'running',
              input: { command: `echo replay-${index}` },
              title: `Command ${index}`,
              time: { start: Date.now() },
            },
          };
          harness.replayServerEvent({ type: 'message.part.updated', properties: { part } });
        }, cycle);
        await page.waitForTimeout(100);
      }
      await expect(list.locator('.assistant-active-activity-item')).toHaveCount(0);
      await page.waitForTimeout(1500);
      const beforeResume = await list.evaluate((el) => ({
        top: el.scrollTop,
        height: el.scrollHeight,
        viewport: el.clientHeight,
        reserve: [
          ...el.querySelectorAll('.append-scroll-bottom-reserve, .activity-exit-bottom-reserve'),
        ].reduce((sum, reserve) => sum + reserve.getBoundingClientRect().height, 0),
      }));
      if (mode === 'late-completion') {
        await page.evaluate(() => {
          // SAFETY: This completion affects only the isolated fixture's generated session.
          const harness = (
            window as typeof window & {
              __varroE2E: {
                getSessionMessages(id: string): MessageEntry[];
                replayServerEvent(event: ServerEvent): void;
              };
            }
          ).__varroE2E;
          const assistant = harness
            .getSessionMessages('session-tool-cards')
            .findLast((message) => message.info.role === 'assistant');
          if (!assistant || assistant.info.role !== 'assistant')
            throw new Error('Missing fixture assistant');
          harness.replayServerEvent({
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'hidden-activity-answer',
                sessionID: assistant.info.sessionID,
                messageID: assistant.info.id,
                type: 'text',
                text: 'Final answer after off-screen activity.',
              },
            },
          });
          harness.replayServerEvent({
            type: 'message.updated',
            properties: {
              info: {
                ...assistant.info,
                finish: 'stop',
                time: { ...assistant.info.time, completed: Date.now() },
              },
            },
          });
          harness.replayServerEvent({
            type: 'session.status',
            properties: { sessionID: assistant.info.sessionID, status: { type: 'idle' } },
          });
        });
        // A new follow loop cannot use its own creation time as the last painted frame.
        await page.waitForTimeout(50);
      }
      const frames = await list.evaluate(async (el) => {
        const result = [];
        window.hiddenActivityFrames.resume();
        for (let frame = 0; frame < 45; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
          const view = el.getBoundingClientRect();
          const latest =
            el.querySelector('[data-assistant-render-key="part:hidden-activity-answer"]') ??
            el.querySelector('.interactive-loading-row');
          const latestBox = latest?.getBoundingClientRect();
          result.push({
            top: el.scrollTop,
            hidden: document.hidden,
            reserve: [
              ...el.querySelectorAll(
                '.append-scroll-bottom-reserve, .activity-exit-bottom-reserve'
              ),
            ].reduce((sum, reserve) => sum + reserve.getBoundingClientRect().height, 0),
            gap: el.scrollHeight - el.clientHeight - el.scrollTop,
            latestVisible:
              !!latestBox && latestBox.top < view.bottom && latestBox.bottom > view.top,
          });
        }
        return result;
      });
      await testInfo.attach('suspended-activity-geometry', {
        body: JSON.stringify({ before, beforeResume, frames }, null, 2),
        contentType: 'application/json',
      });
      await page.screenshot({ path: testInfo.outputPath('restored.png') });
      expect(frames.every((frame) => !frame.hidden)).toBe(true);
      const requiredReserve = Math.max(
        0,
        before.top - (beforeResume.height - beforeResume.reserve - beforeResume.viewport)
      );
      // Without frames the reserve cannot give back the 24px Thinking row, but it must not grow.
      expect.soft(beforeResume.reserve).toBeLessThanOrEqual(Math.ceil(requiredReserve) + 26);
      expect(
        frames.every((frame) => frame.reserve < 1),
        JSON.stringify(frames)
      ).toBe(true);
      if (mode === 'detached') {
        expect(frames.every((frame) => Math.abs(frame.top - before.top) <= 1)).toBe(true);
      } else {
        expect(frames.every((frame) => frame.latestVisible && frame.gap <= 1)).toBe(true);
      }
    });
  }
}
