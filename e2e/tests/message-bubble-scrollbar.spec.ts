import { expect, test } from '@playwright/test';

for (const width of [480, 1280]) {
  for (const target of ['message bubble', 'input', 'sticky message']) {
    test(`${target} scrollbar matches chat width and stays dim at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(
        `/e2e/harness/index.html?scenario=${target === 'sticky message' ? 'sticky-preview' : 'tool-cards'}`
      );
      if (target === 'sticky message') {
        await page.locator('.interactive-list').evaluate((element) => {
          const nextPrompt = element.querySelector(
            '[data-msg-id="message-sticky-user-2"] .user-message-card'
          );
          if (!nextPrompt) throw new Error('Next prompt is not mounted');
          element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
          element.scrollTop +=
            nextPrompt.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            element.clientHeight -
            20;
          element.dispatchEvent(new Event('scroll'));
        });
      }
      const scrollArea = page
        .locator(
          target === 'input'
            ? '.rich-composer'
            : target === 'sticky message'
              ? '.latest-user-message-sticky-text'
              : '.user-message-text-scroll'
        )
        .first();
      await expect(scrollArea).toBeVisible();
      const text = Array.from({ length: 50 }, (_, index) => `Prompt line ${index}`).join('\n');
      if (target === 'input') {
        await scrollArea.fill(text);
      } else if (target === 'message bubble') {
        await scrollArea.evaluate((element, content) => {
          element.textContent = content;
          element.style.whiteSpace = 'pre-wrap';
        }, text);
      }
      await page.mouse.move(0, 0);

      const scrollbars = await scrollArea.evaluate((element) => {
        const chat = document.querySelector('.interactive-list');
        if (!chat) throw new Error('Chat scroll container is missing');
        const areaTrack = getComputedStyle(element, '::-webkit-scrollbar');
        const chatTrack = getComputedStyle(chat, '::-webkit-scrollbar');
        const areaThumb = getComputedStyle(element, '::-webkit-scrollbar-thumb');
        const chatThumb = getComputedStyle(chat, '::-webkit-scrollbar-thumb');
        return {
          overflowing: element.scrollHeight > element.clientHeight,
          areaWidth: areaTrack.width,
          chatWidth: chatTrack.width,
          areaBorder: areaThumb.borderLeftWidth,
          chatBorder: chatThumb.borderLeftWidth,
          color: areaThumb.backgroundColor,
        };
      });

      expect(scrollbars.overflowing).toBe(true);
      expect(scrollbars.areaWidth).toBe('10px');
      expect(scrollbars.areaWidth).toBe(scrollbars.chatWidth);
      expect(scrollbars.areaBorder).toBe(scrollbars.chatBorder);
      expect(scrollbars.color).toMatch(/\/ 0\.1\)$/);

      await (
        target === 'sticky message' ? page.locator('.latest-user-message-sticky') : scrollArea
      ).hover();
      const hoverColor = await scrollArea.evaluate(
        (element) => getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor
      );
      expect(hoverColor).toMatch(/\/ 0\.16\)$/);
    });
  }
}
