import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry } from '../../src/webview/types';
import {
  getScrollMetrics,
  getVisibleMessageAnchor,
  sampleMessageTopAcrossFrames,
  waitForAnimationFrames,
} from './helpers';
import { appendDeltaToRapidStreaming } from './scroll-helpers';

type ScrollSample = { top: number; height: number };

test('cold virtual measurements yield scroll writes to the held native thumb', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 486, height: 794 });
  await page.goto(
    '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1&diffPreviewTurns=110&diffPreviewCompleted=1'
  );
  const list = page.locator('.interactive-list');
  await expect(list).toBeVisible();
  await expect
    .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
    .toBeLessThanOrEqual(1);
  await waitForAnimationFrames(page, 12);
  const initialIds = await list
    .locator('[data-msg-id]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-msg-id')));
  const writes: Array<{ top: number; held: boolean }> = [];
  await page.exposeFunction('recordThumbScrollWrite', (top: number, held: boolean) =>
    writes.push({ top, held })
  );
  await list.evaluate((element) => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get() {
        return descriptor.get!.call(this);
      },
      set(value: number) {
        // SAFETY: exposeFunction installed this test-owned binding before this setter.
        const host = window as typeof window & {
          recordThumbScrollWrite: (top: number, held: boolean) => Promise<void>;
        };
        void host.recordThumbScrollWrite(value, element.hasAttribute('data-pointer-scroll-owned'));
        descriptor.set!.call(this, value);
      },
    });
  });
  const thumb = await getThumb(list);
  await page.mouse.move(thumb.x, thumb.y);
  await page.mouse.down();
  await expect(list).toHaveAttribute('data-pointer-scroll-owned', '');
  try {
    await page.waitForTimeout(400);
    await page.mouse.move(thumb.x, thumb.y - 160, { steps: 16 });
    await page.waitForTimeout(1_050);
    const destination = await getScrollMetrics(page, '.interactive-list');
    expect(destination.scrollTop).toBeLessThan(thumb.top - 1_000);
    const currentIds = await list
      .locator('[data-msg-id]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-msg-id')));
    expect(currentIds.some((id) => !initialIds.includes(id))).toBe(true);
    const anchor = await getVisibleMessageAnchor(list);
    const heldSamples = await sampleMessageTopAcrossFrames(list, anchor.id, 12);
    expect(heldSamples.every((top) => top !== null && Math.abs(top - anchor.top) <= 1)).toBe(true);
    await testInfo.attach('native-thumb-writes', {
      body: JSON.stringify({ initialIds, currentIds, writes, anchor, heldSamples }),
      contentType: 'application/json',
    });
    expect(writes.filter((write) => write.held)).toEqual([]);
  } finally {
    await page.mouse.up();
  }
  const released = await getVisibleMessageAnchor(list);
  const releasedSamples = await sampleMessageTopAcrossFrames(list, released.id, 12);
  expect(releasedSamples.every((top) => top !== null && Math.abs(top - released.top) <= 1)).toBe(
    true
  );
});

