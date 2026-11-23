import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { postWebviewMessage } from './helpers';

const HISTOGRAM_URL = '/e2e/harness/index.html?scenario=blank&showEmptyStateHistogram=true';

async function pixels(canvas: Locator) {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext('2d');
    if (!context) throw new Error('Histogram canvas has no 2D context');
    const data = context.getImageData(0, 0, element.width, element.height).data;
    const count = Math.max(1, Math.ceil(element.width / 9));
    const stride = 9;
    const heights = Array.from({ length: count }, () => 0);
    let colored = 0;
    let emptyTopColumns = 0;
    let orange = 0;
    let white = 0;
    let gray = 0;
    let bright = 0;
    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3]!;
      if (alpha < 8) continue;
      colored++;
      if (alpha > 80) bright++;
      const x = ((index / 4) % element.width) + 0.5;
      const y = Math.floor(index / 4 / element.width) + 0.5;
      const column = Math.floor(x / stride);
      heights[column] = Math.max(heights[column] ?? 0, Math.ceil(y));
      if (data[index]! > data[index + 1]! && data[index + 1]! > data[index + 2]!) orange++;
      if (Math.min(data[index]!, data[index + 1]!, data[index + 2]!) >= 252) white++;
      if (
        Math.max(data[index]!, data[index + 1]!, data[index + 2]!) -
          Math.min(data[index]!, data[index + 1]!, data[index + 2]!) <=
        2
      )
        gray++;
    }
    for (let column = 0; column < count; column++) {
      for (const offset of [2, 6]) {
        const x = column * stride + offset;
        if (x < element.width && data[(2 * element.width + x) * 4 + 3]! < 8) emptyTopColumns++;
      }
    }
    return { colored, emptyTopColumns, orange, white, gray, bright, heights };
  });
}

