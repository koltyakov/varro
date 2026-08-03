import { expect, test } from '@playwright/test';
import {
  getScrollMetrics,
  getVisibleMessageAnchor,
  sampleMessageTopAcrossFrames,
  waitForAnimationFrame,
  waitForAnimationFrames,
} from './helpers';
import { appendDeltaToLastLargeAssistant, appendDeltaToRapidStreaming } from './scroll-helpers';

test.describe('auto-scroll', () => {
  test('starts at the bottom of the conversation', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('does not push a full transcript backward when send-time panels collapse', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(2);

    await page.evaluate(() => {
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'todo.updated',
            properties: {
              sessionID: 'session-large-transcript',
              todos: [
                {
                  content: 'Completed work from the previous turn',
                  status: 'completed',
                  priority: 'medium',
                },
              ],
            },
          },
        },
        '*'
      );
    });
    await expect(page.getByRole('button', { name: /Todos/i })).toBeVisible();
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(2);
    await waitForAnimationFrames(page, 6);

    await composer.fill(
      Array.from(
        { length: 8 },
        (_, index) => `Keep the full transcript stable while sending, line ${index + 1}.`
      ).join('\n')
    );
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(2);
    await waitForAnimationFrames(page, 6);
    await page.evaluate(() => {
      const harness = window as Window & {
        __sendToExtension?: (message: unknown) => void | Promise<void>;
        sendTransitionSamples?: Array<{ previousTop: number; entering: boolean }>;
      };
      const originalSend = harness.__sendToExtension;
      harness.__sendToExtension = async (message) => {
        const request = message as { type?: string; payload?: { path?: string } };
        if (request.type === 'api/request' && request.payload?.path?.endsWith('/prompt_async')) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        await originalSend?.(message);
      };

      const container = document.querySelector<HTMLElement>('.interactive-list')!;
      const previousMessage = container.querySelector<HTMLElement>(
        '[data-msg-id="message-large-assistant-239"]'
      )!;
      const previousIds = new Set(
        [...container.querySelectorAll<HTMLElement>('[data-msg-id]')].map(
          (row) => row.dataset.msgId
        )
      );
      const samples: Array<{ previousTop: number; entering: boolean }> = [
        {
          previousTop:
            previousMessage.getBoundingClientRect().top - container.getBoundingClientRect().top,
          entering: false,
        },
      ];
      const observer = new MutationObserver(() => {
        const appended = [...container.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
          (row) => !previousIds.has(row.dataset.msgId)
        );
        if (!appended) return;
        observer.disconnect();

        const sample = () => {
          samples.push({
            previousTop:
              previousMessage.getBoundingClientRect().top - container.getBoundingClientRect().top,
            entering: appended.classList.contains('measured-entrance-active'),
          });
          if (samples.length < 25) requestAnimationFrame(sample);
          else harness.sendTransitionSamples = samples;
        };
        requestAnimationFrame(sample);
      });
      observer.observe(container, { childList: true, subtree: true });
    });

    await page.getByTitle('Send (Enter)').click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { sendTransitionSamples?: unknown }).sendTransitionSamples
        )
      )
      .not.toBeUndefined();

    const samples = await page.evaluate(
      () =>
        (
          window as Window & {
            sendTransitionSamples?: Array<{ previousTop: number; entering: boolean }>;
          }
        ).sendTransitionSamples ?? []
    );
    const previousTops = samples.map((sample) => sample.previousTop);
    for (let index = 1; index < previousTops.length; index += 1) {
      expect(previousTops[index]!).toBeLessThanOrEqual(previousTops[index - 1]! + 1);
      expect(previousTops[index - 1]! - previousTops[index]!).toBeLessThan(30);
    }
    expect(samples.every((sample) => !sample.entering)).toBe(true);
    await expect(page.locator('.chat-turn-user').last()).toContainText(
      'Keep the full transcript stable while sending, line 1.'
    );
    await expect(page.locator('.append-scroll-bottom-reserve')).toHaveCount(0);
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(15);
  });

  test('keeps the transcript anchored when the todo list collapses', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    const previousMessage = page.locator('[data-msg-id="message-large-assistant-239"]');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

    await page.evaluate(() => {
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'todo.updated',
            properties: {
              sessionID: 'session-large-transcript',
              todos: Array.from({ length: 7 }, (_, index) => ({
                content: `Remaining work item ${index + 1}`,
                status: index === 0 ? 'in_progress' : 'pending',
                priority: 'medium',
              })),
            },
          },
        },
        '*'
      );
    });

    const todoBlock = page.locator('.todo-block:not(.changed-files-block)');
    const todoToggle = page.getByRole('button', { name: /Todos/i });
    const getTodoListGeometry = () =>
      todoBlock.evaluate((block) => {
        const todoList = block.querySelector<HTMLElement>('.todo-block-list');
        if (!todoList) throw new Error('Expanded todo list is missing');
        return {
          rightInset: block.getBoundingClientRect().right - todoList.getBoundingClientRect().right,
          clientHeight: todoList.clientHeight,
          scrollHeight: todoList.scrollHeight,
        };
      });
    await expect(todoToggle).toHaveAttribute('aria-expanded', 'true');
    const initialTodoGeometry = await getTodoListGeometry();
    expect(initialTodoGeometry.scrollHeight).toBeGreaterThan(initialTodoGeometry.clientHeight);
    expect(initialTodoGeometry.rightInset).toBeCloseTo(2, 1);
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(2);
    await waitForAnimationFrames(page, 6);

    const previousTop = await previousMessage.evaluate(
      (element) =>
        element.getBoundingClientRect().top -
        element.closest('.interactive-list')!.getBoundingClientRect().top
    );
    await todoToggle.click();

    const samples = await sampleMessageTopAcrossFrames(list, 'message-large-assistant-239', 12);
    expect(
      samples.every((sample) => sample !== null && Math.abs(sample - previousTop) <= 1),
      JSON.stringify({ previousTop, samples })
    ).toBe(true);
    await expect(todoToggle).toHaveAttribute('aria-expanded', 'false');
    const reserve = page.locator('.append-scroll-bottom-reserve');
    await expect(reserve).toBeVisible();
    const firstReserveHeight = await reserve.evaluate(
      (element) => element.getBoundingClientRect().height
    );

    await todoToggle.click();
    await expect(todoToggle).toHaveAttribute('aria-expanded', 'true');
    const reopenedTodoGeometry = await getTodoListGeometry();
    expect(reopenedTodoGeometry.scrollHeight).toBeGreaterThan(reopenedTodoGeometry.clientHeight);
    expect(reopenedTodoGeometry.rightInset).toBeCloseTo(2, 1);
    const expansionSamples = await sampleMessageTopAcrossFrames(
      list,
      'message-large-assistant-239',
      12
    );
    expect(
      expansionSamples.every((sample) => sample !== null && Math.abs(sample - previousTop) <= 1)
    ).toBe(true);
    await expect(reserve).toHaveCount(0);
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(2);

    await todoToggle.click();
    await expect(todoToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(reserve).toBeVisible();
    const secondReserveHeight = await reserve.evaluate(
      (element) => element.getBoundingClientRect().height
    );
    expect(Math.abs(secondReserveHeight - firstReserveHeight)).toBeLessThanOrEqual(1);

    await todoToggle.click();
    await expect(todoToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(reserve).toHaveCount(0);
    await todoToggle.click();
    await expect(todoToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(reserve).toBeVisible();
    const thirdReserveHeight = await reserve.evaluate(
      (element) => element.getBoundingClientRect().height
    );
    expect(Math.abs(thirdReserveHeight - firstReserveHeight)).toBeLessThanOrEqual(1);

    const detachedAnchor = await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 300);
      const containerRect = element.getBoundingClientRect();
      const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
      });
      if (!row?.dataset.msgId) throw new Error('Detached todo anchor is missing');
      const anchor = {
        id: row.dataset.msgId,
        top: row.getBoundingClientRect().top - containerRect.top,
      };
      element.dispatchEvent(new Event('scroll'));
      return anchor;
    });
    await expect(reserve).toHaveCount(0);
    const detachedSamples = await sampleMessageTopAcrossFrames(list, detachedAnchor.id, 3);
    expect(
      detachedSamples.every((top) => top !== null && Math.abs(top - detachedAnchor.top) <= 1),
      JSON.stringify({ detachedAnchor, detachedSamples })
    ).toBe(true);
  });

  test('manual scroll up disengages auto-scroll', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await waitForAnimationFrame(page);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 300);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    const metrics = await getScrollMetrics(page, '.interactive-list');
    expect(metrics.distanceFromBottom).toBeGreaterThan(190);
  });

  test('small upward wheel from bottom does not snap back', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const anchor = await getVisibleMessageAnchor(list);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -48, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 48);
      element.dispatchEvent(new Event('scroll'));
    });

    await page.waitForTimeout(260);
    const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 3);
    expect(
      samples.every((top) => top !== null && Math.abs(top - anchor.top - 48) < 3),
      JSON.stringify({ anchor, samples })
    ).toBe(true);
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      30
    );
  });

  test('scrolls upward through a large transcript without virtualized content jumps', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    for (let index = 0; index < 60; index += 1) {
      const anchor = await getVisibleMessageAnchor(list);
      if (anchor.scrollTop < 180) break;

      await list.evaluate((element) => {
        const target = Math.max(0, element.scrollTop - 180);
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -180, bubbles: true }));
        element.scrollTop = target;
        element.dispatchEvent(new Event('scroll'));
      });
      const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 3);
      expect(
        samples.every((top) => top !== null),
        JSON.stringify({ index, anchor, samples })
      ).toBe(true);
      const settledTop = samples.at(-1)!;
      expect(Math.abs(settledTop! - anchor.top - 180), `wheel step ${index}`).toBeLessThan(4);
      for (const top of samples.slice(1)) {
        expect(Math.abs(top! - settledTop!), `settling step ${index}`).toBeLessThan(1.5);
      }
    }
  });

  test('mouse wheel upward from mid transcript never jumps backward', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await list.evaluate((element) => {
      element.scrollTop = Math.floor(element.scrollHeight / 2);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    for (let index = 0; index < 18; index += 1) {
      const anchor = await getVisibleMessageAnchor(list);
      if (anchor.scrollTop < 180) break;
      await page.mouse.wheel(0, -180);
      const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 3);
      expect(
        samples.every((top) => top !== null),
        JSON.stringify({ index, anchor, samples })
      ).toBe(true);
      const settledTop = samples.at(-1)!;
      expect(Math.abs(settledTop! - anchor.top - 180), `wheel step ${index}`).toBeLessThan(4);
      for (const top of samples.slice(1)) {
        expect(Math.abs(top! - settledTop!), `settling step ${index}`).toBeLessThan(1.5);
      }
    }
  });

  test('heterogeneous long chat scrolls upward without screen-sized jumps', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=heterogeneous-large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    for (let index = 0; index < 35; index += 1) {
      await waitForAnimationFrames(page, 2);
      const before = await getVisibleMessageAnchor(list);
      if (before.scrollTop < 180) break;

      await page.mouse.wheel(0, -180);
      const tops = await sampleMessageTopAcrossFrames(list, before.id, 4);
      expect(
        tops.every((top) => top !== null),
        JSON.stringify({ index, before, tops })
      ).toBe(true);
      const settledTop = tops.at(-1)!;
      expect(Math.abs(settledTop! - before.top - 180), `wheel step ${index}`).toBeLessThan(4);
      for (const top of tops.slice(1)) {
        expect(Math.abs(top! - settledTop!), `settling step ${index}`).toBeLessThan(1.5);
      }
    }
  });

  test('restores the same compact tool row after measured reflow settles', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=tool-cards-large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect
      .poll(() => list.evaluate((element) => element.querySelectorAll('[data-msg-id]').length))
      .toBeLessThan(60);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * 0.7);
      element.dispatchEvent(new Event('scroll'));
    });

    await waitForAnimationFrames(page, 2);
    const beforeReflow = await getVisibleMessageAnchor(list);
    await page.addStyleTag({
      content: `
        .tool-invocation-header,
        .file-read-card-header,
        .file-change-card-header,
        .thinking-header {
          padding-block: 9px !important;
        }
      `,
    });
    const reflowSamples = await sampleMessageTopAcrossFrames(list, beforeReflow.id, 8);
    expect(
      reflowSamples.every((top) => top !== null),
      JSON.stringify(reflowSamples)
    ).toBe(true);
    // The first RAF callback can precede the coalesced measurement correction in the same
    // pre-paint turn; the settled frames must restore the original visible position.
    for (const top of reflowSamples.slice(1)) {
      expect(Math.abs(top! - beforeReflow.top)).toBeLessThan(1.5);
    }

    for (let step = 0; step < 20; step += 1) {
      await list.evaluate((element) => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -180, bubbles: true }));
        element.scrollTop = Math.max(0, element.scrollTop - 180);
        element.dispatchEvent(new Event('scroll'));
      });
      const anchor = await getVisibleMessageAnchor(list);
      const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 6);
      for (const top of samples) {
        expect(top).not.toBeNull();
        expect(Math.abs(top! - anchor.top)).toBeLessThan(1.5);
      }
    }
  });

  test('keeps visible rows stable after prepending heterogeneous history', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=assistant-heavy-history&windowed=1');
    const list = page.locator('.interactive-list');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      element.scrollTop = 20;
      element.dispatchEvent(new Event('scroll'));
    });
    // Setup only: a prepend legitimately raises scrollTop. The wheel loop below owns the jump oracle.
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
    await waitForAnimationFrames(page, 4);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    for (let step = 0; step < 32; step += 1) {
      const before = await list.evaluate((element) => {
        const containerRect = element.getBoundingClientRect();
        const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
          (candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
          }
        );
        return {
          scrollTop: element.scrollTop,
          id: row?.dataset.msgId ?? '',
          top: row ? row.getBoundingClientRect().top - containerRect.top : 0,
        };
      });
      if (before.scrollTop <= 1) break;
      await page.mouse.wheel(0, -80);
      const tops = await sampleMessageTopAcrossFrames(list, before.id, 4);
      expect(
        tops.every((top) => top !== null),
        JSON.stringify({ step, before, tops })
      ).toBe(true);
      const settledTop = tops.at(-1)!;
      expect(Math.abs(settledTop! - before.top - 80), `wheel step ${step}`).toBeLessThan(6);
      for (const top of tops.slice(1)) {
        expect(Math.abs(top! - settledTop!), `settling step ${step}`).toBeLessThan(1.5);
      }
    }
  });

  test('preserves the same row through exact 50 plus 50 plus final pagination', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 486, height: 800 });
    await page.goto(
      '/e2e/harness/index.html?scenario=assistant-heavy-history&windowed=1&deferHistory=1'
    );
    const list = page.locator('.interactive-list');
    const historyBanner = page.locator('.message-history-banner');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const harness = window as Window & {
            __varroE2E?: { pendingHistoryRequestCount?: () => number };
          };
          return harness.__varroE2E?.pendingHistoryRequestCount?.() ?? 0;
        })
      )
      .toBe(1);

    const loadPageAtTop = async () => {
      await list.evaluate((element) => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll'));
      });
      await expect(historyBanner).toHaveClass(/is-loading/);
      const anchor = await list.evaluate((element) => {
        const containerRect = element.getBoundingClientRect();
        const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
          (candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
          }
        );
        if (!row?.dataset.msgId) throw new Error('Paginated history anchor is missing');
        return {
          id: row.dataset.msgId,
          top: row.getBoundingClientRect().top - containerRect.top,
        };
      });
      const released = await page.evaluate(() => {
        const harness = window as Window & {
          __varroE2E?: { releaseNextHistoryRequest?: () => boolean };
        };
        return harness.__varroE2E?.releaseNextHistoryRequest?.() ?? false;
      });
      expect(released).toBe(true);
      const samples = await sampleMessageTopAcrossFrames(list, anchor.id);
      for (const top of samples) {
        expect(top).not.toBeNull();
        expect(Math.abs(top! - anchor.top)).toBeLessThan(1.5);
      }
      expect(await list.locator('[data-msg-id]').count()).toBeLessThan(80);
    };

    await loadPageAtTop();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const harness = window as Window & {
            __varroE2E?: { pendingHistoryRequestCount?: () => number };
          };
          return harness.__varroE2E?.pendingHistoryRequestCount?.() ?? 0;
        })
      )
      .toBe(1);
    await loadPageAtTop();
    await expect(historyBanner).toHaveCount(0);

    const historyRequests = await page.evaluate(() => {
      const harness = window as Window & {
        __varroE2E?: { requests?: Array<{ path: string }> };
      };
      return (harness.__varroE2E?.requests ?? [])
        .filter((request) =>
          request.path.includes('/session/session-assistant-heavy-history/message')
        )
        .map((request) => {
          const params = new URL(request.path, 'https://example.test').searchParams;
          return { before: params.get('before'), limit: params.get('limit') };
        });
    });
    expect(historyRequests).toEqual([
      { before: null, limit: '50' },
      { before: 'msg_cursor_0001', limit: '50' },
      { before: 'msg_cursor_0002', limit: '50' },
    ]);
  });

  test('keeps the incident-equivalent paginated image row stable across delayed loading', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 486, height: 800 });

    let markImageRequestStarted!: () => void;
    const imageRequestStarted = new Promise<void>((resolve) => {
      markImageRequestStarted = resolve;
    });
    let releaseImageRequest!: () => void;
    const imageRequestRelease = new Promise<void>((resolve) => {
      releaseImageRequest = resolve;
    });
    let imageRequestCount = 0;
    await page.route('**/e2e/harness/incident-delayed-image.svg', async (route) => {
      imageRequestCount += 1;
      markImageRequestStarted();
      await imageRequestRelease;
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#3b82f6"/><circle cx="320" cy="240" r="96" fill="#dbeafe"/></svg>',
      });
    });

    await page.goto(
      '/e2e/harness/index.html?scenario=incident-delayed-image-history&windowed=1&deferHistory=1'
    );
    const list = page.locator('.interactive-list');
    const historyBanner = page.locator('.message-history-banner');
    const imageRow = page.locator('[data-msg-id="message-incident-delayed-image-user"]');
    const imageFrame = imageRow.locator('.chat-image-preview-trigger');
    const pendingHistoryRequestCount = () =>
      page.evaluate(() => {
        const harness = window as Window & {
          __varroE2E?: { pendingHistoryRequestCount?: () => number };
        };
        return harness.__varroE2E?.pendingHistoryRequestCount?.() ?? 0;
      });

    const fixtureMessageCount = await page.evaluate(() => {
      const harness = window as Window & {
        __varroE2E?: { getSessionMessages?: (sessionId: string) => unknown[] };
      };
      return (
        harness.__varroE2E?.getSessionMessages?.('session-incident-delayed-image-history').length ??
        0
      );
    });
    expect(fixtureMessageCount).toBe(129);
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect(imageRow).toBeAttached({ timeout: 5_000 });
    await imageRequestStarted;
    const frameHeightBeforeRelease = await imageFrame.evaluate(
      (element) => element.getBoundingClientRect().height
    );
    expect(frameHeightBeforeRelease).toBe(224);
    expect(
      await imageFrame.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)
    ).toBe(0);
    await expect.poll(pendingHistoryRequestCount).toBe(1);

    const loadDeferredHistoryPage = async () => {
      await list.evaluate((element) => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll'));
      });
      await expect(historyBanner).toHaveClass(/is-loading/);
      const anchor = await list.evaluate((element) => {
        const containerRect = element.getBoundingClientRect();
        const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
          (candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
          }
        );
        if (!row?.dataset.msgId) throw new Error('Incident history anchor is missing');
        return {
          id: row.dataset.msgId,
          top: row.getBoundingClientRect().top - containerRect.top,
        };
      });
      const released = await page.evaluate(() => {
        const harness = window as Window & {
          __varroE2E?: { releaseNextHistoryRequest?: () => boolean };
        };
        return harness.__varroE2E?.releaseNextHistoryRequest?.() ?? false;
      });
      expect(released).toBe(true);

      const samples = await sampleMessageTopAcrossFrames(list, anchor.id);
      for (const top of samples) {
        expect(top).not.toBeNull();
        expect(Math.abs(top! - anchor.top)).toBeLessThan(1.5);
      }
      expect(await list.locator('[data-msg-id]').count()).toBeLessThan(80);
    };

    await loadDeferredHistoryPage();
    await expect(imageRow).toHaveCount(0);
    await expect.poll(pendingHistoryRequestCount).toBe(1);
    await loadDeferredHistoryPage();
    await expect(historyBanner).toHaveCount(0);
    await expect(imageRow).toHaveCount(0);

    const historyRequests = await page.evaluate(() => {
      const harness = window as Window & {
        __varroE2E?: { requests?: Array<{ path: string }> };
      };
      return (harness.__varroE2E?.requests ?? [])
        .filter((request) =>
          request.path.includes('/session/session-incident-delayed-image-history/message')
        )
        .map((request) => {
          const params = new URL(request.path, 'https://example.test').searchParams;
          return { before: params.get('before'), limit: params.get('limit') };
        });
    });
    expect(historyRequests).toEqual([
      { before: null, limit: '50' },
      { before: 'msg_cursor_0001', limit: '50' },
      { before: 'msg_cursor_0002', limit: '50' },
    ]);

    const imageResponse = page.waitForResponse((response) =>
      response.url().endsWith('/e2e/harness/incident-delayed-image.svg')
    );
    releaseImageRequest();
    await imageResponse;

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: 2_000, bubbles: true }));
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(imageRow).toBeAttached();
    await waitForAnimationFrames(page, 4);
    const imageRowTop = await imageRow.evaluate((element) => {
      const scrollList = element.closest<HTMLElement>('.interactive-list')!;
      return element.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
    });
    await imageFrame.locator('img').evaluate((image: HTMLImageElement) => image.decode());
    const frameHeightAfterRelease = await imageFrame.evaluate(
      (element) => element.getBoundingClientRect().height
    );
    expect(frameHeightAfterRelease).toBe(224);
    expect(
      await imageFrame.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)
    ).toBe(640);
    expect(imageRequestCount).toBeGreaterThan(0);

    const remountSamples = await sampleMessageTopAcrossFrames(
      list,
      'message-incident-delayed-image-user'
    );
    for (const top of remountSamples) {
      expect(top).not.toBeNull();
      expect(Math.abs(top! - imageRowTop)).toBeLessThan(1.5);
    }
    expect(await list.locator('[data-msg-id]').count()).toBeLessThan(80);
  });

  test('transfers deferred history ownership after native PageDown movement', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=assistant-heavy-history&windowed=1&deferHistory=1'
    );
    const list = page.locator('.interactive-list');
    const historyBanner = page.locator('.message-history-banner');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const harness = window as Window & {
            __varroE2E?: { pendingHistoryRequestCount?: () => number };
          };
          return harness.__varroE2E?.pendingHistoryRequestCount?.() ?? 0;
        })
      )
      .toBe(1);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
      element.tabIndex = 0;
      element.focus();
    });
    await expect(historyBanner).toHaveClass(/is-loading/);
    await page.keyboard.press('PageDown');
    // Setup only: prove PageDown moved before capturing the user-owned visible anchor.
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
    await list.evaluate(async (element) => {
      let previousTop = element.scrollTop;
      let stableFrames = 0;
      while (stableFrames < 3) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const nextTop = element.scrollTop;
        stableFrames = Math.abs(nextTop - previousTop) <= 0.5 ? stableFrames + 1 : 0;
        previousTop = nextTop;
      }
    });

    const anchor = await list.evaluate((element) => {
      const containerRect = element.getBoundingClientRect();
      const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
      });
      if (!row?.dataset.msgId) throw new Error('PageDown history anchor is missing');
      return {
        id: row.dataset.msgId,
        top: row.getBoundingClientRect().top - containerRect.top,
      };
    });
    await page.evaluate(() => {
      const harness = window as Window & {
        __varroE2E?: { releaseNextHistoryRequest?: () => boolean };
      };
      if (!harness.__varroE2E?.releaseNextHistoryRequest?.()) {
        throw new Error('Deferred history page was not pending');
      }
    });

    const samples = await sampleMessageTopAcrossFrames(list, anchor.id);
    for (const top of samples) {
      expect(top).not.toBeNull();
      expect(Math.abs(top! - anchor.top)).toBeLessThan(1.5);
    }
  });

  test('does not restore a stale history anchor after the user scrolls during the request', async ({
    page,
  }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=assistant-heavy-history&windowed=1&deferHistory=1'
    );
    const list = page.locator('.interactive-list');
    const historyBanner = page.locator('.message-history-banner');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop = 20;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(historyBanner).toHaveClass(/is-loading/);

    const userOwnedAnchor = await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: 600, bubbles: true }));
      element.scrollTop = 620;
      element.dispatchEvent(new Event('scroll'));
      const containerRect = element.getBoundingClientRect();
      const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
      });
      if (!row?.dataset.msgId) throw new Error('User-owned history anchor is missing');
      return {
        id: row.dataset.msgId,
        top: row.getBoundingClientRect().top - containerRect.top,
      };
    });
    await page.evaluate(() => {
      const harness = window as Window & {
        __varroE2E?: { releaseHistoryRequests?: () => void };
      };
      harness.__varroE2E?.releaseHistoryRequests?.();
    });

    await expect(historyBanner).not.toHaveClass(/is-loading/);
    await waitForAnimationFrames(page, 6);
    await expect
      .poll(() =>
        list.evaluate((element, anchorId) => {
          const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
            (candidate) => candidate.dataset.msgId === anchorId
          );
          return row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top : null;
        }, userOwnedAnchor.id)
      )
      .toBeCloseTo(userOwnedAnchor.top, 0);
  });

  test('keeps history anchored when an upward wheel cannot move past the top boundary', async ({
    page,
  }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=assistant-heavy-history&windowed=1&deferHistory=1'
    );
    const list = page.locator('.interactive-list');
    const historyBanner = page.locator('.message-history-banner');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(historyBanner).toHaveClass(/is-loading/);

    const anchor = await list.evaluate((element) => {
      const containerRect = element.getBoundingClientRect();
      const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
      });
      if (!row?.dataset.msgId) throw new Error('Boundary history anchor is missing');
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
      return {
        id: row.dataset.msgId,
        top: row.getBoundingClientRect().top - containerRect.top,
        scrollTop: element.scrollTop,
      };
    });
    // Boundary precondition only; post-load stability is asserted from the same row below.
    expect(anchor.scrollTop).toBe(0);

    await page.evaluate(() => {
      const harness = window as Window & {
        __varroE2E?: { releaseHistoryRequests?: () => void };
      };
      harness.__varroE2E?.releaseHistoryRequests?.();
    });
    await expect(historyBanner).not.toHaveClass(/is-loading/);
    await waitForAnimationFrames(page, 6);
    await expect
      .poll(() =>
        list.evaluate((element, anchorId) => {
          const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
            (candidate) => candidate.dataset.msgId === anchorId
          );
          return row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top : null;
        }, anchor.id)
      )
      .toBeCloseTo(anchor.top, 0);
  });

  test('mixed small chat scrolls upward without random jumps', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=mixed-small-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    for (let index = 0; index < 18; index += 1) {
      const anchor = await getVisibleMessageAnchor(list);
      if (anchor.scrollTop < 160) break;
      await page.mouse.wheel(0, -160);
      const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 3);
      expect(
        samples.every((top) => top !== null),
        JSON.stringify({ index, anchor, samples })
      ).toBe(true);
      const settledTop = samples.at(-1)!;
      expect(Math.abs(settledTop! - anchor.top - 160), `wheel step ${index}`).toBeLessThan(4);
      for (const top of samples.slice(1)) {
        expect(Math.abs(top! - settledTop!), `settling step ${index}`).toBeLessThan(1.5);
      }
    }
  });

  test('keeps a detached small-chat anchor stable when rows above grow and collapse', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=mixed-small-transcript');
    const list = page.locator('.interactive-list');
    const track = page.locator('.interactive-list-track');
    const anchor = page.locator('[data-msg-id="message-small-user-12"]');
    const rowAbove = page.locator('[data-msg-id="message-small-assistant-2"]');
    await expect(track).not.toHaveClass(/virtualized/);

    await list.evaluate((element) => {
      const target = element.querySelector<HTMLElement>('[data-msg-id="message-small-user-12"]');
      if (!target) throw new Error('Small-chat anchor is missing');
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop +=
        target.getBoundingClientRect().top - element.getBoundingClientRect().top - 120;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    const anchorTop = await anchor.evaluate((element) => {
      const scrollList = element.closest<HTMLElement>('.interactive-list')!;
      return element.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
    });
    await rowAbove.evaluate((element) => {
      element.style.paddingBottom = '280px';
    });
    await waitForAnimationFrames(page, 3);
    await expect
      .poll(() =>
        anchor.evaluate((element) => {
          const scrollList = element.closest<HTMLElement>('.interactive-list')!;
          return element.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
        })
      )
      .toBeCloseTo(anchorTop, 0);

    await rowAbove.evaluate((element) => {
      element.style.paddingBottom = '';
    });
    await waitForAnimationFrames(page, 3);
    await expect
      .poll(() =>
        anchor.evaluate((element) => {
          const scrollList = element.closest<HTMLElement>('.interactive-list')!;
          return element.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
        })
      )
      .toBeCloseTo(anchorTop, 0);
  });

  test('follows assistant response growth while pinned to the bottom', async ({ page }) => {
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

    for (let index = 0; index < 6; index += 1) {
      await appendDeltaToLastLargeAssistant(
        page,
        `\n\nStreaming bottom follow chunk ${index}: ${'keep following the bottom '.repeat(10)}`
      );
      await waitForAnimationFrame(page);
    }

    await expect(page.locator('.chat-turn-assistant').last()).toContainText(
      'Streaming bottom follow chunk 5'
    );
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('keeps follow disabled after manual scroll and re-enables at bottom', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -160, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 800);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 2);
    const detachedAnchor = await getVisibleMessageAnchor(list);

    await appendDeltaToLastLargeAssistant(
      page,
      `\n\nDetached streaming chunk: ${'do not steal scroll position '.repeat(18)}`
    );
    const detachedSamples = await sampleMessageTopAcrossFrames(list, detachedAnchor.id, 3);

    expect(
      detachedSamples.every((top) => top !== null && Math.abs(top - detachedAnchor.top) < 1.5),
      JSON.stringify({ detachedAnchor, detachedSamples })
    ).toBe(true);
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      200
    );

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 2);

    await appendDeltaToLastLargeAssistant(
      page,
      `\n\nReattached streaming chunk: ${'follow again '.repeat(24)}`
    );

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });
});

