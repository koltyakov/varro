import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function samplePixels(
  page: Page,
  imageBuffer: Buffer,
  samplePoints: { x: number; y: number }[]
) {
  return page.evaluate(
    async ({ imageData, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${imageData}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Pixel context is missing');
      context.drawImage(image, 0, 0);
      return points.map(({ x, y }) =>
        [...context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data].slice(0, 3)
      );
    },
    { imageData: imageBuffer.toString('base64'), points: samplePoints }
  );
}

for (const theme of ['dark', 'light']) {
  for (const width of [820, 1662]) {
    test(`${theme} ${width}px reselect band sweeps across sticky layers and the composer`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1100 });
      await page.goto(`/e2e/harness/index.html?scenario=sticky-preview&theme=${theme}`);
      const list = page.locator('.interactive-list');
      await list.evaluate((element) => {
        const nextPrompt = element.querySelector('[data-msg-id="message-sticky-user-2"]');
        if (!nextPrompt) throw new Error('Next prompt is missing');
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
        element.scrollTop +=
          nextPrompt.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          element.clientHeight -
          20;
        element.dispatchEvent(new Event('scroll'));
      });
      await expect(page.locator('.latest-user-message-sticky')).toBeVisible();
      await page.evaluate(() => document.documentElement.classList.add('varro-editor-surface'));
      const shell = page.locator('.chat-main-shell');
      const before = await list.evaluate((element) => element.scrollTop);
      const geometry = await shell.evaluate((element) => {
        const rect = (selector: string) => {
          const target = element.querySelector(selector);
          if (!target) throw new Error(`Missing sweep layer: ${selector}`);
          return target.getBoundingClientRect();
        };
        const box = element.getBoundingClientRect();
        const content = rect('.chat-main-column-shell');
        const header = element.querySelector('.chat-header-chat-desktop')?.getBoundingClientRect();
        const listBox = rect('.interactive-list');
        const top = rect('.latest-user-message-sticky-top');
        const solid = rect('.latest-user-message-sticky-bottom-solid');
        const fade = rect('.interactive-list-bottom-fade-gradient');
        const composer = rect('.chat-input-container');
        return {
          top: content.top,
          height: box.bottom - content.top,
          points: [
            { name: 'sticky-top', x: top.left + top.width / 2, y: top.top + top.height / 2 },
            {
              name: 'sticky-bottom',
              x: solid.left + solid.width / 2,
              y: solid.top + solid.height / 2,
            },
            { name: 'transcript', x: listBox.left + 3, y: listBox.top + listBox.height / 2 },
            { name: 'composer-fade', x: listBox.left + 3, y: fade.bottom - 2 },
            { name: 'composer', x: composer.left + composer.width / 2, y: composer.top + 5 },
            ...(header && header.height > 0
              ? [{ name: 'header', x: header.left + 5, y: header.top + header.height / 2 }]
              : []),
          ],
        };
      });
      const resting = await samplePixels(page, await page.screenshot(), geometry.points);
      if (width >= 1400) {
        await page.locator('.session-item.active .session-item-main').click();
      } else {
        await page.evaluate(() => window.postMessage({ type: 'command/highlight-session' }, '*'));
      }
      await expect(shell).toHaveClass(/active-session-reselected/);
      for (const [index, point] of geometry.points.entries()) {
        if (point.name === 'header') continue;
        // A 30%-height band travels from -45% to 145% background-position.
        const progress = ((point.y - geometry.top) / geometry.height + 0.165) / 1.33;
        await shell.evaluate((element, fraction) => {
          const animation = element
            .getAnimations({ subtree: true })
            .find(
              (item) =>
                item instanceof CSSAnimation && item.animationName === 'active-session-reselected'
            );
          if (!animation) throw new Error('Reselect animation is missing');
          animation.pause();
          animation.currentTime = Number(animation.effect!.getTiming().duration) * fraction;
        }, progress);
        const image = await page.screenshot({
          path: testInfo.outputPath(`sweep-${point.name}.png`),
        });
        const pixels = await samplePixels(page, image, geometry.points);
        for (let channel = 0; channel < 3; channel += 1) {
          const change = pixels[index]![channel]! - resting[index]![channel]!;
          expect(
            theme === 'dark' ? change : -change,
            `${point.name} receives the band`
          ).toBeGreaterThan(5);
        }
        // Distant layers stay at rest instead of flashing the entire panel at once.
        for (const [otherIndex, other] of geometry.points.entries()) {
          if (other.name !== 'header' && Math.abs(other.y - point.y) < geometry.height * 0.3)
            continue;
          for (let channel = 0; channel < 3; channel += 1) {
            expect(
              Math.abs(pixels[otherIndex]![channel]! - resting[otherIndex]![channel]!),
              other.name
            ).toBeLessThanOrEqual(1);
          }
        }
      }
      expect(await list.evaluate((element) => element.scrollTop)).toBe(before);
      await shell.evaluate(async (element) => {
        const animation = element
          .getAnimations({ subtree: true })
          .find(
            (item) =>
              item instanceof CSSAnimation && item.animationName === 'active-session-reselected'
          );
        if (!animation) throw new Error('Paused reselect animation is missing');
        animation.play();
        await animation.finished;
      });
      await expect(shell).not.toHaveClass(/active-session-reselected/);
    });
  }
}
