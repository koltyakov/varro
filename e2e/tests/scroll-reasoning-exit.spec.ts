import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry } from '../../src/webview/types';

for (const fraction of [0.1, 0.3, 0.6]) {
  test(`reasoning exit preserves the painted bottom: ${fraction}px fraction`, async ({ page }) => {
    await page.setViewportSize({ width: 486, height: 400 });
    await page.goto(
      '/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayPrefix=1&activeTrayCompletedPrefix=1&activeTrayCount=1&activeTrayReasoning=1'
    );
    await page.addStyleTag({
      content: `.assistant-active-activity-item-content { padding-bottom: ${fraction}px; }`,
    });
    await expect(page.locator('.assistant-active-activity-item')).toHaveCount(1);
    await expect
      .poll(() =>
        page
          .locator('.interactive-list')
          .evaluate((list) => list.scrollHeight - list.clientHeight - list.scrollTop)
      )
      .toBeLessThanOrEqual(1);
    await page.waitForTimeout(400);
    const samples = await page.evaluate(async () => {
      // SAFETY: The isolated harness installs typed production-event replay and fixture readers.
      const harness = (
        window as Window & {
          __varroE2E?: {
            getSessionMessages(id: string): MessageEntry[];
            replayServerEvent(event: ServerEvent): void;
          };
        }
      ).__varroE2E;
      const list = document.querySelector<HTMLElement>('.interactive-list');
      const listBox = list?.getBoundingClientRect();
      const marker = [
        ...(list?.querySelectorAll<HTMLElement>('.assistant-activity-summary') ?? []),
      ].find((element) => {
        const box = element.getBoundingClientRect();
        return listBox && box.bottom > listBox.top && box.top < listBox.bottom;
      });
      const initial = harness
        ?.getSessionMessages('session-tool-cards')
        .find((entry) => entry.info.id === 'message-tool-cards-assistant');
      if (!harness || !list || !marker || !initial) throw new Error('Missing reasoning fixture');
      const row = list.querySelector<HTMLElement>('[data-msg-id="message-tool-cards-assistant"]');
      const item = row?.querySelector<HTMLElement>('.assistant-active-activity-item');
      const flow = item?.closest('.assistant-active-activity-tray')?.parentElement;
      if (!row || !item || !flow) throw new Error('Missing reasoning geometry');
      const requiredReserve =
        item.getBoundingClientRect().height +
        (Number.parseFloat(getComputedStyle(flow).rowGap) || 0) +
        (Number.parseFloat(row.style.getPropertyValue('--interactive-item-block-correction')) || 0);
      const sample = () => ({
        top: marker.getBoundingClientRect().top,
        scrollTop: list.scrollTop,
        exiting: list.querySelectorAll('.assistant-active-activity-item').length,
        reserve:
          list.querySelector('.activity-exit-bottom-reserve')?.getBoundingClientRect().height ?? 0,
        correction: list
          .querySelector<HTMLElement>('[data-msg-id="message-tool-cards-assistant"]')
          ?.style.getPropertyValue('--interactive-item-block-correction'),
      });
      const result = [sample()];
      for (const part of initial.parts) {
        if (part.type !== 'reasoning') continue;
        harness.replayServerEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              ...part,
              time: { start: part.time?.start ?? Date.now() - 1000, end: Date.now() },
            },
          },
        });
      }
      if (initial.info.role !== 'assistant') throw new Error('Missing assistant fixture');
      harness.replayServerEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'reasoning-following-tool',
            callID: 'reasoning-following-call',
            sessionID: initial.info.sessionID,
            messageID: initial.info.id,
            type: 'tool',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'git diff --check' },
              output: 'Done',
              title: 'Checked',
              metadata: {},
              time: { start: Date.now() - 1000, end: Date.now() },
            },
          },
        },
      });
      harness.replayServerEvent({
        type: 'message.updated',
        properties: {
          info: {
            ...initial.info,
            finish: 'tool-calls',
            time: { ...initial.info.time, completed: Date.now() },
          },
        },
      });
      harness.replayServerEvent({
        type: 'message.updated',
        properties: {
          info: {
            ...initial.info,
            id: 'reasoning-next-step',
            finish: undefined,
            time: { created: Date.now() },
          },
        },
      });
      const deadline = performance.now() + 5000;
      let settledFrames = 0;
      while (performance.now() < deadline && settledFrames < 10) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const next = sample();
        result.push(next);
        settledFrames = next.exiting === 0 ? settledFrames + 1 : 0;
      }
      return { samples: result, requiredReserve, connected: marker.isConnected };
    });
    await test.info().attach('reasoning-exit-frames', {
      body: JSON.stringify(samples),
      contentType: 'application/json',
    });
    expect(samples.connected).toBe(true);
    expect(samples.samples[0]!.scrollTop).toBeGreaterThan(0);
    expect(Number.parseFloat(samples.samples[0]!.correction ?? '')).toBeGreaterThan(0);
    expect(samples.samples.find((sample) => sample.reserve > 0)?.reserve).toBeGreaterThanOrEqual(
      samples.requiredReserve - 0.01
    );
    expect(samples.samples.at(-1)?.exiting).toBe(0);
    expect(
      samples.samples
        .slice(1)
        .filter((sample, index) => sample.top > samples.samples[index]!.top + 0.1)
    ).toEqual([]);
  });
}