test('reveals new streamed parts once without replaying entrances when reopening busy sessions', async ({
  page,
}) => {
  const starts: string[] = [];
  await page.exposeFunction('recordStreamedEntrance', (key: string) => starts.push(key));
  await page.addInitScript(() => {
    document.addEventListener(
      'animationstart',
      (event) => {
        if (
          event.animationName !== 'streamed-assistant-item-in' ||
          !(event.target instanceof Element)
        )
          return;
        const key = event.target.closest<HTMLElement>('[data-assistant-render-key]')?.dataset
          .assistantRenderKey;
        if (!key) return;
        // SAFETY: Playwright installed this callback before navigation.
        void (window as Window & { recordStreamedEntrance?(key: string): Promise<void> })
          .recordStreamedEntrance!(key);
      },
      true
    );
  });
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter&secondBusySession=1');
  const list = page.locator('.interactive-list');
  const first = [
    'session-rapid-streaming-jitter',
    'message-rapid-assistant-streaming',
    'message-rapid-assistant-streaming-text-1',
  ] as const;
  const second = ['session-rapid-second', 'second-assistant', 'second-assistant-part-1'] as const;
  for (const [index, session] of [first, second, first].entries()) {
    const [sessionID, messageID, initialPartID] = session;
    if (index) {
      await page.getByLabel('Back to sessions').click();
      await expect(list).toHaveCount(0);
      await page.locator(`[data-session-id="${sessionID}"] .session-item-main`).click();
    }
    const row = list.locator(`[data-msg-id="${messageID}"]`);
    await expect(row).toContainText('Starting...');
    await waitForAnimationFrames(page, 4);
    const partID = `new-part-${index}`;
    await page.evaluate(
      (part) => {
        // SAFETY: The isolated E2E harness installs the production-event replay helper.
        const harness = (
          window as Window & {
            __varroE2E?: { replayServerEvent(event: ServerEvent): void };
          }
        ).__varroE2E!;
        harness.replayServerEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              id: part.partID,
              sessionID: part.sessionID,
              messageID: part.messageID,
              type: 'text',
              text: `Fresh content: ${part.partID}`,
            },
          },
        });
      },
      { sessionID, messageID, partID }
    );
    await expect(row).toContainText(partID);
    await expect.poll(() => starts.filter((key) => key === `part:${partID}`).length).toBe(1);
    expect(starts).not.toContain(`part:${initialPartID}`);
  }
  expect(starts.filter((key) => key === 'part:new-part-0')).toHaveLength(1);
});

// Headless Chromium hides native scrollbars by default, making thumb drags inert.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

for (const destination of ['top', 'bottom'] as const) {
  test(`releasing a thumb at the ${destination} drops obsolete range reserve before the next drag`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 504, height: 800 });
    await page.goto(
      '/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayPrefix=1&activeTrayCompletedPrefix=1&activeTrayCount=4'
    );
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();
    await appendAssistantText(page, 'range-correction', 100);
    await expect(list).toContainText('Hidden growth paragraph 99.');
    await waitForAnimationFrames(page, 40);
    const viewport = await list.boundingBox();
    if (!viewport) throw new Error('Missing transcript viewport');
    await page.mouse.move(viewport.x + 100, viewport.y + 100);
    await page.mouse.wheel(0, -100_000);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0);
    await page.mouse.wheel(0, 500);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
    await waitForAnimationFrames(page, 10);
    const thumb = await getThumb(list);
    const bounds = await list.boundingBox();
    if (!bounds) throw new Error('Missing transcript viewport');
    await page.mouse.move(thumb.x, thumb.y);
    await page.mouse.down();
    await expect(list).toHaveAttribute('data-pointer-scroll-owned', '');
    // Stand in for a measured virtual-prefix correction: shorten existing flow while the thumb
    // owns the old physical range. This is an isolated fixture, not a source-session mutation.
    await list.getByText('Hidden growth paragraph 99.', { exact: true }).evaluate((element) => {
      const block = element.closest<HTMLElement>('[data-assistant-render-key]');
      if (!block) throw new Error('Missing measured text block');
      block.style.height = '20px';
      block.style.overflow = 'hidden';
    });
    await expect(list.locator('.append-scroll-bottom-reserve')).toBeVisible();
    await page.mouse.move(
      thumb.x,
      destination === 'top' ? bounds.y - 40 : bounds.y + bounds.height + 40,
      { steps: 12 }
    );
    if (destination === 'top')
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0);
    // Exhaust deferred resize/reconciliation work while the old range is still pointer-owned.
    // Releasing immediately can accidentally pass because a queued frame cleans up afterward.
    await waitForAnimationFrames(page, 60);
    if (destination === 'top')
      await expect(list.locator('.append-scroll-bottom-reserve')).toBeVisible();
    else {
      const paintedFrames = await list.evaluate(async (element) => {
        const frames = [];
        for (let frame = 0; frame < 60; frame++) {
          const view = element.getBoundingClientRect();
          frames.push(
            [...element.querySelectorAll('[data-msg-id]')].some((row) => {
              const rect = row.getBoundingClientRect();
              return rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom;
            })
          );
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        return frames;
      });
      expect(paintedFrames.every(Boolean)).toBe(true);
    }
    await page.mouse.up();
    if (destination === 'top')
      await expect(list.locator('.append-scroll-bottom-reserve')).toHaveCount(0);
    else
      expect(
        await list.evaluate(
          (element) =>
            (element.querySelector('.append-scroll-bottom-reserve')?.getBoundingClientRect()
              .height ?? 0) < element.clientHeight
        )
      ).toBe(true);
    if (destination === 'top') expect(await list.evaluate((element) => element.scrollTop)).toBe(0);

    const nextThumb = await getThumb(list);
    await page.mouse.move(nextThumb.x, nextThumb.y);
    await page.mouse.down();
    await page.mouse.move(nextThumb.x, bounds.y + bounds.height + 40, { steps: 12 });
    await waitForAnimationFrames(page, 3);
    await page.mouse.up();
    await expect
      .poll(() =>
        list.evaluate((element) => {
          const view = element.getBoundingClientRect();
          return [...element.querySelectorAll('[data-msg-id]')].some((row) => {
            const rect = row.getBoundingClientRect();
            return rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom;
          });
        })
      )
      .toBe(true);
  });
}

