import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry } from '../../src/webview/types';
import { getScrollMetrics, waitForAnimationFrames } from './helpers';

// Headless Chromium hides native scrollbars by default, making thumb drags inert.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

for (const phase of ['exiting', 'exiting-bottom-event', 'retained', 'held-pointer'] as const) {
  test(`scrollbar dragging releases the ${phase} activity-collapse anchor`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 504, height: 800 });
    await page.goto(
      '/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayPrefix=1&activeTrayCompletedPrefix=1&activeTrayCount=2'
    );
    const list = page.locator('.interactive-list');
    const items = page.locator('.assistant-active-activity-item');
    await expect(items).toHaveCount(2);
    await page.waitForTimeout(2_100);
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThanOrEqual(1);
    const pauseExit = phase.startsWith('exiting')
      ? await page.addStyleTag({
          content:
            '.assistant-active-activity-item.is-exiting { animation-play-state: paused !important; }',
        })
      : null;
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
        if (part.type !== 'tool' || part.state.status !== 'running') continue;
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
    });
    if (phase.startsWith('exiting')) {
      await expect(page.locator('.assistant-active-activity-item.is-exiting')).toHaveCount(2);
    } else {
      await expect(items).toHaveCount(0);
      await expect(page.locator('.append-scroll-bottom-reserve')).toBeVisible();
      await waitForAnimationFrames(page, 40);
    }

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
    if (phase === 'exiting-bottom-event') {
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
    await pauseExit?.evaluate((element) => element.parentNode?.removeChild(element));

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

// Issue #35: a tray exit arms a bottom anchor, and appended content below it stays unfollowed until
// the user grabs the scrollbar. While the thumb is held, later tool exits and completions must not
// re-arm that anchor at the grab position: each armed frame pulls the viewport back against the drag,
// and release snaps it back to where the drag started.
for (const completion of ['one tool exits', 'remaining tools complete'] as const) {
  test(`held scrollbar drag keeps its position when ${completion}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 504, height: 800 });
    await page.goto(
      '/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayPrefix=1&activeTrayCompletedPrefix=1&activeTrayCount=4'
    );
    const list = page.locator('.interactive-list');
    await expect(page.locator('.assistant-active-activity-item')).toHaveCount(2);
    await page.waitForTimeout(2_100);
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThanOrEqual(1);

    // Hold every exit mid-animation so the collapse owner stays armed deterministically.
    await page.addStyleTag({
      content:
        '.assistant-active-activity-item.is-exiting { animation-play-state: paused !important; }',
    });
    await completeRunningTools(page, ['tool-active-0']);
    await expect(page.locator('.assistant-active-activity-item.is-exiting')).toHaveCount(1);
    await appendAssistantText(page, 'scrollbar-hidden-growth', 40);
    await expect(list).toContainText('Hidden growth paragraph 39.');
    await waitForAnimationFrames(page, 10);
    // Precondition: the armed owner leaves new content below the viewport.
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
      completion === 'one tool exits'
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
    const held = await takeScrollSamples(page);
    // The thumb's destination; a reversed frame may have been sampled last.
    const dragTop = Math.max(...held);
    await page.mouse.up();

    await startScrollSampling(page);
    await appendAssistantText(page, 'scrollbar-post-release', 6);
    await waitForAnimationFrames(page, 60);
    const released = await takeScrollSamples(page);
    await stopToolChurn(page);

    await testInfo.attach('scrollbar-drag-frames', {
      body: JSON.stringify({ thumb, dragTop, held, released }),
      contentType: 'application/json',
    });
    // The drag moved the transcript downward, and no frame reversed that user-owned movement.
    expect(dragTop).toBeGreaterThan(thumb.top + 150);
    expect.soft(largestReversal(held)).toBeLessThanOrEqual(2);
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
      remainingTravel: travel - thumbTop,
    };
  });
}

async function startScrollSampling(page: Page) {
  await page.evaluate(() => {
    // SAFETY: This test owns the optional sample buffer slot on the fixture window.
    const sampler = window as typeof window & { varroScrollSamples?: number[] };
    const list = document.querySelector('.interactive-list');
    if (!list) throw new Error('Missing message list');
    const samples: number[] = [];
    sampler.varroScrollSamples = samples;
    const sample = () => {
      if (sampler.varroScrollSamples !== samples) return;
      samples.push(list.scrollTop);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function takeScrollSamples(page: Page) {
  return page.evaluate(() => {
    // SAFETY: startScrollSampling owns this optional sample buffer slot on the fixture window.
    const sampler = window as typeof window & { varroScrollSamples?: number[] };
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
