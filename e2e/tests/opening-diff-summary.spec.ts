import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { AssistantMessage, MessageEntry } from '../../src/webview/types';

const sessionId = 'opening-diff-fixture';
const created = 1_780_000_000_000;

function assistant(id: string, parentID: string): AssistantMessage {
  return {
    id,
    parentID,
    sessionID: sessionId,
    role: 'assistant',
    mode: 'build',
    agent: 'build',
    providerID: 'test',
    modelID: 'test',
    time: { created, completed: created + 1 },
    finish: 'stop',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function history(turns: number): MessageEntry[] {
  return Array.from({ length: turns }, (_, i) => {
    const userId = i === turns - 1 ? 'prompt' : `user-${i}`;
    const assistantId = i === turns - 1 ? 'answer' : `assistant-${i}`;
    return [
      {
        info: {
          id: userId,
          sessionID: sessionId,
          role: 'user',
          agent: 'build',
          model: { providerID: 'test', modelID: 'test' },
          time: { created: created + i * 10 },
        },
        parts: [
          {
            id: `text-${userId}`,
            messageID: userId,
            sessionID: sessionId,
            type: 'text',
            text: 'Update the cache lifetime table.',
          },
        ],
      },
      {
        info: assistant(assistantId, userId),
        parts: [
          {
            id: `text-${assistantId}`,
            messageID: assistantId,
            sessionID: sessionId,
            type: 'text',
            text: `Completed task ${i}.\n\n${'Verified the focused behavior and kept unrelated code unchanged. '.repeat(8)}`,
          },
        ],
      },
    ] satisfies MessageEntry[];
  }).flat();
}

type OpeningFrame = {
  visible: boolean;
  summary: boolean;
  bottomGap: number;
  answerTop: number | null;
};

for (const width of [480, 1280]) {
  for (const turns of [3, 31]) {
    for (const delayMs of [0, 400]) {
      test(`completed chat reveals its change summary in the first frame at ${width}px with ${turns} turns, delay=${delayMs}ms`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height: 850 });
        await page.addInitScript(
          (capture) => {
            // SAFETY: Only the isolated playback harness consumes this generated fixture.
            (
              window as typeof window & { varroPlaybackCapture: typeof capture }
            ).varroPlaybackCapture = capture;
            const frames: OpeningFrame[] = [];
            const sample = () => {
              const list = document.querySelector<HTMLElement>('.interactive-list');
              if (list?.querySelector('[data-msg-id]')) {
                const answer = list.querySelector('[data-msg-id="answer"]');
                frames.push({
                  visible: getComputedStyle(list).visibility !== 'hidden',
                  summary: !!list.querySelector('[data-msg-id="answer"] .diff-summary'),
                  bottomGap: list.scrollHeight - list.scrollTop - list.clientHeight,
                  answerTop: answer?.getBoundingClientRect().top ?? null,
                });
              }
              if (document.documentElement.dataset.stopOpeningFrames === 'true') {
                document.documentElement.dataset.openingFrames = JSON.stringify(frames);
              } else requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          },
          {
            session: {
              id: sessionId,
              projectID: 'test',
              directory: '/workspace',
              title: 'Opening diff fixture',
              version: '1',
              time: { created, updated: created },
            },
            initialMessages: history(turns),
            messageDiffs: {
              delayMs,
              files: [
                { file: 'src/shared/prompt-cache-lifetime.ts', additions: 180, deletions: 9 },
                { file: 'docs/usage.md', additions: 21, deletions: 3 },
                { file: 'src/shared/prompt-cache-lifetime.test.ts', additions: 12, deletions: 2 },
              ],
            },
          }
        );
        await page.goto('/e2e/harness/index.html?scenario=session-playback');
        const list = page.locator('.interactive-list');
        await expect(page.locator('[data-msg-id="answer"] .diff-summary')).toContainText(
          '3 files changed'
        );
        await expect(list).not.toHaveClass(/is-session-hydrating/);
        await page.waitForTimeout(300);
        await page.evaluate(() => {
          document.documentElement.dataset.stopOpeningFrames = 'true';
        });
        await expect(page.locator('html')).toHaveAttribute('data-opening-frames', /./);
        const frames: OpeningFrame[] = JSON.parse(
          (await page.locator('html').getAttribute('data-opening-frames'))!
        );
        await writeFile(
          testInfo.outputPath('opening-diff-summary-frames.json'),
          JSON.stringify(frames, null, 2)
        );
        const visible = frames.filter((frame) => frame.visible);
        expect(visible.length).toBeGreaterThan(5);
        // The summary is part of the first revealed layout, so the tail never moves after reveal.
        expect(visible.every((frame) => frame.summary)).toBe(true);
        expect(Math.max(...visible.map((frame) => frame.bottomGap))).toBeLessThanOrEqual(1);
        const tops = visible.map((frame) => frame.answerTop!);
        expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
        if (delayMs) expect(frames.some((frame) => !frame.visible && !frame.summary)).toBe(true);
      });
    }
  }
}
