/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: The isolated harness exposes typed fixture mutation methods for this regression. */
import { expect, test } from '@playwright/test';
import type { MessageEntry, Part } from '../../src/webview/types';
import { getScrollMetrics, waitForAnimationFrames } from './helpers';

test('opening Explored during an activity exit preserves its painted summary', async ({ page }) => {
  await page.setViewportSize({ width: 504, height: 800 });
  await page.goto(
    '/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayPrefix=1&activeTrayCount=3'
  );
  await expect(page.locator('.assistant-active-activity-item')).toHaveCount(3);
  await page.waitForTimeout(2100);
  await expect
    .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
    .toBeLessThanOrEqual(1);
  await page.evaluate(() => {
    const harness = (
      window as Window & {
        __varroE2E?: {
          getSessionMessages: (id: string) => MessageEntry[];
          updateMessagePart: (part: Part) => void;
        };
      }
    ).__varroE2E;
    if (!harness) throw new Error('Missing E2E harness');
    for (const part of harness.getSessionMessages('session-tool-cards').flatMap((m) => m.parts)) {
      if (part.type !== 'tool' || part.state.status !== 'running') continue;
      const completed: Part = {
        ...part,
        state: {
          ...part.state,
          status: 'completed',
          title: part.state.title ?? part.tool,
          output: 'Done',
          metadata: {},
          time: { start: Date.now() - 3000, end: Date.now() },
        },
      };
      harness.updateMessagePart(completed);
      window.postMessage(
        {
          type: 'server/event',
          payload: { type: 'message.part.updated', properties: { part: completed } },
        },
        '*'
      );
    }
  });
  await page.waitForFunction(
    () =>
      (document.querySelector('.activity-exit-bottom-reserve')?.getBoundingClientRect().height ??
        0) > 20
  );
  const summary = page.locator('button.assistant-activity-summary');
  await expect(summary).toHaveCount(1);
  const collector = await summary.evaluateHandle((element) => {
    const key = element.getAttribute('data-activity-summary-group-key');
    const state = {
      running: true,
      tops: [element.getBoundingClientRect().top] as Array<number | null>,
      geometry: [] as Array<{ scrollTop: number; height: number; append: number; exit: number }>,
    };
    const sample = () => {
      const current = document.querySelector(
        `button[data-activity-summary-group-key="${CSS.escape(key!)}"]`
      );
      state.tops.push(current?.getBoundingClientRect().top ?? null);
      const list = document.querySelector('.interactive-list')!;
      state.geometry.push({
        scrollTop: list.scrollTop,
        height: list.scrollHeight,
        append:
          document.querySelector('.append-scroll-bottom-reserve')?.getBoundingClientRect().height ??
          0,
        exit:
          document.querySelector('.activity-exit-bottom-reserve')?.getBoundingClientRect().height ??
          0,
      });
      if (state.running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    return state;
  });
  await summary.click();
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await waitForAnimationFrames(page, 30);
  const result = await collector.evaluate((state) => {
    state.running = false;
    return { tops: state.tops, geometry: state.geometry };
  });
  const tops = result.tops;
  const initial = tops[0]!;
  expect(
    tops.every((top) => top !== null && Math.abs(top - initial) <= 1),
    JSON.stringify(result)
  ).toBe(true);
});

test('fast read completion does not reverse an easing mixed-content viewport', async ({ page }) => {
  await page.setViewportSize({ width: 454, height: 1280 });
  await page.goto(
    '/e2e/harness/index.html?scenario=tool-cards-large-transcript&activeTray=1&activeTrayIndex=69&activeTrayCount=3'
  );
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
  await expect(page.locator('.assistant-active-activity-item')).toHaveCount(3);
  // Complete immediately after admission, without waiting for entrance or bottom-follow settlement.
  const samples = await page.locator('.interactive-list').evaluate(async (list) => {
    const viewport = list.getBoundingClientRect();
    const marker = [...list.querySelectorAll('.rendered-markdown p, .user-message-card')].find(
      (element) => {
        const rect = element.getBoundingClientRect();
        return rect.top > viewport.top + 20 && rect.bottom < viewport.bottom - 20;
      }
    );
    if (!marker) throw new Error('Missing painted mixed-content marker');
    const harness = (
      window as Window & {
        __varroE2E?: {
          getSessionMessages: (id: string) => MessageEntry[];
          updateMessagePart: (part: Part) => void;
        };
      }
    ).__varroE2E;
    if (!harness) throw new Error('Missing E2E harness');
    const result = [];
    for (let frame = 0; frame < 240; frame++) {
      if (frame === 0) {
        const running = harness
          .getSessionMessages('session-tool-cards-large-transcript')
          .flatMap((message) => message.parts)
          .filter((part) => part.type === 'tool' && part.state.status === 'running');
        if (running.length !== 3) throw new Error('Expected exactly three running reads');
        for (const part of running) {
          if (part.type !== 'tool') continue;
          const completed: Part = {
            ...part,
            state: {
              status: 'completed',
              input: part.state.input,
              title: 'Read complete',
              output: 'File contents',
              metadata: {},
              time: { start: Date.now() - 30, end: Date.now() },
            },
          };
          harness.updateMessagePart(completed);
          window.postMessage(
            {
              type: 'server/event',
              payload: { type: 'message.part.updated', properties: { part: completed } },
            },
            '*'
          );
        }
      }
      result.push({
        top: marker.getBoundingClientRect().top,
        connected: marker.isConnected,
        scrollTop: list.scrollTop,
        active: list.querySelectorAll('.assistant-active-activity-item').length,
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return result;
  });
  expect(samples[0]!.active).toBe(3);
  expect(samples.at(-1)!.active).toBe(0);
  expect(samples.every((sample) => sample.connected)).toBe(true);
  const reversals = samples.flatMap((sample, index) => {
    const previous = samples[index - 1];
    return previous && sample.top - previous.top > 1 ? [{ previous, sample }] : [];
  });
  expect(reversals).toEqual([]);
});