test('streaming yields to a held scrollbar, stays at the top, and follows a drag back to bottom', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  const list = page.locator('.interactive-list');
  await expect(list).toBeVisible();
  await expect
    .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
    .toBeLessThanOrEqual(1);
  const thumb = await getThumb(list);
  const bounds = await list.boundingBox();
  if (!bounds) throw new Error('Missing transcript viewport');
  await page.mouse.move(thumb.x, thumb.y);
  await page.mouse.down();
  const heldAnchor = await getVisibleMessageAnchor(list);
  await appendDeltaToRapidStreaming(
    page,
    `\n\nHeld-thumb output: ${'Streaming text. '.repeat(80)}`
  );
  // Keep holding beyond the input-intent timeout while paced output grows below the viewport.
  const heldSamples = await sampleMessageTopAcrossFrames(list, heldAnchor.id, 45);
  expect(
    heldSamples.every((top) => top !== null && Math.abs(top - heldAnchor.top) <= 1),
    JSON.stringify({ heldAnchor, heldSamples })
  ).toBe(true);

  await page.mouse.move(thumb.x, bounds.y + 2, { steps: 12 });
  await expect
    .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.scrollTop))
    .toBe(0);
  await page.mouse.up();
  const topAnchor = await getVisibleMessageAnchor(list);
  for (let index = 0; index < 6; index += 1) {
    await appendDeltaToRapidStreaming(
      page,
      `\n\nDetached output ${index}: ${'More text. '.repeat(20)}`
    );
    const samples = await sampleMessageTopAcrossFrames(list, topAnchor.id, 4);
    expect(
      samples.every((top) => top !== null && Math.abs(top - topAnchor.top) <= 1),
      JSON.stringify({ topAnchor, samples })
    ).toBe(true);
    expect((await getScrollMetrics(page, '.interactive-list')).scrollTop).toBe(0);
  }

  // Let the paced detached output finish before measuring the thumb's new range.
  await waitForAnimationFrames(page, 30);
  const topThumb = await getThumb(list);
  await page.mouse.move(topThumb.x, topThumb.y);
  await page.mouse.down();
  await page.mouse.move(topThumb.x, bounds.y + bounds.height + 40, { steps: 12 });
  await expect
    .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
    .toBeLessThanOrEqual(1);
  await page.mouse.up();
  await appendDeltaToRapidStreaming(page, `\n\nResumed output: ${'Follow new text. '.repeat(30)}`);
  await expect(list).toContainText('Resumed output:');
  await expect
    .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
    .toBeLessThanOrEqual(1);
});

