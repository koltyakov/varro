import { expect, test } from '@playwright/test';
import type { SessionMessageInfo } from '@opencode/client';
import {
  isV2TranscriptMessage,
  projectV2Message,
} from '../../src/extension/opencode-v2-projection';

for (const width of [441, 1100]) {
  test(`retains Interrupted after a background notice and history reload at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    const sessionID = 'session-background-interruption';
    const created = Date.now() - 10_000;
    const records: SessionMessageInfo[] = [
      { id: 'prompt', type: 'user', text: 'Run tests', time: { created } },
      {
        id: 'answer',
        type: 'assistant',
        agent: 'build',
        model: { providerID: 'openai', id: 'model', variant: 'high' },
        content: [{ type: 'text', text: 'Tests are running in the background.' }],
        finish: 'stop',
        time: { created: created + 1_000, completed: created + 2_000 },
      },
      {
        id: 'succeeded',
        type: 'idle',
        outcome: 'succeeded',
        time: { created: created + 2_001 },
      },
      {
        id: 'background-notice',
        type: 'synthetic',
        text: '<shell id="sh_test" state="error" command="npm test">\nShell.NotFoundError\n</shell>',
        time: { created: created + 9_000 },
      },
      {
        id: 'interrupted',
        type: 'idle',
        outcome: 'interrupted',
        time: { created: created + 9_001 },
      },
    ];
    const initialMessages = records.filter(isV2TranscriptMessage).map((message) =>
      projectV2Message(message, sessionID, '/workspace', 'prompt', {
        agent: 'build',
        model: { providerID: 'openai', id: 'model', variant: 'high' },
      })
    );
    await page.addInitScript(
      (fixture) => {
        // SAFETY: The isolated playback harness reads this fixture before mounting.
        (window as typeof window & { varroPlaybackCapture: typeof fixture }).varroPlaybackCapture =
          fixture;
      },
      {
        session: {
          id: sessionID,
          projectID: 'test',
          directory: '/workspace',
          title: 'Stopped background action',
          version: '2',
          time: { created, updated: created + 9_001 },
        },
        initialMessages,
      }
    );
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    for (let reload = 0; reload < 2; reload++) {
      const summary = page.locator('.assistant-dialog-summary');
      await expect(summary).toHaveCount(1);
      await expect(summary).toContainText('Interrupted');
      await expect(summary).toBeVisible();
      await expect(page.locator('.user-message-card')).toHaveCount(1);
      await expect(page.locator('.background-process')).toHaveCount(0);
      await expect(page.locator('.loading-indicator')).toHaveCount(0);
      await expect(
        page.locator('.model-change-indicator:not(.assistant-dialog-summary)')
      ).toHaveCount(0);
      await expect(page.getByLabel('Stop', { exact: true })).toHaveCount(0);
      const activity = page.locator('.assistant-activity-summary');
      await activity.click();
      const notice = page.locator('[data-msg-id="background-notice"] .tool-invocation-header');
      await expect(notice).toContainText('Background command finished: npm test');
      const noticeBox = await notice.boundingBox();
      const summaryBox = await summary.boundingBox();
      expect(summaryBox!.y).toBeGreaterThanOrEqual(noticeBox!.y + noticeBox!.height);
      if (reload === 0) await page.reload();
    }
    await page.screenshot({ path: testInfo.outputPath('background-interrupted.png') });
  });
}
