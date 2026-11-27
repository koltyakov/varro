import { expect, test, type Page } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import { getListDistanceFromBottom, waitForAnimationFrames } from './helpers';

function replayRunningCommand(page: Page, output?: string) {
  return page.evaluate((runningOutput) => {
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
          id: 'waiting-command',
          callID: 'waiting-command',
          sessionID: 'session-large-transcript',
          messageID: 'message-large-assistant-239',
          type: 'tool',
          tool: 'bash',
          state: {
            status: 'running',
            input: { command: 'sleep 30 && echo done' },
            title: 'sleep 30 && echo done',
            metadata: runningOutput === undefined ? {} : { output: runningOutput },
            time: { start: Date.now() },
          },
        },
      },
    });
  }, output);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 486, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
});

test('expands a running command in the active tray before output arrives', async ({ page }) => {
  await replayRunningCommand(page);
  const item = page.locator('[data-activity-part-id="waiting-command"]');
  await expect(item).toBeVisible();
  await item.locator('.tool-invocation-header').click();

  const waiting = item.locator('.terminal-command-output-waiting');
  await expect(waiting).toHaveText('Waiting for output…');
  await expect(waiting).toBeVisible();
  const box = await waiting.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(8);

  await replayRunningCommand(page, 'first line');
  await expect(waiting).toHaveCount(0);
  await expect(item.locator('.terminal-command-output-viewport')).toContainText('first line');
});

test('expanding a running command at the followed bottom reveals its details', async ({ page }) => {
  await replayRunningCommand(page, ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n'));
  const item = page.locator('[data-activity-part-id="waiting-command"]');
  await expect(item).toBeVisible();
  await expect.poll(() => getListDistanceFromBottom(page)).toBeLessThanOrEqual(1);

  await item.locator('.tool-invocation-header').click();
  const output = item.locator('.terminal-command-output-viewport');
  await expect(output).toBeVisible();
  await expect.poll(() => getListDistanceFromBottom(page)).toBeLessThanOrEqual(1);
  const outputBottom = (await output.boundingBox())!;
  const listBox = (await page.locator('.interactive-list').boundingBox())!;
  expect(outputBottom.y + outputBottom.height).toBeLessThanOrEqual(listBox.y + listBox.height);

  // Later output keeps following while the details stay open.
  await replayRunningCommand(
    page,
    Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')
  );
  await expect(output).toContainText('line 12');
  await expect.poll(() => getListDistanceFromBottom(page)).toBeLessThanOrEqual(1);
});

test('collapsing a running command at the bottom keeps its header in place', async ({ page }) => {
  await replayRunningCommand(page, ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n'));
  const item = page.locator('[data-activity-part-id="waiting-command"]');
  const header = item.locator('.tool-invocation-header');
  await expect(item).toBeVisible();
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(item.locator('.terminal-command-output-viewport')).toBeVisible();
  await expect.poll(() => getListDistanceFromBottom(page)).toBeLessThanOrEqual(1);
  await waitForAnimationFrames(page, 30);

  const samples = await header.evaluateHandle((element) => {
    const list = document.querySelector('.interactive-list')!;
    const state = {
      running: true,
      tops: [element.getBoundingClientRect().top],
      scrollTops: [list.scrollTop],
    };
    const sample = () => {
      state.tops.push(element.getBoundingClientRect().top);
      state.scrollTops.push(list.scrollTop);
      if (state.running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    return state;
  });
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await waitForAnimationFrames(page, 60);
  const result = await samples.evaluate((state) => {
    state.running = false;
    return { tops: state.tops, scrollTops: state.scrollTops };
  });
  expect(
    result.tops.every((top) => Math.abs(top - result.tops[0]!) <= 1),
    JSON.stringify(result)
  ).toBe(true);
});