for (const phase of ['bottom-event', 'retained', 'held-pointer'] as const) {
  test(`scrollbar dragging releases the ${phase} activity-collapse anchor`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 504, height: 800 });
    await page.goto(
      '/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayReasoning=1&activeTrayPrefix=1&activeTrayCompletedPrefix=1&activeTrayCount=2'
    );
    const list = page.locator('.interactive-list');
    const items = page.locator('.assistant-active-activity-item');
    await expect(items).toHaveCount(1);
    await page.waitForTimeout(2_100);
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThanOrEqual(1);
    await page.evaluate(() => {
      // SAFETY: The isolated fixture installs this typed message store and event transport.
      const harness = (
        window as typeof window & {
          __varroE2E: {
            getSessionMessages(id: string): MessageEntry[];
            replayServerEvent(event: ServerEvent): void;
          };
        }
      ).__varroE2E;
      for (const part of harness.getSessionMessages('session-tool-cards').flatMap((m) => m.parts)) {
        if (part.type !== 'reasoning' || part.time.end !== undefined) continue;
        harness.replayServerEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              ...part,
              time: { ...part.time, end: Date.now() },
            },
          },
        });
      }
    });
    await expect(items).toHaveCount(0);
    await expect(page.locator('.append-scroll-bottom-reserve')).toBeVisible();
    await waitForAnimationFrames(page, 40);

    const thumb = await list.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const height = element.clientHeight;
      const thumbHeight = Math.max(18, (height * height) / element.scrollHeight);
      const travel = height - thumbHeight;
      return {
        x: rect.right - 3,
        y:
          rect.top +
          (element.scrollTop / (element.scrollHeight - height)) * travel +
          thumbHeight / 2,
        top: element.scrollTop,
      };
    });
    await page.mouse.move(thumb.x, thumb.y);
    await page.mouse.down();
    if (phase === 'bottom-event') {
      // Reproduce a layout-driven bottom event after the pointer releases the exit
      // anchor, before native dragging moves away. It must not reclaim ownership.
      await list.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event('scroll'));
      });
    }
    // Pointer ownership must survive the short keyboard/input-intent timeout.
    if (phase === 'held-pointer') await page.waitForTimeout(650);
    await page.mouse.move(thumb.x, thumb.y - 100, { steps: 12 });
    // Custom Chromium scrollbars deliver the final drag movement on the next frame.
    await waitForAnimationFrames(page, 2);
    await page.mouse.up();

    const samples = await list.evaluate(async (element) => {
      const summary = element.querySelector('.assistant-activity-summary');
      if (!summary) throw new Error('Missing retained activity summary');
      const frames = [];
      for (let frame = 0; frame < 60; frame++) {
        frames.push({ top: element.scrollTop, summaryTop: summary.getBoundingClientRect().top });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return frames;
    });
    await testInfo.attach('scrollbar-frames', {
      body: JSON.stringify({ thumb, samples }),
      contentType: 'application/json',
    });
    expect(samples[0]!.top).toBeLessThan(thumb.top - 100);
    expect(
      Math.max(...samples.map((sample) => Math.abs(sample.summaryTop - samples[0]!.summaryTop)))
    ).toBeLessThanOrEqual(1);
    await expect(items).toHaveCount(0);

    const appendText = (paragraphs: number) =>
      page.evaluate((count) => {
        // SAFETY: The isolated fixture owns this event transport; no recorded tools execute.
        const harness = (
          window as typeof window & {
            __varroE2E: { replayServerEvent(event: ServerEvent): void };
          }
        ).__varroE2E;
        harness.replayServerEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'scrollbar-continuation',
              sessionID: 'session-tool-cards',
              messageID: 'message-tool-cards-assistant',
              type: 'text',
              text: Array.from(
                { length: count },
                (_, index) => `Continuation paragraph ${index}.`
              ).join('\n\n'),
            },
          },
        });
      }, paragraphs);
    await appendText(20);
    await expect(list).toContainText('Continuation paragraph 19.');
    const summaryTop = await list
      .locator('.assistant-activity-summary')
      .first()
      .evaluate((element) => element.getBoundingClientRect().top);
    expect(Math.abs(summaryTop - samples[0]!.summaryTop)).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).click();
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThanOrEqual(1);
    await appendText(30);
    await expect(list).toContainText('Continuation paragraph 29.');
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThanOrEqual(1);
  });
}

