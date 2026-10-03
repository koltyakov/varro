import { expect, test } from '@playwright/test';

const variants = [
  { id: 'plain', surface: '.user-message-card', wrapperless: false },
  { id: 'pasted', surface: '.message-attachment-visible .chat-attachment-chip', wrapperless: true },
  { id: 'terminal', surface: '.user-message-terminal-code-block', wrapperless: true },
  { id: 'image', surface: '.chat-image-figure', wrapperless: true },
  { id: 'image-text', surface: '.user-message-image-text-bubble', wrapperless: true },
  { id: 'agent', surface: '.agent-attachment-chip', wrapperless: true },
];

for (const variant of variants) {
  test(`sticky navigation highlights the visible ${variant.id} prompt without painting its wrapper`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 486, height: 800 });
    await page.goto('/e2e/harness/index.html?scenario=sticky-preview-render-variants');

    const messageId = `message-sticky-variant-${variant.id}-user`;
    const card = page.locator(`[data-msg-id="${messageId}"] .user-message-card`);
    const surface = page.locator(`[data-msg-id="${messageId}"] ${variant.surface}`).first();
    await expect(card).toBeAttached();
    const original = await surface.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        radius: style.borderRadius,
        shadow: style.boxShadow,
        width: rect.width,
        height: rect.height,
      };
    });
    const originalWrapper = await card.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        border: style.borderTopColor,
        shadow: style.boxShadow,
      };
    });

    await card.evaluate((element) => {
      const list = document.querySelector('.interactive-list');
      if (!list) throw new Error('Transcript missing');
      list.scrollTop +=
        element.getBoundingClientRect().bottom - list.getBoundingClientRect().top + 8;
      list.dispatchEvent(new Event('scroll'));
    });
    const sticky = page.locator(
      `.latest-user-message-sticky-overlay[data-sticky-msg-id="${messageId}"] .latest-user-message-sticky`
    );
    await expect(sticky).toBeVisible();
    await sticky.click();
    await expect(card).toHaveClass(/turn-navigation-destination/);

    const samples = await card.evaluate(async (element, surfaceSelector) => {
      const highlightedElement = element.matches(surfaceSelector)
        ? element
        : element.querySelector(surfaceSelector);
      if (!highlightedElement) throw new Error('Highlight surface missing');
      const frameSamples = [];
      for (let frame = 0; frame < 60; frame += 1) {
        const style = getComputedStyle(element);
        const surfaceStyle = getComputedStyle(highlightedElement);
        const rect = highlightedElement.getBoundingClientRect();
        frameSamples.push({
          wrapperBackground: style.backgroundColor,
          wrapperShadow: style.boxShadow,
          wrapperBorder: style.borderTopColor,
          shadow: surfaceStyle.boxShadow,
          radius: surfaceStyle.borderRadius,
          width: rect.width,
          height: rect.height,
        });
        if (!element.classList.contains('turn-navigation-destination')) break;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return frameSamples;
    }, variant.surface);

    expect(samples.length).toBeGreaterThan(1);
    for (const sample of samples) {
      expect(sample.radius).toBe(original.radius);
      expect(sample.width).toBeCloseTo(original.width, 1);
      expect(sample.height).toBeCloseTo(original.height, 1);
      if (variant.wrapperless) {
        expect(sample.wrapperBackground).toBe(originalWrapper.background);
        expect(sample.wrapperBorder).toBe(originalWrapper.border);
        expect(sample.wrapperShadow).toBe(originalWrapper.shadow);
      }
    }
    expect(samples.some((sample) => sample.shadow !== original.shadow)).toBe(true);
    await expect(card).not.toHaveClass(/turn-navigation-destination/);
    await page.mouse.move(0, 0);
    await expect(surface).toHaveCSS('box-shadow', original.shadow);
  });
}
