import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry, ToolPart } from '../../src/webview/types';
import { getScrollMetrics } from './helpers';

for (const distance of [540, 1768]) {
  test(`return to latest survives tool completion during a ${distance}px scroll`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 486, height: 900 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await page.evaluate(() => {
      // SAFETY: The isolated E2E page installs the typed fixture event transport.
      const harness = (
        window as typeof window & {
          __varroE2E: { replayServerEvent(event: ServerEvent): void };
        }
      ).__varroE2E;
      harness.replayServerEvent({
        type: 'session.status',
        properties: { sessionID: 'session-large-transcript', status: { type: 'busy' } },
      });
      harness.replayServerEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'return-running-tool',
            callID: 'return-running-tool',
            sessionID: 'session-large-transcript',
            messageID: 'message-large-assistant-239',
            type: 'tool',
            tool: 'read',
            state: {
              status: 'running',
              input: { filePath: '/workspace/probe.txt' },
              time: { start: 1 },
            },
          },
        },
      });
    });
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(2);
    await list.hover({ position: { x: 20, y: 100 } });
    await page.mouse.wheel(0, -distance);
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeGreaterThan(distance - 50);
    const button = page.getByRole('button', { name: 'Scroll to latest message', exact: true });
    await expect(button).toBeVisible();

    const recording = list.evaluate(async (element) => {
      // SAFETY: The isolated E2E page installs the typed fixture event transport and message store.
      const harness = (
        window as typeof window & {
          __varroE2E: {
            replayServerEvent(event: ServerEvent): void;
            getSessionMessages(id: string): MessageEntry[];
          };
        }
      ).__varroE2E;
      const initialTop = element.scrollTop;
      let completed = false;
      let settledFrames = 0;
      const samples = [];
      for (let frame = 0; frame < 600; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const remaining = element.scrollHeight - element.clientHeight - element.scrollTop;
        if (!completed && element.scrollTop > initialTop + 10) {
          const entry = harness
            .getSessionMessages('session-large-transcript')
            .find((message) => message.info.id === 'message-large-assistant-239')!;
          const tool = entry.parts.find(
            (part): part is ToolPart => part.type === 'tool' && part.id === 'return-running-tool'
          )!;
          harness.replayServerEvent({
            type: 'message.part.updated',
            properties: {
              part: {
                ...tool,
                state: {
                  status: 'completed' as const,
                  input: tool.state.input,
                  title: 'Read probe',
                  output: 'contents',
                  metadata: {},
                  time: { start: 1, end: 2 },
                },
              },
            },
          });
          harness.replayServerEvent({
            type: 'session.status',
            properties: { sessionID: 'session-large-transcript', status: { type: 'idle' } },
          });
          completed = true;
        }
        const viewport = element.getBoundingClientRect();
        const rows = Array.from(element.querySelectorAll<HTMLElement>('[data-msg-id]'));
        samples.push({
          remaining,
          completed,
          painted: rows.some((row) => {
            const rect = row.getBoundingClientRect();
            return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
          }),
          duplicates: rows.length - new Set(rows.map((row) => row.dataset.msgId)).size,
        });
        settledFrames = completed && remaining <= 2 ? settledFrames + 1 : 0;
        if (settledFrames >= 5) break;
      }
      return samples;
    });
    await button.click();
    const samples = await recording;
    await testInfo.attach('return-frames', {
      body: JSON.stringify(samples),
      contentType: 'application/json',
    });
    expect(samples.find((sample) => sample.completed)?.remaining).toBeGreaterThan(2);
    expect(samples.at(-1)?.remaining).toBeLessThanOrEqual(2);
    expect(samples.every((sample) => sample.painted && sample.duplicates === 0)).toBe(true);
    await expect(button).toHaveCount(0);
  });
}