test('empty chats show narrow random-height tiled bars with tiny gaps and no solid backgrounds', async ({
  page,
}) => {
  await page.setViewportSize({ width: 515, height: 800 });
  await page.goto(HISTOGRAM_URL);
  const histogram = page.locator('.chat-empty-histogram');
  const canvas = histogram.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(async () => (await pixels(canvas)).colored).toBeGreaterThan(0);
  await expect(histogram.locator(':scope > *')).toHaveCount(1);
  await expect(histogram).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const initial = await pixels(canvas);
  expect(new Set(initial.heights).size).toBeGreaterThan(5);
  expect(initial.bright).toBe(0);
  expect(initial.emptyTopColumns).toBe(0);
  expect(initial.gray).toBe(initial.colored);
  expect(initial.orange).toBe(0);
  for (const height of initial.heights) {
    expect(height).toBeGreaterThanOrEqual(8);
    expect(height).toBeLessThanOrEqual(108);
  }
  const area = await page.locator('.interactive-list-shell').boundingBox();
  const box = await histogram.boundingBox();
  expect(box!.y).toBe(area!.y);
  expect(box!.height).toBe(112);
  const canvasBox = (await canvas.boundingBox())!;
  expect(canvasBox.x).toBe(area!.x);
  expect(canvasBox.width).toBe(area!.width);
  await page.screenshot({ path: test.info().outputPath('histogram-idle.png') });

  for (const width of [240, 1200, 515]) {
    await page.setViewportSize({ width, height: 800 });
    await expect
      .poll(() =>
        canvas.evaluate((element: HTMLCanvasElement) => {
          // Read layout and backing width together so a resize cannot mix frames.
          const areaWidth = element
            .closest('.interactive-list-shell')!
            .getBoundingClientRect().width;
          return element.width === Math.ceil(areaWidth);
        })
      )
      .toBe(true);
    const canvasWidth = Number(await canvas.getAttribute('width'));
    const resized = await pixels(canvas);
    expect(resized.heights).toHaveLength(Math.ceil(canvasWidth / 9));
    // Resizing keeps both the tile grid and the existing random profile.
    const common = Math.min(Math.floor(canvasBox.width / 9), Math.floor(canvasWidth / 9));
    await expect
      .poll(async () => {
        const painted = await pixels(canvas);
        return Math.max(
          ...painted.heights
            .slice(0, common)
            .map((height, index) => Math.abs(height - initial.heights[index]!))
        );
      })
      .toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
});

test('the header plus generates a new histogram even when the chat is already empty', async ({
  page,
}) => {
  await page.setViewportSize({ width: 515, height: 800 });
  await page.goto(HISTOGRAM_URL);
  const canvas = page.locator('.chat-empty-histogram-waves');
  await expect.poll(async () => (await pixels(canvas)).colored).toBeGreaterThan(0);
  let previous = await pixels(canvas);
  for (let click = 0; click < 2; click++) {
    const oldCanvas = (await canvas.elementHandle())!;
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect.poll(() => oldCanvas.evaluate((element) => element.isConnected)).toBe(false);
    await expect.poll(async () => (await pixels(canvas)).colored).toBeGreaterThan(0);
    const rebuilt = await pixels(canvas);
    expect(rebuilt.heights).not.toEqual(previous.heights);
    previous = rebuilt;
  }
});

test('short viewports scale the bar profile instead of cropping it and restore it when taller', async ({
  page,
}) => {
  await page.setViewportSize({ width: 515, height: 800 });
  await page.goto(HISTOGRAM_URL);
  const histogram = page.locator('.chat-empty-histogram');
  const canvas = histogram.locator('canvas');
  await expect.poll(async () => (await pixels(canvas)).colored).toBeGreaterThan(0);
  const initial = await pixels(canvas);

  for (const height of [400, 320]) {
    await page.setViewportSize({ width: 515, height });
    await expect
      .poll(async () => {
        const box = (await histogram.boundingBox())!;
        return Number(await canvas.getAttribute('height')) === Math.ceil(box.height);
      })
      .toBe(true);
    const box = (await histogram.boundingBox())!;
    const canvasHeight = Number(await canvas.getAttribute('height'));
    expect(canvasHeight).toBeLessThan(112);
    expect((await canvas.boundingBox())!.height).toBe(Math.ceil(box.height));
    await expect.poll(async () => (await pixels(canvas)).colored).toBeGreaterThan(0);
    const small = await pixels(canvas);
    for (let index = 0; index < initial.heights.length; index++) {
      expect(
        Math.abs(small.heights[index]! - (initial.heights[index]! * canvasHeight) / 112)
      ).toBeLessThanOrEqual(5);
    }
    expect(Math.max(...small.heights)).toBeLessThan(canvasHeight);
  }

  await page.setViewportSize({ width: 515, height: 800 });
  await expect(canvas).toHaveAttribute('height', '112');
  await expect.poll(async () => (await pixels(canvas)).heights).toEqual(initial.heights);
});

test('hover preserves the generated histogram after localized waves settle', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 515, height: 800 });
  await page.goto(HISTOGRAM_URL);
  const histogram = page.locator('.chat-empty-histogram');
  const canvas = histogram.locator('canvas');
  await expect.poll(async () => (await pixels(canvas)).colored).toBeGreaterThan(0);
  const initial = await pixels(canvas);
  const box = await histogram.boundingBox();
  await histogram.hover({ position: { x: 120, y: 12 } });
  await expect.poll(async () => (await pixels(canvas)).orange).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath('histogram-hover.png') });
  expect(await histogram.boundingBox()).toEqual(box);
  await expect.poll(async () => (await pixels(canvas)).orange, { timeout: 15000 }).toBe(0);
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await pixels(canvas)).heights).toEqual(initial.heights);
  const rebuilt = await pixels(canvas);
  expect(rebuilt.heights).toEqual(initial.heights);

  await histogram.hover({ position: { x: 150, y: 16 } });
  await expect.poll(async () => (await pixels(canvas)).orange).toBeGreaterThan(0);
  await expect.poll(async () => (await pixels(canvas)).orange, { timeout: 15000 }).toBe(0);
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await pixels(canvas)).heights).toEqual(initial.heights);
  await histogram.hover({ position: { x: 120, y: 12 } });
  await expect.poll(async () => (await pixels(canvas)).orange).toBeGreaterThan(0);
  await expect.poll(async () => (await pixels(canvas)).orange, { timeout: 15000 }).toBe(0);
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await pixels(canvas)).heights).toEqual(initial.heights);

  await page.locator('body').evaluate((body) => {
    body.classList.remove('vscode-dark');
    body.classList.add('vscode-light');
  });
  await expect(canvas).toHaveCSS('color', 'rgb(255, 255, 255)');
  await histogram.hover({ position: { x: 190, y: 12 } });
  await expect.poll(async () => (await pixels(canvas)).white).toBeGreaterThan(0);
});

