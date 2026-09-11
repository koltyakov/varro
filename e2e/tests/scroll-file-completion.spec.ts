import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { ToolPart } from '../../src/webview/types';
import { getScrollMetrics, waitForAnimationFrames } from './helpers';

test('keeps painted content fixed when an inline file edit drops its running status card', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 486, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  const messageID = 'message-rapid-assistant-streaming';
  const sessionID = 'session-rapid-streaming-jitter';
  const row = page.locator(`[data-msg-id="${messageID}"]`);
  await expect(row.locator('.rendered-markdown')).toHaveText('Starting...');
  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'config/update',
        payload: {
          desktopSessionPaneSide: 'left',
          defaultPermissionMode: 'default',
          chatFontSize: 13,
          chatEditorFontSize: 12,
          chatFontFamily: 'default',
          showFileDiffs: true,
        },
      },
      '*'
    );
  });
  const content =
    Array.from({ length: 82 }, (_, index) => `export const value${index} = ${index};`).join('\n') +
    '\n';
  const part: ToolPart = {
    id: 'file-completion',
    sessionID,
    messageID,
    type: 'tool',
    tool: 'apply_patch',
    callID: 'file-completion-call',
    state: {
      status: 'running',
      input: {
        patchText: `*** Begin Patch\n*** Add File: result.ts\n${content
          .trimEnd()
          .split('\n')
          .map((line) => `+${line}`)
          .join('\n')}\n*** End Patch`,
      },
      title: 'Add result.ts',
      metadata: {
        files: [
          {
            filePath: '/workspace/result.ts',
            relativePath: 'result.ts',
            type: 'add',
            before: '',
            after: content,
            additions: 82,
            deletions: 0,
          },
        ],
      },
      time: { start: Date.now() },
    },
  };
  await page.evaluate((activity) => {
    window.postMessage(
      {
        type: 'server/event',
        payload: { type: 'message.part.updated', properties: { part: activity } },
      },
      '*'
    );
  }, part);
  await expect(row.locator('.file-change-card')).toBeVisible();
  await expect(row.locator('.file-change-inline-diffs')).toBeVisible();
  await expect
    .poll(() =>
      getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
    )
    .toBeLessThan(2);
  await waitForAnimationFrames(page, 12);

  const samples = await row.evaluate(async (element, activity) => {
    // SAFETY: This page owns the deterministic mock transport and message row.
    const harness = (
      window as typeof window & { __varroE2E: { replayServerEvent: (event: ServerEvent) => void } }
    ).__varroE2E;
    const list = element.closest<HTMLElement>('.interactive-list')!;
    const marker = element.querySelector<HTMLElement>('.rendered-markdown p')!;
    const result: Array<{
      source: string;
      top: number;
      scrollTop: number;
      height: number;
      connected: boolean;
    }> = [];
    const record = (source: string) =>
      result.push({
        source,
        top: marker.getBoundingClientRect().top,
        scrollTop: list.scrollTop,
        height: list.scrollHeight,
        connected: marker.isConnected,
      });
    record('before');
    const observer = new MutationObserver(() => record('mutation'));
    observer.observe(element, { childList: true, subtree: true });
    const completed: ToolPart = {
      ...activity,
      state: {
        status: 'completed',
        input: activity.state.input,
        title: 'Added result.ts',
        output: 'File added',
        metadata: 'metadata' in activity.state ? (activity.state.metadata ?? {}) : {},
        time: { start: Date.now() - 1000, end: Date.now() },
      },
    };
    harness.replayServerEvent({ type: 'message.part.updated', properties: { part: completed } });
    for (let index = 0; index < 90; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      record('frame');
    }
    observer.disconnect();
    return result;
  }, part);
  await testInfo.attach('file-completion-frames.json', {
    body: JSON.stringify(samples, null, 2),
    contentType: 'application/json',
  });
  await expect(row.locator('.file-change-card')).toHaveCount(0);
  await expect(row.locator('.file-change-inline-diffs')).toBeVisible();
  expect(samples.every((sample) => sample.connected)).toBe(true);
  expect(
    samples.filter((sample) => sample.top > samples[0]!.top + 1.5),
    JSON.stringify(samples)
  ).toEqual([]);
});
