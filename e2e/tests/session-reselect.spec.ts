/* oxlint-disable unicorn/consistent-function-scoping -- Pixel probes must stay inside the serialized browser callback. */
import { expect, test } from '@playwright/test';

for (const theme of ['dark', 'light']) {
  test(`${theme} reselect pulse keeps sticky and composer fades seamless`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 820, height: 1100 });
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
    const restingColor = await shell.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    );
    const before = await list.evaluate((element) => element.scrollTop);
    await page.evaluate(() => window.postMessage({ type: 'command/highlight-session' }, '*'));
    await expect(shell).toHaveClass(/active-session-reselected/);
    await shell.evaluate((element) => {
      const animation = element
        .getAnimations()
        .find(
          (item) =>
            item instanceof CSSAnimation && item.animationName === 'active-session-reselected'
        );
      if (!animation) throw new Error('Reselect animation is missing');
      animation.pause();
      animation.currentTime = 180;
    });
    await expect(shell).not.toHaveCSS('background-color', restingColor);

    const screenshot = await page.screenshot({ path: testInfo.outputPath('pulse-peak.png') });
    const pixels = await page.evaluate(async (imageData) => {
      const image = new Image();
      image.src = `data:image/png;base64,${imageData}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Pixel context is missing');
      context.drawImage(image, 0, 0);
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing pulse layer: ${selector}`);
        return element.getBoundingClientRect();
      };
      const sample = (x: number, y: number) =>
        [...context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data].slice(0, 3);
      const listBox = rect('.interactive-list');
      const top = rect('.latest-user-message-sticky-top');
      const solid = rect('.latest-user-message-sticky-bottom-solid');
      const fade = rect('.interactive-list-bottom-fade-gradient');
      const x = listBox.left + 3;
      return {
        background: sample(x, listBox.top + listBox.height / 2),
        stickyTop: sample(top.left + top.width / 2, top.top + top.height / 2),
        stickyBottom: sample(solid.left + solid.width / 2, solid.top + solid.height / 2),
        composerFade: sample(x, fade.bottom - 2),
      };
    }, screenshot.toString('base64'));

    for (const [layer, color] of Object.entries(pixels)) {
      for (let channel = 0; channel < 3; channel += 1) {
        expect(
          Math.abs(color[channel]! - pixels.background[channel]!),
          `${layer}: ${JSON.stringify(pixels)}`
        ).toBeLessThanOrEqual(1);
      }
    }
    expect(await list.evaluate((element) => element.scrollTop)).toBe(before);
    await shell.evaluate(async (element) => {
      const animation = element.getAnimations()[0];
      if (!animation) throw new Error('Paused reselect animation is missing');
      animation.play();
      await animation.finished;
    });
    await expect(shell).toHaveCSS('background-color', restingColor);
  });
}