test('nearby bars pulse like a music visualizer instead of following the pointer height', async ({
  page,
}) => {
  await page.setViewportSize({ width: 515, height: 800 });
  await page.addInitScript(() => {
    Math.random = () => 0.5;
  });
  await page.goto(HISTOGRAM_URL);
  const canvas = page.locator('.chat-empty-histogram-waves');
  await expect.poll(async () => (await pixels(canvas)).colored).toBeGreaterThan(0);
  const initial = await pixels(canvas);
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 246, box.y + 90);
  await page.clock.runFor(160);
  const changed = await pixels(canvas);
  const nearby: number[] = [];
  for (const [column, height] of changed.heights.entries()) {
    if (Math.abs(column * 9 + 4 - 246) < 96) {
      nearby.push(height - initial.heights[column]!);
    } else {
      expect(height).toBe(initial.heights[column]);
    }
  }
  expect(Math.max(...nearby)).toBeGreaterThan(1);
  expect(Math.min(...nearby)).toBeLessThan(-1);
  await page.screenshot({ path: test.info().outputPath('histogram-random-nearby-bars.png') });
  await page.clock.runFor(9000);
  const profiles = new Set<string>();
  for (let sample = 0; sample < 10; sample++) {
    await page.clock.runFor(160);
    const pulsing = await pixels(canvas);
    expect(pulsing.orange).toBe(0);
    profiles.add(pulsing.heights.slice(23, 31).join(','));
    for (const [column, height] of pulsing.heights.entries()) {
      if (Math.abs(column * 9 + 4 - 246) >= 96) expect(height).toBe(initial.heights[column]);
    }
  }
  expect(profiles.size).toBeGreaterThan(3);
  await page.screenshot({ path: test.info().outputPath('histogram-music-visualizer.png') });
  await page.mouse.move(0, 0);
  await page.clock.runFor(15000);
  expect((await pixels(canvas)).heights).toEqual(initial.heights);
});

test('pointer movement sends transient waves instead of leaving a static circular glow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 515, height: 800 });
  await page.goto(HISTOGRAM_URL);
  const canvas = page.locator('.chat-empty-histogram-waves');
  await expect.poll(async () => (await pixels(canvas)).colored).toBeGreaterThan(0);
  const initial = await pixels(canvas);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 246, box.y + 96);
  await expect.poll(async () => (await pixels(canvas)).orange).toBeGreaterThan(0);
  await expect.poll(async () => (await pixels(canvas)).orange, { timeout: 15000 }).toBe(0);
  const lower = await pixels(canvas);
  expect(lower.orange).toBe(0);
  expect(lower.gray).toBe(lower.colored);
  await page.mouse.move(box.x + 246, box.y + 32);
  await expect.poll(async () => (await pixels(canvas)).orange).toBeGreaterThan(0);
  await expect.poll(async () => (await pixels(canvas)).orange, { timeout: 15000 }).toBe(0);
  const higher = await pixels(canvas);
  expect(higher.orange).toBe(0);
  expect(higher.gray).toBe(higher.colored);
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await pixels(canvas)).heights).toEqual(initial.heights);
});

