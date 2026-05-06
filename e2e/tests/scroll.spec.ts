import { expect, test } from '@playwright/test';
import { getScrollMetrics } from './helpers';

async function waitForAnimationFrame(page: import('@playwright/test').Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

async function waitForAnimationFrames(page: import('@playwright/test').Page, count: number) {
  for (let index = 0; index < count; index += 1) {
    await waitForAnimationFrame(page);
  }
}

async function appendDeltaToLastLargeAssistant(
  page: import('@playwright/test').Page,
  delta: string
) {
  await page.evaluate((nextDelta) => {
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'session-large-transcript',
            messageID: 'message-large-assistant-239',
            partID: 'message-large-assistant-239-text-1',
            field: 'text',
            delta: nextDelta,
          },
        },
      },
      '*'
    );
  }, delta);
}

test.describe('auto-scroll', () => {
  test('starts at the bottom of the conversation', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
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
    expect(metrics.distanceFromBottom).toBeGreaterThan(200);
  });

  test('small upward wheel from bottom does not snap back', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const detachedScrollTop = await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -48, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 48);
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop;
    });

    await page.waitForTimeout(260);
    await waitForAnimationFrames(page, 3);

    const afterSettled = await list.evaluate((element) => element.scrollTop);
    expect(Math.abs(afterSettled - detachedScrollTop)).toBeLessThan(3);
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(30);
  });

  test('does not jitter when scrolled to the middle of a large transcript', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    const midpoint = await list.evaluate((element) => {
      const mid = Math.floor(element.scrollHeight / 2);
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = mid;
      element.dispatchEvent(new Event('scroll'));
      return mid;
    });
    await waitForAnimationFrame(page);

    const posAfterFrame = await list.evaluate((el) => el.scrollTop);
    expect(Math.abs(posAfterFrame - midpoint)).toBeLessThan(2);

    await waitForAnimationFrame(page);
    const posAfterSecondFrame = await list.evaluate((el) => el.scrollTop);
    expect(Math.abs(posAfterSecondFrame - midpoint)).toBeLessThan(2);
  });

  test('scrolls upward through a large transcript without virtualized content jumps', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const samples: Array<{ target: number; actual: number; visibleRows: number }> = [];
    for (let index = 0; index < 24; index += 1) {
      const sample = await list.evaluate((element) => {
        const target = Math.max(0, element.scrollTop - 700);
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -700, bubbles: true }));
        element.scrollTop = target;
        element.dispatchEvent(new Event('scroll'));
        return { target, actual: element.scrollTop, visibleRows: 0 };
      });
      await waitForAnimationFrames(page, 2);
      const settled = await list.evaluate((element, target) => {
        const containerRect = element.getBoundingClientRect();
        const visibleRows = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].filter(
          (row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
          }
        ).length;
        return { target, actual: element.scrollTop, visibleRows };
      }, sample.target);
      samples.push(settled);
    }

    for (const sample of samples) {
      expect(sample.visibleRows).toBeGreaterThan(0);
      expect(Math.abs(sample.actual - sample.target)).toBeLessThan(90);
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

    const positions: number[] = [await list.evaluate((element) => element.scrollTop)];
    for (let index = 0; index < 18; index += 1) {
      await page.mouse.wheel(0, -180);
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]).toBeLessThanOrEqual(positions[index - 1] + 2);
    }

    const visibleRows = await list.evaluate((element) => {
      const containerRect = element.getBoundingClientRect();
      return [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
      }).length;
    });
    expect(visibleRows).toBeGreaterThan(0);
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

    const detachedScrollTop = await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -160, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 800);
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop;
    });
    await waitForAnimationFrames(page, 2);

    await appendDeltaToLastLargeAssistant(
      page,
      `\n\nDetached streaming chunk: ${'do not steal scroll position '.repeat(18)}`
    );
    await waitForAnimationFrames(page, 3);

    const afterDetachedDelta = await list.evaluate((element) => element.scrollTop);
    expect(Math.abs(afterDetachedDelta - detachedScrollTop)).toBeLessThan(3);
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(200);

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

  test('does not jump upward when repeatedly scrolling down near the bottom', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const positions: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      await appendDeltaToLastLargeAssistant(
        page,
        `\n\nNear-bottom stability chunk ${index}: ${'content dependent scroll stability '.repeat(12)}`
      );
      positions.push(
        await list.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          element.dispatchEvent(new Event('scroll'));
          return element.scrollTop;
        })
      );
      await waitForAnimationFrame(page);
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    const largestUpwardJump = positions.reduce((largest, current, index) => {
      if (index === 0) return largest;
      return Math.max(largest, positions[index - 1] - current);
    }, 0);
    expect(largestUpwardJump).toBeLessThan(60);
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });
});

