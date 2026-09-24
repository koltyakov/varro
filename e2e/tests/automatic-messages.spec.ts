import { expect, test } from '@playwright/test';

for (const history of [false, true]) {
  for (const width of [400, 900]) {
    test(`automatic action notices at ${width}px with history=${history}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `/e2e/harness/index.html?scenario=automatic-messages&history=${history ? 1 : 0}`
      );
      const actions = page.locator('.automated-message');
      await expect(actions).toHaveText([
        'Added file context',
        'Added skill instructions',
        'Continued after context compaction',
        'Continued after subagent task',
        'Started approved plan',
        'Resumed after interruption',
        'Loaded agent instructions',
        'Background command finished',
        'Added automatic context',
      ]);
      const mixed = page.locator('[data-msg-id="mixed-user"]');
      await expect(mixed.locator('.user-message-card')).toHaveText('Test message');
      await expect(page.locator('[data-msg-id^="automatic-"] .user-message-card')).toHaveCount(0);
      await expect(page.locator('.interactive-list')).not.toContainText('Private file contents');
      await expect(page.locator('.interactive-list')).not.toContainText(
        'Continue if you have next steps'
      );
      const compaction = page.locator('.message-compaction-divider');
      await expect(compaction).toContainText('Context compacted (auto)');
      const compactionBox = await compaction.boundingBox();
      const continuationBox = await page
        .locator('[data-msg-id="automatic-0"] .automated-message')
        .boundingBox();
      expect(compactionBox).not.toBeNull();
      expect(continuationBox).not.toBeNull();
      expect(compactionBox!.y + compactionBox!.height).toBeLessThanOrEqual(continuationBox!.y);
      const geometry = await actions.first().evaluate((element) => {
        const row = element.closest('[data-msg-id]')!;
        const style = getComputedStyle(element);
        return {
          height: element.getBoundingClientRect().height,
          left: element.getBoundingClientRect().left - row.getBoundingClientRect().left,
          background: style.backgroundColor,
          border: style.borderTopWidth,
        };
      });
      expect(geometry.height).toBeGreaterThan(0);
      expect(geometry.height).toBeLessThan(40);
      expect(geometry.left).toBeLessThan(30);
      expect(geometry.background).toBe('rgba(0, 0, 0, 0)');
      expect(geometry.border).toBe('0px');
      await actions.nth(2).click();
      await expect(page.locator('.inline-edit-composer-slot')).toHaveCount(0);
      if (history) {
        const list = page.locator('.interactive-list');
        await list.evaluate((element) => {
          element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
          element.scrollTop = 0;
          element.dispatchEvent(new Event('scroll'));
        });
        await expect(page.locator('[data-msg-id="automatic-0"]')).toHaveCount(0);
        await list.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          element.dispatchEvent(new Event('scroll'));
        });
        await expect(page.locator('[data-msg-id="automatic-0"] .automated-message')).toHaveText(
          'Continued after context compaction'
        );
        await expect(page.locator('[data-msg-id="automatic-0"]')).not.toHaveClass(
          /interactive-item-render-empty/
        );
      }
      await page.screenshot({ path: testInfo.outputPath('automatic-action-notices.png') });
    });
  }
}