for (const motion of [
  { direction: 'right', x: 24, y: 0 },
  { direction: 'left', x: -24, y: 0 },
  { direction: 'down', x: 0, y: 24 },
  { direction: 'up', x: 0, y: -24 },
]) {
  test(`cursor movement radiates only into a forward sector ${motion.direction}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 515, height: 800 });
    await page.addInitScript(() => {
      Math.random = () => 0.9;
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(HISTOGRAM_URL);
    const canvas = page.locator('.chat-empty-histogram-waves');
    await expect.poll(async () => (await pixels(canvas)).colored).toBeGreaterThan(0);
    const now = new Date();
    await page.clock.install({ time: now });
    await page.clock.pauseAt(now);
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 246 - motion.x, box.y + 46 - motion.y);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.clock.runFor(48);
    await page.mouse.move(box.x + 246, box.y + 46);
    await page.clock.runFor(320);
    const sector = await canvas.evaluate((element: HTMLCanvasElement, direction) => {
      const context = element.getContext('2d')!;
      const data = context.getImageData(0, 0, element.width, element.height).data;
      let highlights = 0;
      let outside = 0;
      for (let y = 2; y < element.height; y += 4) {
        for (let column = 0; column < element.width / 9; column++) {
          for (const lane of [2, 6]) {
            const x = column * 9 + lane;
            if (x >= element.width) continue;
            const index = (y * element.width + x) * 4;
            if (!(data[index]! > data[index + 1]! && data[index + 1]! > data[index + 2]!)) continue;
            highlights++;
            const dx = x - 246;
            const dy = y - 46;
            const alignment =
              (dx * direction.x + dy * direction.y) /
              (Math.hypot(dx, dy) * Math.hypot(direction.x, direction.y));
            if (alignment <= 0.5) outside++;
          }
        }
      }
      return { highlights, outside };
    }, motion);
    expect(sector.highlights).toBeGreaterThan(0);
    expect(sector.outside).toBe(0);
    await page.screenshot({
      path: test.info().outputPath(`histogram-forward-sector-${motion.direction}.png`),
    });
  });
}

for (const motion of [
  { direction: 'down', from: 8, to: 24, targetY: 66 },
  { direction: 'up', from: 104, to: 88, targetY: 50 },
]) {
  test(`vertical wave travels ${motion.direction} over histogram tiles while hovered`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 515, height: 800 });
    await page.addInitScript(() => {
      Math.random = () => 0.9;
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(HISTOGRAM_URL);
    const canvas = page.locator('.chat-empty-histogram-waves');
    await expect.poll(async () => (await pixels(canvas)).colored).toBeGreaterThan(0);
    const initial = await pixels(canvas);
    expect(Math.min(...initial.heights)).toBeGreaterThan(motion.targetY);
    await page.evaluate(() => {
      Math.random = () => 0.1;
    });
    const now = new Date();
    await page.clock.install({ time: now });
    await page.clock.pauseAt(now);
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 246, box.y + motion.from);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.clock.runFor(48);
    await page.mouse.move(box.x + 246, box.y + motion.to);
    const nearY = motion.to + (motion.targetY > motion.to ? 10 : -10);
    let nearAt: number | undefined;
    let targetAt: number | undefined;
    for (let frame = 0; frame < 180 && targetAt === undefined; frame++) {
      await page.clock.runFor(16);
      const rows = await canvas.evaluate((element: HTMLCanvasElement) => {
        const context = element.getContext('2d')!;
        const data = context.getImageData(0, 0, element.width, element.height).data;
        const lit: number[] = [];
        for (let y = 2; y < element.height; y += 4) {
          for (const x of [245, 249]) {
            const index = (y * element.width + x) * 4;
            if (data[index]! > data[index + 1]! && data[index + 1]! > data[index + 2]!) {
              lit.push(y);
              break;
            }
          }
        }
        return lit;
      });
      if (rows.includes(nearY)) nearAt ??= frame;
      if (rows.includes(motion.targetY)) targetAt = frame;
    }
    expect(nearAt).toBeDefined();
    expect(targetAt).toBeDefined();
    expect(targetAt!).toBeGreaterThan(nearAt!);
    await page.screenshot({
      path: test.info().outputPath(`histogram-vertical-${motion.direction}.png`),
    });
    await page.mouse.move(0, 0);
    await page.clock.runFor(15000);
    expect((await pixels(canvas)).heights).toEqual(initial.heights);
    expect((await pixels(canvas)).orange).toBe(0);
  });
}

test('histogram stops drawing at rest, changes no DOM per frame, and respects reduced motion', async ({
  page,
}) => {
  await page.goto(HISTOGRAM_URL);
  const histogram = page.locator('.chat-empty-histogram');
  const canvas = histogram.locator('canvas');
  await expect.poll(async () => (await pixels(canvas)).colored).toBeGreaterThan(0);
  const sampler = await canvas.evaluateHandle((element: HTMLCanvasElement) => {
    const context = element.getContext('2d')!;
    const counts = { draws: 0, mutations: 0 };
    const clear = context.clearRect.bind(context);
    context.clearRect = (...args) => {
      counts.draws++;
      clear(...args);
    };
    const observer = new MutationObserver((records) => {
      counts.mutations += records.length;
    });
    observer.observe(element.parentElement!, { attributes: true, childList: true, subtree: true });
    return {
      counts,
      stop: () => {
        observer.disconnect();
        context.clearRect = clear;
      },
    };
  });
  const sample = async () => {
    const before = await sampler.evaluate((s) => ({ ...s.counts }));
    await canvas.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let frames = 0;
          const tick = () => {
            if (++frames === 12) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        })
    );
    const after = await sampler.evaluate((s) => ({ ...s.counts }));
    return { draws: after.draws - before.draws, mutations: after.mutations - before.mutations };
  };
  try {
    const idle = await sample();
    expect(idle).toEqual({ draws: 0, mutations: 0 });
    await histogram.hover({ position: { x: 80, y: 12 } });
    const active = await sample();
    expect(active.draws).toBeGreaterThan(0);
    expect(active.mutations).toBe(0);
    await expect.poll(async () => (await pixels(canvas)).orange, { timeout: 15000 }).toBe(0);
    const hovered = await sample();
    expect(hovered.draws).toBeGreaterThan(0);
    expect(hovered.mutations).toBe(0);
    await page.mouse.move(0, 0);
    await expect.poll(sample, { timeout: 15000 }).toEqual({ draws: 0, mutations: 0 });
    await histogram.hover({ position: { x: 100, y: 16 } });
    await expect.poll(async () => (await pixels(canvas)).orange).toBeGreaterThan(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(canvas).toBeVisible();
    await expect.poll(sample).toEqual({ draws: 0, mutations: 0 });
    await page.mouse.move(0, 0);
    await histogram.hover({ position: { x: 130, y: 12 } });
    await expect.poll(sample).toEqual({ draws: 0, mutations: 0 });
    const reducedCounts = await sampler.evaluate((s) => ({ ...s.counts }));
    const box = (await histogram.boundingBox())!;
    for (let step = 0; step < 12; step++) {
      await page.mouse.move(box.x + 20 + step * 8, box.y + 20);
    }
    await sample();
    expect(await sampler.evaluate((s) => s.counts)).toEqual(reducedCounts);
    await test.info().attach('histogram-work-counts', {
      body: JSON.stringify({
        environment: 'Chromium E2E harness',
        idle,
        active,
        hovered,
        settled: await sample(),
      }),
      contentType: 'application/json',
    });
  } finally {
    await sampler.evaluate((s) => s.stop());
    await sampler.dispose();
  }
});

test('moving the cursor starts a separate dim-grained wave without interrupting the first', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 800 });
  await page.addInitScript(() => {
    Math.random = () => 0.9;
  });
  await page.goto(HISTOGRAM_URL);
  const canvas = page.locator('.chat-empty-histogram-waves');
  await expect.poll(async () => (await pixels(canvas)).colored).toBeGreaterThan(0);
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  const box = (await canvas.boundingBox())!;
  const sample = () =>
    canvas.evaluate((element: HTMLCanvasElement) => {
      const context = element.getContext('2d')!;
      const data = context.getImageData(0, 0, element.width, element.height).data;
      const counts = { original: 0, moved: 0, gap: 0, dim: 0, bright: 0 };
      for (let y = 2; y < element.height; y += 4) {
        for (let column = 0; column < element.width / 9; column++) {
          for (const lane of [2, 6]) {
            const x = column * 9 + lane;
            if (x >= element.width) continue;
            const index = (y * element.width + x) * 4;
            if (!(data[index]! > data[index + 1]! && data[index + 1]! > data[index + 2]!)) continue;
            if (x < 200) counts.original++;
            if (Math.abs(x - 600) < 100) counts.moved++;
            if (x > 280 && x < 420) counts.gap++;
            if (data[index + 3]! <= 62) counts.dim++;
            else counts.bright++;
          }
        }
      }
      return counts;
    });
  await page.mouse.move(box.x + 42, box.y + 12);
  await page.clock.runFor(320);
  expect((await sample()).original).toBeGreaterThan(0);
  expect((await sample()).moved).toBe(0);
  await page.mouse.move(box.x + 600, box.y + 12);
  await page.clock.runFor(80);
  const separate = await sample();
  expect(separate.original).toBeGreaterThan(0);
  expect(separate.moved).toBeGreaterThan(0);
  expect(separate.gap).toBe(0);
  expect(separate.dim).toBeGreaterThan(separate.bright * 3);
  expect(separate.bright).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath('histogram-separate-waves.png') });
  await page.mouse.move(0, 0);
  await page.clock.runFor(15000);
  expect((await pixels(canvas)).orange).toBe(0);
});

test('the histogram is disabled by default and follows live configuration changes', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');
  await expect(page.locator('.chat-empty-state')).toBeVisible();
  await expect(page.locator('.chat-empty-histogram')).toHaveCount(0);

  for (const enabled of [true, false]) {
    await postWebviewMessage(page, {
      type: 'config/update',
      payload: {
        showEmptyStateHistogram: enabled,
        desktopSessionPaneSide: 'left',
        defaultPermissionMode: 'default',
        chatFontSize: 13,
        chatEditorFontSize: 12,
        chatFontFamily: 'default',
      },
    });
    await expect(page.locator('.chat-empty-histogram')).toHaveCount(enabled ? 1 : 0);
  }
});
