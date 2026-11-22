import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry } from '../../src/webview/types';
import { getScrollMetrics, waitForAnimationFrames } from './helpers';

// Headless Chromium hides native scrollbars by default, making thumb drags inert.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

type HarnessWindow = typeof window & {
  __varroE2E: {
    replayServerEvent(event: ServerEvent): void;
    getSessionMessages(sessionId: string): MessageEntry[];
  };
};

type FrameSample = {
  frame: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  reserve: number;
  paintedRows: number;
  lastRowId: string | null;
  lastRowBottom: number | null;
};

const SESSION_ID = 'session-diff-preview-large-transcript';
const APPENDED_ID = 'message-held-range-next-step';

// Reduced from the November 22 local retained replay (`20261122-f9c2`, DIF-06): a follow target
// recorded before a detached native thumb drag survived a large cold-measurement range shrink.
// The next assistant step then reserved the obsolete difference below every row and followed
// the reserve, blanking the transcript for the rest of the stream.
test('a new step after held-thumb drags through a shrunken cold range keeps rows painted', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 486, height: 794 });
  await page.goto(
    '/e2e/harness/index.html?scenario=diff-preview-large-transcript&diffPreviewTurns=110&diffPreviewCompleted=1'
  );
  const list = page.locator('.interactive-list');
  await expect(list).toBeVisible();
  await expect
    .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
    .toBeLessThanOrEqual(1);
  await waitForAnimationFrames(page, 12);
  const followed = await getScrollMetrics(page, '.interactive-list');
  const bounds = await list.boundingBox();
  if (!bounds) throw new Error('Missing transcript viewport');

  // Native drag to the top measures the cold head; its rows are shorter than their estimates.
  await dragThumb(page, list, bounds.y - 40);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0);
  await waitForAnimationFrames(page, 20);
  const shrunk = await getScrollMetrics(page, '.interactive-list');
  // Precondition: the range shrank by more than a viewport, so the old follow target is unreachable.
  expect(followed.scrollHeight - shrunk.scrollHeight).toBeGreaterThan(followed.clientHeight);

  // Native drag back to the latest row reattaches bottom-follow without a programmatic write.
  await dragThumb(page, list, bounds.y + bounds.height + 40);
  await expect
    .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
    .toBeLessThanOrEqual(1);
  await waitForAnimationFrames(page, 20);
  const released = await sampleFrame(list, 0);
  expect(released.paintedRows).toBeGreaterThan(0);

  // The next assistant step starts with no parts, exactly like `session.next.step.started`.
  const samples = await list.evaluate(
    async (element, args) => {
      // SAFETY: The isolated E2E harness installs the production-event replay helper.
      const harness = (window as HarnessWindow).__varroE2E;
      const messages = harness.getSessionMessages(args.sessionId);
      const previous = messages.findLast((entry) => entry.info.role === 'assistant');
      if (!previous || previous.info.role !== 'assistant') throw new Error('Missing assistant');
      const { finish: _finish, ...info } = previous.info;
      harness.replayServerEvent({
        type: 'message.updated',
        properties: {
          info: { ...info, id: args.appendedId, time: { created: previous.info.time.created + 1 } },
        },
      });
      const frames = [];
      for (let frame = 1; frame <= 40; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const view = element.getBoundingClientRect();
        const rows = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')];
        const last = rows.at(-1);
        frames.push({
          frame,
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          reserve:
            element.querySelector('.append-scroll-bottom-reserve')?.getBoundingClientRect()
              .height ?? 0,
          paintedRows: rows.filter((row) => {
            const rect = row.getBoundingClientRect();
            return rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom;
          }).length,
          lastRowId: last?.dataset.msgId ?? null,
          lastRowBottom: last ? last.getBoundingClientRect().bottom - view.top : null,
        });
      }
      return frames;
    },
    { sessionId: SESSION_ID, appendedId: APPENDED_ID }
  );
  const evidence = JSON.stringify({ followed, shrunk, released, samples }, null, 2);
  await writeFile(testInfo.outputPath('held-range-append.json'), evidence);
  await testInfo.attach('held-range-append', { body: evidence, contentType: 'application/json' });

  const blank = samples.filter((sample) => sample.paintedRows === 0);
  expect(blank, JSON.stringify(blank.slice(0, 3))).toEqual([]);
  // The new step adds no content yet; it must not reserve the pre-drag follow distance.
  for (const sample of samples) {
    expect(sample.scrollHeight, JSON.stringify(sample)).toBeLessThanOrEqual(
      released.scrollHeight + sample.clientHeight
    );
  }
});

async function dragThumb(page: Page, list: Locator, targetY: number) {
  const thumb = await list.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const height = element.clientHeight;
    const range = element.scrollHeight - height;
    const thumbHeight = Math.max(18, (height * height) / element.scrollHeight);
    const thumbTop = (element.scrollTop / range) * (height - thumbHeight);
    return { x: rect.right - 3, y: rect.top + thumbTop + thumbHeight / 2 };
  });
  await page.mouse.move(thumb.x, thumb.y);
  await page.mouse.down();
  await expect(list).toHaveAttribute('data-pointer-scroll-owned', '');
  try {
    await page.mouse.move(thumb.x, targetY, { steps: 16 });
    await waitForAnimationFrames(page, 20);
  } finally {
    await page.mouse.up();
  }
  await expect(list).not.toHaveAttribute('data-pointer-scroll-owned', '');
}

async function sampleFrame(list: Locator, frame: number): Promise<FrameSample> {
  return list.evaluate((element, frameIndex) => {
    const view = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')];
    const last = rows.at(-1);
    return {
      frame: frameIndex,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      reserve:
        element.querySelector('.append-scroll-bottom-reserve')?.getBoundingClientRect().height ?? 0,
      paintedRows: rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom;
      }).length,
      lastRowId: last?.dataset.msgId ?? null,
      lastRowBottom: last ? last.getBoundingClientRect().bottom - view.top : null,
    };
  }, frame);
}
