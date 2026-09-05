/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: This regression test accesses only the controlled E2E harness and mounted DOM. */
import { expect, test } from '@playwright/test';
import type { MessageEntry, Part } from '../../src/webview/types';

// Regression contract for AI agents: preserve the busy turn, explicit live completion events,
// three simultaneously visible tools, real exit animation, and every-frame same-anchor check.
// Do not replace this with idle status, mock-server-only updates, one tool, a clipped eight-tool
// tray, a final-only assertion, or a larger tolerance. Those changes can hide lost sibling spacing.
const exitCases: Array<{
  name: string;
  count: number;
  gap: number;
  early: boolean;
  stagger: boolean;
  virtual?: boolean;
  detached?: boolean;
  detachDuring?: boolean;
  animation?: 'cancel' | 'fallback';
}> = [
  { name: 'three simultaneous', count: 3, gap: 9, early: false, stagger: false },
  { name: 'three amplified', count: 3, gap: 27, early: false, stagger: false },
  { name: 'virtual three', count: 3, gap: 9, early: false, stagger: false, virtual: true },
  { name: 'virtual eight', count: 8, gap: 9, early: false, stagger: false, virtual: true },
  { name: 'detached before exit', count: 3, gap: 9, early: false, stagger: false, detached: true },
  {
    name: 'cancelled exit animation',
    count: 3,
    gap: 9,
    early: false,
    stagger: false,
    animation: 'cancel',
  },
  {
    name: 'exit timer fallback',
    count: 3,
    gap: 9,
    early: false,
    stagger: false,
    animation: 'fallback',
  },
  { name: 'wheel during exit', count: 3, gap: 9, early: false, stagger: false, detachDuring: true },
  { name: 'one', count: 1, gap: 9, early: false, stagger: false },
  { name: 'two', count: 2, gap: 9, early: false, stagger: false },
  { name: 'eight clipped', count: 8, gap: 9, early: false, stagger: false },
  { name: 'three retained', count: 3, gap: 9, early: true, stagger: false },
  { name: 'middle then first then last', count: 3, gap: 9, early: false, stagger: true },
];
for (const scenario of exitCases) {
  const { gap, count, early, stagger } = scenario;
  test(`busy tool exits preserve the transcript: ${scenario.name}`, async ({ page }) => {
    await page.setViewportSize({ width: 504, height: 800 });
    const sessionId = scenario.virtual
      ? 'session-tool-cards-large-transcript'
      : 'session-tool-cards';
    const targetMessageId = scenario.virtual
      ? 'message-tool-cards-assistant-69'
      : 'message-tool-cards-assistant';
    await page.goto(
      scenario.virtual
        ? `/e2e/harness/index.html?scenario=tool-cards-large-transcript&activeTray=1&activeTrayIndex=69&activeTrayCount=${count}`
        : `/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayPrefix=1&activeTrayCount=${count}`
    );
    if (scenario.virtual) {
      await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
      expect(await page.locator('[data-msg-id]').count()).toBeLessThan(80);
    }
    if (gap !== 9) {
      // Artificial stress changes only fixture spacing, amplifying the same geometry loss.
      await page.addStyleTag({
        content: `.assistant-message-flow { --assistant-bordered-block-gap: ${gap}px; }`,
      });
    }
    const items = page.locator('.assistant-active-activity-item');
    await expect(items).toHaveCount(count);
    await items.last().evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    // Establish the already-visible branch; do not remove minimum retention in production.
    if (!early) await page.waitForTimeout(2_100);
    if (count > 1)
      expect(
        await items
          .nth(1)
          .evaluate((element) =>
            Number.parseFloat(getComputedStyle(element.firstElementChild!).paddingTop)
          )
      ).toBe(gap);
    const geometry = await page.locator('.interactive-list').evaluate((list) => {
      const viewport = list.querySelector<HTMLElement>('.assistant-active-activity-items')!;
      return {
        bottomDistance: list.scrollHeight - list.clientHeight - list.scrollTop,
        clipped: viewport.scrollHeight - viewport.clientHeight,
      };
    });
    expect(geometry.bottomDistance).toBeLessThanOrEqual(2);
    if (count > 3) expect(geometry.clipped).toBeGreaterThan(1);
    else expect(geometry.clipped).toBeLessThanOrEqual(1);
    if (scenario.animation === 'fallback') {
      await page.addStyleTag({
        content: '.assistant-active-activity-item.is-exiting { animation: none !important; }',
      });
    }
    if (scenario.detached) {
      const bounds = await page.locator('.interactive-list').boundingBox();
      if (!bounds) throw new Error('Transcript viewport is missing');
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
      await page.mouse.wheel(0, -180);
      await expect
        .poll(() =>
          page
            .locator('.interactive-list')
            .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
        )
        .toBeGreaterThan(100);
      await page.waitForTimeout(150);
    }
    const pauseExit = scenario.detachDuring
      ? await page.addStyleTag({
          content:
            '.assistant-active-activity-item.is-exiting { animation-play-state: paused !important; }',
        })
      : null;
    const sampling = page.locator('.interactive-list').evaluate(
      async (list, options) => {
        const containerTop = list.getBoundingClientRect().top;
        const ownerRow = list.querySelector<HTMLElement>(
          `[data-msg-id="${CSS.escape(options.targetMessageId)}"]`
        );
        const summary = ownerRow?.querySelector<HTMLElement>('.assistant-activity-summary');
        if (!summary) throw new Error('Active tray summary is missing');
        const messageId = summary.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        if (!messageId) throw new Error('Summary message identity is missing');
        if (ownerRow?.querySelectorAll('.assistant-activity-summary').length !== 1)
          throw new Error('This fixture requires exactly one logical activity group');
        const before = summary.getBoundingClientRect().top - containerTop;
        const samples: Array<{
          top: number | null;
          expectedTop: number | null;
          active: number;
          exiting: number;
          thinking: boolean;
          scrollTop: number;
          scrollHeight: number;
          append: number;
          exit: number;
        }> = [];
        const harness = (
          window as typeof window & {
            __varroE2E: {
              getSessionMessages: (id: string) => MessageEntry[];
              updateMessagePart: (part: Part) => void;
            };
          }
        ).__varroE2E;
        const running = harness
          .getSessionMessages(options.sessionId)
          .flatMap((message) => message.parts)
          .filter(
            (part): part is Extract<Part, { type: 'tool' }> =>
              part.type === 'tool' && part.state.status === 'running'
          );
        if (running.length !== options.count) throw new Error('Expected running tools are missing');
        // Start sampling in the same browser evaluation that delivers the production events.
        // Updating mock persistence alone waits for polling and can sample before the bug occurs.
        const completionOrder = options.stagger ? [running[1]!, running[0]!, running[2]!] : running;
        const pendingCompletions = completionOrder.map((part, index) => ({
          part,
          at: options.stagger ? index * 180 : 0,
        }));
        const complete = (part: Extract<Part, { type: 'tool' }>) => {
          if (part.state.status !== 'running') throw new Error('Expected a running tool');
          const completed: Part = {
            ...part,
            state: {
              ...part.state,
              status: 'completed',
              title: part.state.title ?? part.tool,
              output: 'Done',
              metadata: {},
              time: { start: Date.now() - 3_000, end: Date.now() },
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
        };
        let cancelledAnimations = 0;
        const start = performance.now();
        while (performance.now() - start < 3_500) {
          while (pendingCompletions[0] && pendingCompletions[0].at <= performance.now() - start) {
            complete(pendingCompletions.shift()!.part);
          }
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const current = list.querySelector<HTMLElement>(
            `[data-msg-id="${CSS.escape(messageId)}"] .assistant-activity-summary`
          );
          if (
            options.animation === 'cancel' &&
            cancelledAnimations === 0 &&
            performance.now() - start > 100
          ) {
            for (const item of list.querySelectorAll(
              '.assistant-active-activity-item.is-exiting'
            )) {
              for (const animation of item.getAnimations()) {
                if (
                  animation instanceof CSSAnimation &&
                  animation.animationName === 'assistant-active-activity-out'
                ) {
                  animation.cancel();
                  cancelledAnimations += 1;
                }
              }
            }
          }
          samples.push({
            top: current ? current.getBoundingClientRect().top - containerTop : null,
            expectedTop:
              list.dataset.exitTestAnchor === 'moving'
                ? null
                : list.dataset.exitTestAnchor
                  ? Number(list.dataset.exitTestAnchor)
                  : before,
            active: list.querySelectorAll('.assistant-active-activity-item').length,
            exiting: list.querySelectorAll('.assistant-active-activity-item.is-exiting').length,
            thinking: !!list.querySelector(
              '.interactive-loading-row:not(.is-reserved):not(.trailing-assistant-summary-row)'
            ),
            scrollTop: list.scrollTop,
            scrollHeight: list.scrollHeight,
            append:
              list.querySelector('.append-scroll-bottom-reserve')?.getBoundingClientRect().height ??
              0,
            exit:
              list.querySelector('.activity-exit-bottom-reserve')?.getBoundingClientRect().height ??
              0,
          });
        }
        return { before, messageId, samples, cancelledAnimations };
      },
      { count, stagger, sessionId, targetMessageId, animation: scenario.animation }
    );
    if (scenario.detachDuring) {
      await expect(items.first()).toHaveClass(/is-exiting/);
      const list = page.locator('.interactive-list');
      await list.evaluate((element) => {
        element.dataset.exitTestAnchor = 'moving';
      });
      const bounds = await list.boundingBox();
      if (!bounds) throw new Error('Transcript viewport is missing');
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
      await page.mouse.wheel(0, -180);
      await expect
        .poll(() =>
          list.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop
          )
        )
        .toBeGreaterThan(100);
      await page.waitForTimeout(100);
      // The new anchor is established by genuine native movement. Later animation/timer cleanup
      // must preserve this destination, not restore the pre-gesture bottom target.
      await list.evaluate((element) => {
        const summary = element.querySelector('.assistant-activity-summary')!;
        element.dataset.exitTestAnchor = String(
          summary.getBoundingClientRect().top - element.getBoundingClientRect().top
        );
      });
      await pauseExit?.evaluate((element) => element.parentNode?.removeChild(element));
    }
    const result = await sampling;
    if (scenario.detachDuring) {
      expect(
        result.samples.filter(
          (sample) => sample.expectedTop !== null && sample.expectedTop !== result.before
        ).length
      ).toBeGreaterThan(10);
      expect(result.samples.at(-1)?.exit).toBe(0);
      expect(result.samples.at(-1)?.append).toBe(0);
    }
    expect(result.samples.some((sample) => sample.exiting === (stagger ? 1 : count))).toBe(true);
    expect(result.samples.at(-1)?.active).toBe(0);
    expect(result.samples.at(-1)?.thinking).toBe(true);
    expect(result.samples.at(-1)?.exit).toBe(0);
    if (scenario.detached) {
      expect(result.samples.every((sample) => sample.append === 0 && sample.exit === 0)).toBe(true);
      expect(result.samples.at(-1)?.scrollTop).toBeCloseTo(result.samples[0]!.scrollTop, 0);
    } else if (!scenario.detachDuring) expect(result.samples.at(-1)?.append).toBeGreaterThan(0);
    if (scenario.animation === 'cancel') expect(result.cancelledAnimations).toBe(count);
    const maxDrift = Math.max(
      ...result.samples.map((sample) =>
        sample.expectedTop === null
          ? 0
          : sample.top === null
            ? Infinity
            : Math.abs(sample.top - sample.expectedTop)
      )
    );
    await test.info().attach('frame-geometry', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    expect(
      maxDrift,
      'The same logical summary must remain fixed through exit and Thinking handoff'
    ).toBeLessThanOrEqual(1);
    if (scenario.name === 'three simultaneous') {
      const appendReserve = page.locator('.append-scroll-bottom-reserve');
      const originalReserve = await appendReserve.evaluate(
        (element) => element.getBoundingClientRect().height
      );
      const appendText = (text: string) =>
        page.evaluate(
          ({ sessionId, messageID, text }) => {
            const part: Part = {
              id: 'activity-replacement-text',
              sessionID: sessionId,
              messageID,
              type: 'text',
              text,
            };
            const harness = (
              window as typeof window & { __varroE2E: { updateMessagePart: (part: Part) => void } }
            ).__varroE2E;
            harness.updateMessagePart(part);
            window.postMessage(
              {
                type: 'server/event',
                payload: { type: 'message.part.updated', properties: { part } },
              },
              '*'
            );
          },
          { sessionId, messageID: targetMessageId, text }
        );
      // Small real growth must consume reserve without moving the preceding transcript. A large
      // all-at-once replacement only proves eventual cleanup and misses premature consumption.
      await appendText('A short continuation.');
      await expect
        .poll(() => appendReserve.evaluate((element) => element.getBoundingClientRect().height))
        .toBeLessThan(originalReserve - 5);
      expect(
        await appendReserve.evaluate((element) => element.getBoundingClientRect().height)
      ).toBeGreaterThan(0);
      const top = await page
        .locator(`[data-msg-id="${targetMessageId}"] .assistant-activity-summary`)
        .evaluate(
          (element) =>
            element.getBoundingClientRect().top -
            element.closest('.interactive-list')!.getBoundingClientRect().top
        );
      expect(Math.abs(top - result.before)).toBeLessThanOrEqual(1);
      await appendText(
        Array.from({ length: 24 }, (_, index) => `Replacement paragraph ${index + 1}.`).join('\n\n')
      );
      await expect(appendReserve).toHaveCount(0);
      await expect
        .poll(() =>
          page
            .locator('.interactive-list')
            .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
        )
        .toBeLessThanOrEqual(2);
    }
  });
}
