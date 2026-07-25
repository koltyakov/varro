import { expect, test } from '@playwright/test';
import { getScrollMetrics, waitForAnimationFrame, waitForAnimationFrames } from './helpers';
import {
  appendDeltaToLastLargeAssistant,
  appendDeltaToMultiAgentLargeStreaming,
  appendDeltaToRapidStreaming,
} from './scroll-helpers';

test.describe('scroll stability regressions', () => {
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
      if (positions[index]! < positions[index - 1]! - 3) {
        upwardJumpCount++;
      }
    }
    expect(upwardJumpCount).toBeLessThanOrEqual(1);

    let maxJitterAmplitude = 0;
    for (let index = 2; index < positions.length; index += 1) {
      const jitter = Math.abs(
        positions[index]! - positions[index - 1]! - (positions[index - 1]! - positions[index - 2]!)
      );
      maxJitterAmplitude = Math.max(maxJitterAmplitude, jitter);
    }
    expect(maxJitterAmplitude).toBeLessThan(150);

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
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      190
    );
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

    await expect(page.locator('.chat-turn-assistant').last()).toContainText(
      'Growing content block 9'
    );
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });
});

test.describe('rapid streaming jitter resistance', () => {
  test('no jitter at exact bottom during streaming with varying content sizes', async ({
    page,
  }) => {
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

    const positions: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const size =
        i % 2 === 0
          ? 'short'
          : 'long with extra padding to vary content sizes significantly. '.repeat(8);
      await appendDeltaToRapidStreaming(page, `\n\nVarying-size chunk ${i}: ${size}`);
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    let maxOscillation = 0;
    for (let i = 2; i < positions.length; i += 1) {
      const oscillation = Math.abs(
        positions[i]! - positions[i - 1]! - (positions[i - 1]! - positions[i - 2]!)
      );
      maxOscillation = Math.max(maxOscillation, oscillation);
    }

    expect(maxOscillation).toBeLessThan(200);

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
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

  test('scroll position holds when streaming arrives while scrolled to middle near threshold', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
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

    for (let i = 0; i < 8; i += 1) {
      await appendDeltaToRapidStreaming(
        page,
        `\n\nMid-scroll streaming chunk ${i}: ${'viewport should not move while detached '.repeat(6)}`
      );
      await waitForAnimationFrames(page, 2);
    }

    const afterStreaming = await list.evaluate((element) => element.scrollTop);
    expect(Math.abs(afterStreaming - midScrollTop)).toBeLessThan(5);
  });
});

test.describe('bottom scroll stability during height changes', () => {
  test('downward wheel at bottom during streaming does not cause jitter', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.hover();
    const positions: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      await page.mouse.wheel(0, 50);
      await appendDeltaToRapidStreaming(
        page,
        `\n\nBottom-wheel chunk ${i}: ${'content growing while user scrolls down '.repeat(4)}`
      );
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    let maxBackwardJump = 0;
    for (let i = 1; i < positions.length; i += 1) {
      const backward = positions[i - 1]! - positions[i]!;
      maxBackwardJump = Math.max(maxBackwardJump, backward);
    }
    expect(maxBackwardJump).toBeLessThan(25);

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('no oscillation when streaming content varies height significantly', async ({ page }) => {
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

    const positions: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const content =
        i % 2 === 0
          ? 'Short.'
          : `${'Long paragraph with significant height variation to test scroll stability during rapid content size changes. '.repeat(6)}`;
      await appendDeltaToMultiAgentLargeStreaming(page, `\n\n${content}`);
      await waitForAnimationFrames(page, 2);
      positions.push(await list.evaluate((element) => element.scrollTop));
    }

    let oscillationCount = 0;
    for (let i = 2; i < positions.length; i += 1) {
      const d1 = positions[i - 1]! - positions[i - 2]!;
      const d2 = positions[i]! - positions[i - 1]!;
      if ((d1 > 5 && d2 < -5) || (d1 < -5 && d2 > 5)) {
        oscillationCount++;
      }
    }
    expect(oscillationCount).toBeLessThanOrEqual(1);

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('re-engage after detach works smoothly in large multi-agent transcript', async ({
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
