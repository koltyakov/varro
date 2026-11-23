import { expect, test } from '@playwright/test';
import type { MessageEntry } from '../../src/webview/types';
import { installPlaybackCapture } from './helpers';

const sessionId = 'sticky-reflow';
const created = 1_780_000_000_000;
function history(): MessageEntry[] {
  return Array.from({ length: 110 }, (_, index) => {
    const turn = index + 1;
    const userId = `user-${turn}`;
    const assistantId = `answer-${turn}`;
    const table = turn % 10 === 0;
    return [
      {
        info: {
          id: userId,
          sessionID: sessionId,
          role: 'user' as const,
          agent: 'build',
          model: { providerID: 'test', modelID: 'test' },
          time: { created: created + turn * 10 },
        },
        parts: [
          {
            id: `text-${userId}`,
            messageID: userId,
            sessionID: sessionId,
            type: 'text' as const,
            text: table
              ? `[REFLOW:T${turn}] Write a 5-column Markdown table with 14 rows. End with END-${turn}. Do not use tools.`
              : `[REFLOW:T${turn}] Reply with one short sentence ending in END-${turn}. Do not use tools.`,
          },
        ],
      },
      {
        info: {
          id: assistantId,
          parentID: userId,
          sessionID: sessionId,
          role: 'assistant' as const,
          mode: 'build',
          agent: 'build',
          providerID: 'test',
          modelID: 'test',
          time: { created: created + turn * 10, completed: created + turn * 10 + 1 },
          finish: 'stop',
          path: { cwd: '/workspace', root: '/workspace' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: `text-${assistantId}`,
            messageID: assistantId,
            sessionID: sessionId,
            type: 'text' as const,
            text: table
              ? `| Column 1 | Column 2 | Column 3 | Column 4 | Column 5 |\n|---|---|---|---|---|\n${Array.from({ length: 14 }, (_value, row) => `| ${row + 1} | | | | |`).join('\n')}\n\nEND-${turn}`
              : `Understood. END-${turn}`,
          },
        ],
      },
    ];
  }).flat();
}

test('narrowing preserves a prompt at its final sticky-navigation destination', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 850 });
  await installPlaybackCapture(page, {
    session: {
      id: sessionId,
      projectID: 'test',
      directory: '/workspace',
      title: 'Sticky reflow',
      version: '1',
      time: { created, updated: created },
    },
    initialMessages: history(),
  });
  await page.goto('/e2e/harness/index.html?scenario=session-playback');
  const list = page.locator('.interactive-list');
  await expect(page.locator('[data-msg-id="answer-110"]')).toBeVisible();
  await list.hover({ position: { x: 16, y: 60 } });
  await page.mouse.wheel(0, -1200);
  const sticky = page.locator('[data-sticky-msg-id]');
  for (let step = 0; !(await sticky.count()) && step < 60; step += 1) {
    await page.mouse.wheel(0, -96);
    await page.waitForTimeout(50);
  }
  await expect(sticky).toBeVisible();
  const id = await sticky.getAttribute('data-sticky-msg-id');
  const target = page.locator(`[data-msg-id="${id}"] .user-message-card`);
  const stickyBox = await sticky.boundingBox();
  await page.mouse.click(stickyBox!.x + stickyBox!.width / 2, stickyBox!.y + stickyBox!.height / 2);
  const offset = () =>
    target.evaluate(
      (element) =>
        element.getBoundingClientRect().top -
        element.closest('.interactive-list')!.getBoundingClientRect().top
    );
  await expect.poll(offset).toBeCloseTo(8, 0);
  await page.waitForTimeout(1000);
  const before = await offset();
  await page.setViewportSize({ width: 360, height: 850 });
  const samples = await target.evaluate(
    (element) =>
      new Promise<number[]>((resolve) => {
        const values: number[] = [];
        function sample() {
          values.push(
            element.getBoundingClientRect().top -
              element.closest('.interactive-list')!.getBoundingClientRect().top
          );
          if (values.length >= 40) resolve(values);
          else requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      })
  );
  expect(Math.max(...samples.map((top) => Math.abs(top - before)))).toBeLessThanOrEqual(1);
});