test.describe('auto-scroll re-engage', () => {
  test('re-engages when user scrolls within 10px of bottom', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -160, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 800);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      200
    );

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight - element.clientHeight - 8;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    await appendDeltaToLastLargeAssistant(
      page,
      `\n\nRe-engage test chunk: ${'verify auto-scroll re-engages within 10px threshold '.repeat(12)}`
    );
    await waitForAnimationFrames(page, 4);

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('scroll up during streaming disables follow without snap-back', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    for (let i = 0; i < 3; i += 1) {
      await appendDeltaToRapidStreaming(
        page,
        `\n\nPre-wheel chunk ${i}: ${'content before wheel '.repeat(8)}`
      );
      await waitForAnimationFrames(page, 2);
    }

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 200);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);
    const detachedAnchor = await getVisibleMessageAnchor(list);

    for (let i = 0; i < 3; i += 1) {
      await appendDeltaToRapidStreaming(
        page,
        `\n\nPost-wheel chunk ${i}: ${'content after wheel should not snap back '.repeat(10)}`
      );
      const samples = await sampleMessageTopAcrossFrames(list, detachedAnchor.id, 2);
      expect(
        samples.every((top) => top !== null && Math.abs(top - detachedAnchor.top) < 1.5),
        JSON.stringify({ i, detachedAnchor, samples })
      ).toBe(true);
    }
  });

  test('scrolling to bottom during streaming re-engages follow', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -160, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 500);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      200
    );

    await appendDeltaToRapidStreaming(
      page,
      `\n\nDetached chunk: ${'should not follow '.repeat(10)}`
    );
    await waitForAnimationFrames(page, 3);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    for (let i = 0; i < 4; i += 1) {
      await appendDeltaToRapidStreaming(
        page,
        `\n\nRe-engage chunk ${i}: ${'follow after re-engage '.repeat(12)}`
      );
      await waitForAnimationFrames(page, 2);
    }

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });
});
