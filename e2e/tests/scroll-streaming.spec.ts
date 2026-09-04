/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Assertions access test-only fields installed by the controlled E2E harness. */
import { expect, test } from '@playwright/test';
import {
  getScrollMetrics,
  getVisibleMessageAnchor,
  sampleMessageTopAcrossFrames,
  waitForAnimationFrame,
  waitForAnimationFrames,
} from './helpers';
import {
  appendDeltaToLastLargeAssistant,
  appendDeltaToMultiAgentLargeStreaming,
  appendDeltaToRapidStreaming,
} from './scroll-helpers';

test.describe('scroll stability regressions', () => {
  test('rapid streaming remains within the bottom-follow threshold', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    for (let index = 0; index < 12; index += 1) {
      await appendDeltaToLastLargeAssistant(
        page,
        `\n\nRapid chunk ${index}: ${'filling content '.repeat(6)}`
      );
      await waitForAnimationFrames(page, 2);
      await expect
        .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
        .toBeLessThan(15);
    }

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('first streamed item stays painted within its clipped bottom-follow viewport', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await page.evaluate(() => {
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'message-rapid-assistant-streaming-text-2',
                sessionID: 'session-rapid-streaming-jitter',
                messageID: 'message-rapid-assistant-streaming',
                type: 'text',
                text:
                  '## 1. Orientation\n\n' +
                  Array.from(
                    { length: 6 },
                    (_, index) =>
                      `Streamed paragraph ${index + 1} enters while the measured wrapper clips its natural layout.`
                  ).join('\n\n'),
              },
            },
          },
        },
        '*'
      );
    });

    const entering = page
      .locator(
        '[data-msg-id="message-rapid-assistant-streaming"] .assistant-message-flow-item-streamed.measured-entrance-active'
      )
      .last();
    await expect(entering).toBeAttached();
    const geometry = await entering.evaluate(async (element) => {
      const animation = element.getAnimations()[0];
      animation?.pause();
      if (animation) animation.currentTime = 90;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );

      const transcript = element.closest<HTMLElement>('.interactive-list')!;
      const paragraphs = element.querySelectorAll<HTMLElement>('.rendered-markdown p');
      const paragraph = paragraphs[paragraphs.length - 1]!;
      const viewport = transcript.getBoundingClientRect();
      const raw = paragraph.getBoundingClientRect();
      let paintedBottom = Math.min(raw.bottom, viewport.bottom);
      let ancestor = paragraph.parentElement;
      while (ancestor && ancestor !== transcript) {
        const styles = getComputedStyle(ancestor);
        if (/(auto|clip|hidden|scroll)/.test(`${styles.overflow} ${styles.overflowY}`)) {
          paintedBottom = Math.min(paintedBottom, ancestor.getBoundingClientRect().bottom);
        }
        ancestor = ancestor.parentElement;
      }
      return {
        bottomDistance: transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop,
        clipBottom: element.getBoundingClientRect().bottom,
        rawBottom: raw.bottom,
        viewportBottom: viewport.bottom,
        paintedBottom,
      };
    });

    expect(geometry.bottomDistance).toBeLessThanOrEqual(1);
    expect(geometry.rawBottom).toBeGreaterThan(geometry.clipBottom + 1);
    expect(geometry.paintedBottom).toBeLessThanOrEqual(
      Math.min(geometry.clipBottom, geometry.viewportBottom)
    );
  });

  test('user scroll beyond the reattach threshold disengages bottom follow', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 300);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 4);

    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      190
    );
  });

  test('keeps bottom follow engaged while streaming content grows', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    for (let index = 0; index < 10; index += 1) {
      await appendDeltaToLastLargeAssistant(
        page,
        `\n\nGrowing content block ${index}:\n${'Line of streaming text that exercises the auto-follow logic.\n'.repeat(4)}`
      );
      await waitForAnimationFrames(page, 2);
    }

    await expect(page.locator('.chat-turn-assistant').last()).toContainText(
      'Growing content block 9'
    );
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });
});