// Issue #35: later activity completions must not arm a bottom anchor under a held scrollbar thumb.
// Tools now group directly, and following text releases the previous summary owner. Establish a
// genuinely detached reading position before growth, then keep completing tools during the drag.
for (const completion of ['one tool groups', 'remaining tools complete'] as const) {
  test(`held scrollbar drag keeps its position when ${completion}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 504, height: 800 });
    await page.goto(
      '/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayPrefix=1&activeTrayCompletedPrefix=1&activeTrayCount=4'
    );
    const list = page.locator('.interactive-list');
    await expect(page.locator('.assistant-active-activity-item')).toHaveCount(1);
    await page.waitForTimeout(2_100);
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThanOrEqual(1);

    await completeRunningTools(page, ['tool-active-0']);
    await expect(page.locator('[data-activity-part-id="tool-active-0"]')).toHaveCount(0);
    const bounds = await list.boundingBox();
    if (!bounds) throw new Error('Missing transcript viewport');
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
    await page.mouse.wheel(0, -500);
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeGreaterThan(400);
    await appendAssistantText(page, 'scrollbar-hidden-growth', 40);
    await expect(list).toContainText('Hidden growth paragraph 39.');
    await waitForAnimationFrames(page, 10);
    // Precondition: detached reading leaves new content below the viewport.
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      400
    );

    const thumb = await getThumb(list);
    // The agent keeps finishing tools while the user drags, as in the reported session.
    await startToolChurn(page);
    await startScrollSampling(page);
    await page.mouse.move(thumb.x, thumb.y);
    await page.mouse.down();
    // Let pointer ownership outlive the short input-intent window before activity changes.
    await page.waitForTimeout(300);
    await completeRunningTools(
      page,
      completion === 'one tool groups'
        ? ['tool-active-1']
        : ['tool-active-1', 'tool-active-2', 'tool-active-3']
    );
    await waitForAnimationFrames(page, 2);
    const dragPx = Math.max(24, Math.round(thumb.remainingTravel * 0.5));
    for (let step = 2; step <= dragPx; step += 2) {
      await page.mouse.move(thumb.x, thumb.y + step);
      await waitForAnimationFrames(page, 1);
    }
    await waitForAnimationFrames(page, 30);
    const heldFrames = await takeScrollSamples(page);
    const held = heldFrames.map((frame) => frame.top);
    // The thumb's destination; a reversed frame may have been sampled last.
    const dragTop = Math.max(...held);
    await page.mouse.up();

    await startScrollSampling(page);
    await appendAssistantText(page, 'scrollbar-post-release', 6);
    await waitForAnimationFrames(page, 60);
    const releasedFrames = await takeScrollSamples(page);
    const released = releasedFrames.map((frame) => frame.top);
    await stopToolChurn(page);

    await testInfo.attach('scrollbar-drag-frames', {
      body: JSON.stringify({ thumb, dragTop, held, released, heldFrames, releasedFrames }),
      contentType: 'application/json',
    });
    // The drag moved the transcript downward, and no frame reversed that user-owned movement.
    expect(dragTop).toBeGreaterThan(thumb.top + 150);
    expect.soft(largestReversal(held)).toBeLessThanOrEqual(2);
    // A detached collapse must reserve lost range before native thumb mapping can observe it.
    expect
      .soft(Math.min(...heldFrames.map((frame) => frame.height)))
      .toBeGreaterThanOrEqual(thumb.scrollHeight - 1);
    // Release must not return to the position where the drag started.
    expect(Math.min(...released)).toBeGreaterThanOrEqual(dragTop - 2);
  });
}

async function completeRunningTools(page: Page, partIds: string[]) {
  await page.evaluate((ids) => {
    // SAFETY: The isolated fixture installs this typed message store and event transport.
    const harness = (
      window as typeof window & {
        __varroE2E: {
          getSessionMessages(id: string): MessageEntry[];
          replayServerEvent(event: ServerEvent): void;
        };
      }
    ).__varroE2E;
    for (const part of harness.getSessionMessages('session-tool-cards').flatMap((m) => m.parts)) {
      if (part.type !== 'tool' || part.state.status !== 'running' || !ids.includes(part.id)) {
        continue;
      }
      harness.replayServerEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            ...part,
            state: {
              ...part.state,
              status: 'completed' as const,
              title: 'Read source',
              output: 'Done',
              metadata: {},
              time: { start: Date.now() - 3_000, end: Date.now() },
            },
          },
        },
      });
    }
  }, partIds);
}

async function startToolChurn(page: Page) {
  await page.evaluate(() => {
    // SAFETY: The isolated fixture owns this event transport; no recorded tools execute.
    const churn = window as typeof window & {
      __varroE2E: { replayServerEvent(event: ServerEvent): void };
      varroToolChurnTimer?: number;
    };
    const toolPart = (index: number, status: 'running' | 'completed') => ({
      id: `tool-churn-${index}`,
      sessionID: 'session-tool-cards',
      messageID: 'message-tool-cards-assistant',
      type: 'tool' as const,
      callID: `tool-churn-call-${index}`,
      tool: 'grep',
      state:
        status === 'running'
          ? {
              status,
              input: { pattern: `churn-${index}`, path: 'src/webview' },
              title: `Search churn ${index}`,
              time: { start: Date.now() },
            }
          : {
              status,
              input: { pattern: `churn-${index}`, path: 'src/webview' },
              output: 'Done',
              title: `Search churn ${index}`,
              metadata: {},
              time: { start: Date.now() - 250, end: Date.now() },
            },
    });
    let index = 0;
    churn.varroToolChurnTimer = window.setInterval(() => {
      if (index > 0) {
        // SAFETY: toolPart builds a completed tool part with every field the fixture transport reads.
        churn.__varroE2E.replayServerEvent({
          type: 'message.part.updated',
          properties: { part: toolPart(index - 1, 'completed') },
        } as ServerEvent);
      }
      // SAFETY: toolPart builds a running tool part with every field the fixture transport reads.
      churn.__varroE2E.replayServerEvent({
        type: 'message.part.updated',
        properties: { part: toolPart(index, 'running') },
      } as ServerEvent);
      index += 1;
    }, 250);
  });
}

async function stopToolChurn(page: Page) {
  await page.evaluate(() => {
    // SAFETY: startToolChurn stores its interval id on this optional window slot.
    const churn = window as typeof window & { varroToolChurnTimer?: number };
    window.clearInterval(churn.varroToolChurnTimer);
  });
}

async function appendAssistantText(page: Page, partId: string, paragraphs: number) {
  await page.evaluate(
    ({ id, count }) => {
      // SAFETY: The isolated fixture owns this event transport; no recorded tools execute.
      const harness = (
        window as typeof window & {
          __varroE2E: { replayServerEvent(event: ServerEvent): void };
        }
      ).__varroE2E;
      harness.replayServerEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id,
            sessionID: 'session-tool-cards',
            messageID: 'message-tool-cards-assistant',
            type: 'text',
            text: Array.from(
              { length: count },
              (_, index) => `Hidden growth paragraph ${index}.`
            ).join('\n\n'),
          },
        },
      });
    },
    { id: partId, count: paragraphs }
  );
}

async function getThumb(list: Locator) {
  return list.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const height = element.clientHeight;
    const range = element.scrollHeight - height;
    const thumbHeight = Math.max(18, (height * height) / element.scrollHeight);
    const travel = height - thumbHeight;
    const thumbTop = (element.scrollTop / range) * travel;
    return {
      x: rect.right - 3,
      y: rect.top + thumbTop + thumbHeight / 2,
      top: element.scrollTop,
      scrollHeight: element.scrollHeight,
      remainingTravel: travel - thumbTop,
    };
  });
}

async function startScrollSampling(page: Page) {
  await page.evaluate(() => {
    // SAFETY: This test owns the optional sample buffer slot on the fixture window.
    const sampler = window as typeof window & { varroScrollSamples?: ScrollSample[] };
    const list = document.querySelector('.interactive-list');
    if (!list) throw new Error('Missing message list');
    const samples: ScrollSample[] = [];
    sampler.varroScrollSamples = samples;
    const sample = () => {
      if (sampler.varroScrollSamples !== samples) return;
      samples.push({ top: list.scrollTop, height: list.scrollHeight });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function takeScrollSamples(page: Page) {
  return page.evaluate(() => {
    // SAFETY: startScrollSampling owns this optional sample buffer slot on the fixture window.
    const sampler = window as typeof window & { varroScrollSamples?: ScrollSample[] };
    const samples = sampler.varroScrollSamples ?? [];
    sampler.varroScrollSamples = undefined;
    return samples;
  });
}

function largestReversal(samples: number[]) {
  let highest = Number.NEGATIVE_INFINITY;
  let reversal = 0;
  for (const top of samples) {
    highest = Math.max(highest, top);
    reversal = Math.max(reversal, highest - top);
  }
  return reversal;
}