test.describe('scroll stability regressions', () => {
  test('scroll position holds when streaming arrives while scrolled to middle', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const midScrollTop = await list.evaluate((element) => {
      const mid = Math.floor(element.scrollHeight / 2);
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = mid;
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop;
    });
    await waitForAnimationFrames(page, 3);

    for (let index = 0; index < 8; index += 1) {
      await appendDeltaToLastLargeAssistant(
        page,
        `\n\nMid-scroll streaming chunk ${index}: ${'this should not move the viewport '.repeat(8)}`
      );
      await waitForAnimationFrames(page, 2);
    }

    const afterStreaming = await list.evaluate((element) => element.scrollTop);
    expect(Math.abs(afterStreaming - midScrollTop)).toBeLessThan(5);
  });

  test('rapid streaming at bottom does not oscillate', async ({ page }) => {
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

    const positions: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      await appendDeltaToLastLargeAssistant(
        page,
        `\n\nRapid chunk ${index}: ${'filling content '.repeat(6)}`
      );
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((el) => el.scrollTop));
    }

    let upwardJumpCount = 0;
    for (let index = 1; index < positions.length; index += 1) {
      if (positions[index] < positions[index - 1] - 3) {
        upwardJumpCount++;
      }
    }
    expect(upwardJumpCount).toBeLessThanOrEqual(1);

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('user scroll beyond reattach threshold stays detached', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const scrolledPosition = await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 300);
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop;
    });
    await waitForAnimationFrames(page, 4);

    const afterSettled = await list.evaluate((el) => el.scrollTop);
    expect(Math.abs(afterSettled - scrolledPosition)).toBeLessThan(5);
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(200);
  });

  test('no jitter when streaming grows content while auto-scroll follows', async ({ page }) => {
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

    await expect(page.locator('.chat-turn-assistant').last()).toContainText('Growing content block 9');
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('scroll position stable across multiple animation frames after wheel stop', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    const targetPosition = await list.evaluate((element) => {
      const target = Math.floor(element.scrollHeight * 0.3);
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true }));
      element.scrollTop = target;
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop;
    });

    const positions: number[] = [];
    for (let frame = 0; frame < 10; frame += 1) {
      await waitForAnimationFrame(page);
      positions.push(await list.evaluate((el) => el.scrollTop));
    }

    for (const pos of positions) {
      expect(Math.abs(pos - targetPosition)).toBeLessThan(3);
    }
  });
});

test.describe('sticky preview overlap', () => {
  test('hides immediately when next user message reaches the sticky bottom', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=sticky-preview');
    const list = page.locator('.interactive-list');
    const sticky = page.locator('.latest-user-message-sticky');

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);
    await expect(sticky).toBeVisible();

    const overlapDetected = await list.evaluate((element) => {
      const stickyEl = document.querySelector('.latest-user-message-sticky');
      const nextPrompt = document.querySelector(
        '[data-msg-id="message-sticky-user-2"] .user-message-card'
      );
      if (!stickyEl || !nextPrompt) return false;

      const stickyBottom = stickyEl.getBoundingClientRect().bottom;
      const promptTop = nextPrompt.getBoundingClientRect().top;

      const step = 5;
      for (let i = 0; i < 600; i++) {
        element.scrollTop += step;
        element.dispatchEvent(new Event('scroll'));

        const currentStickyEl = document.querySelector('.latest-user-message-sticky');
        const currentPromptEl = document.querySelector(
          '[data-msg-id="message-sticky-user-2"] .user-message-card'
        );
        if (!currentStickyEl || !currentPromptEl) break;

        const currentStickyBottom = currentStickyEl.getBoundingClientRect().bottom;
        const currentPromptTop = currentPromptEl.getBoundingClientRect().top;
        if (currentPromptTop < currentStickyBottom) {
          return true;
        }
      }
      return false;
    });

    expect(overlapDetected).toBe(false);
  });

  test('sticky hides when scrolling back up toward its source message', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=sticky-preview');
    const list = page.locator('.interactive-list');
    const sticky = page.locator('.latest-user-message-sticky');

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);
    await expect(sticky).toBeVisible();

    await list.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);
    await waitForAnimationFrame(page);

    await expect(sticky).not.toBeVisible();
  });
});