test.describe('rapid streaming bottom follow', () => {
  test('renders each streamed chunk and assistant row at most once in every frame', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    await expect(page.locator('.interactive-list')).toBeVisible();

    const markers = Array.from(
      { length: 8 },
      (_, index) => `VFZ-DUP-${String(index + 1).padStart(2, '0')}`
    );
    await page.evaluate((streamMarkers) => {
      const harness = window as Window & {
        streamingDuplicateSamples?: Array<{ rowCount: number; tokenCounts: number[] }>;
      };
      harness.streamingDuplicateSamples = [];
      const sample = () => {
        const row = document.querySelector<HTMLElement>(
          '[data-msg-id="message-rapid-assistant-streaming"]'
        );
        const text = row?.textContent ?? '';
        harness.streamingDuplicateSamples?.push({
          rowCount: document.querySelectorAll('[data-msg-id="message-rapid-assistant-streaming"]')
            .length,
          tokenCounts: streamMarkers.map((marker) => text.split(marker).length - 1),
        });
        if ((harness.streamingDuplicateSamples?.length ?? 0) < 80) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, markers);

    for (const marker of markers) {
      await appendDeltaToRapidStreaming(page, `\n${marker}`);
      await waitForAnimationFrames(page, 3);
    }
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { streamingDuplicateSamples?: unknown[] }).streamingDuplicateSamples
              ?.length ?? 0
        )
      )
      .toBe(80);

    const samples = await page.evaluate(
      () =>
        (
          window as Window & {
            streamingDuplicateSamples?: Array<{ rowCount: number; tokenCounts: number[] }>;
          }
        ).streamingDuplicateSamples ?? []
    );
    expect(
      samples.every(
        (sample) => sample.rowCount === 1 && sample.tokenCounts.every((count) => count <= 1)
      ),
      JSON.stringify(samples)
    ).toBe(true);
    await expect(page.locator('[data-msg-id="message-rapid-assistant-streaming"]')).toContainText(
      markers.at(-1)!
    );
  });

  test('keeps bottom follow engaged across varying streaming delta sizes', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    for (let i = 0; i < 20; i += 1) {
      const size =
        i % 2 === 0
          ? 'short'
          : 'long with extra padding to vary content sizes significantly. '.repeat(8);
      await appendDeltaToRapidStreaming(page, `\n\nVarying-size chunk ${i}: ${size}`);
      await waitForAnimationFrames(page, 2);
      await expect
        .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
        .toBeLessThan(15);
    }

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('paints unfinished inline markdown while keeping bottom follow engaged', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    const row = page.locator('[data-msg-id="message-rapid-assistant-streaming"]');
    await expect(list).toBeVisible();
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await appendDeltaToRapidStreaming(
      page,
      `\n\nPending inline \`${'VFZ-PENDING-MARKDOWN '.repeat(24)}`
    );
    await waitForAnimationFrames(page, 2);

    await expect(row).toContainText('VFZ-PENDING-MARKDOWN');
    await expect(row.locator('.streaming-markdown-pending')).toHaveCSS('visibility', 'visible');
    expect(
      (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom
    ).toBeLessThanOrEqual(1);

    await appendDeltaToRapidStreaming(page, '`');
    await expect(row.locator('.streaming-markdown-pending')).toHaveCount(0);
    for (let frame = 0; frame < 4; frame += 1) {
      await waitForAnimationFrame(page);
      expect(
        (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom,
        `frame ${frame}`
      ).toBeLessThanOrEqual(1);
    }
  });

  test('auto-scroll follows rapid sequential streaming deltas', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    for (let i = 0; i < 20; i += 1) {
      await appendDeltaToRapidStreaming(
        page,
        `\n\nRapid sequential chunk ${i}: ${'fast follow delta '.repeat(4)}`
      );
    }
    await waitForAnimationFrames(page, 5);

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(10);
  });

  test('keeps the same visible row fixed while detached streaming arrives', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      const mid = Math.floor(element.scrollHeight / 2);
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = mid;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);
    const anchor = await getVisibleMessageAnchor(list);

    for (let i = 0; i < 8; i += 1) {
      await appendDeltaToRapidStreaming(
        page,
        `\n\nMid-scroll streaming chunk ${i}: ${'viewport should not move while detached '.repeat(6)}`
      );
      const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 2);
      expect(
        samples.every((top) => top !== null && Math.abs(top - anchor.top) < 1.5),
        JSON.stringify({ i, anchor, samples })
      ).toBe(true);
    }
  });

  test('keeps the top viewport fixed while detached streaming arrives', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    expect((await getScrollMetrics(page, '.interactive-list')).scrollTop).toBe(0);
    const anchor = await getVisibleMessageAnchor(list);

    for (let i = 0; i < 8; i += 1) {
      await appendDeltaToRapidStreaming(
        page,
        `\n\nTop-scroll streaming chunk ${i}: ${'the top viewport should remain fixed '.repeat(6)}`
      );
      const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 2);
      expect(
        samples.every((top) => top !== null && Math.abs(top - anchor.top) < 1.5),
        JSON.stringify({ i, anchor, samples })
      ).toBe(true);
      expect((await getScrollMetrics(page, '.interactive-list')).scrollTop).toBe(0);
    }
  });
});

test.describe('bottom scroll stability during height changes', () => {
  test('downward wheel at bottom keeps bottom follow engaged during streaming', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.hover();
    for (let i = 0; i < 15; i += 1) {
      await page.mouse.wheel(0, 50);
      await appendDeltaToRapidStreaming(
        page,
        `\n\nBottom-wheel chunk ${i}: ${'content growing while user scrolls down '.repeat(4)}`
      );
      await waitForAnimationFrames(page, 2);
      await expect
        .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
        .toBeLessThan(15);
    }

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('keeps bottom follow engaged across large multi-agent height changes', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-large-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    for (let i = 0; i < 20; i += 1) {
      const content =
        i % 2 === 0
          ? 'Short.'
          : `${'Long paragraph with significant height variation to test scroll stability during rapid content size changes. '.repeat(6)}`;
      await appendDeltaToMultiAgentLargeStreaming(page, `\n\n${content}`);
      await waitForAnimationFrames(page, 2);
      await expect
        .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
        .toBeLessThan(15);
    }

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('re-engages bottom follow after returning within threshold in a multi-agent transcript', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=multi-agent-large-streaming');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -160, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 600);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      200
    );

    await appendDeltaToMultiAgentLargeStreaming(
      page,
      `\n\nDetached chunk: ${'should not follow '.repeat(8)}`
    );
    await waitForAnimationFrames(page, 3);
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      200
    );

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight - element.clientHeight - 5;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    for (let i = 0; i < 6; i += 1) {
      await appendDeltaToMultiAgentLargeStreaming(
        page,
        `\n\nRe-engage chunk ${i}: ${'follow after re-engage '.repeat(8)}`
      );
      await waitForAnimationFrames(page, 2);
    }

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });
});
