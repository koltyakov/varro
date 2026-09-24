import { expect, test } from '@playwright/test';

for (const history of [false, true]) {
  for (const width of [400, 900]) {
    test(`automatic activity details at ${width}px with history=${history}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `/e2e/harness/index.html?scenario=automatic-messages&history=${history ? 1 : 0}`
      );
      const mixed = page.locator('[data-msg-id="mixed-user"]');
      await expect(mixed.locator('.user-message-card')).toHaveText('Test message');
      await expect(mixed.locator('.assistant-activity-summary')).toContainText(
        '3 automatic actions'
      );
      const owner = page.locator('[data-msg-id="automatic-0"]');
      const summary = owner.locator('.assistant-activity-summary');
      await expect(summary).toContainText('7 automatic actions');
      await expect(page.locator('[data-msg-id^="automatic-"] .user-message-card')).toHaveCount(0);
      await expect(page.locator('.interactive-list')).not.toContainText('Private file contents');
      await expect(page.locator('.interactive-list')).not.toContainText(
        'Continue if you have next steps'
      );
      await expect(page.locator('[data-msg-id="automatic-5"]')).toHaveClass(
        /interactive-item-render-empty/
      );
      const compaction = page.locator('.message-compaction-divider');
      await expect(compaction).toContainText('Context compacted (auto)');
      const compactionBox = await compaction.boundingBox();
      const summaryBox = await summary.boundingBox();
      expect(compactionBox!.y + compactionBox!.height).toBeLessThanOrEqual(summaryBox!.y);

      await summary.click();
      const headers = page.locator('[data-msg-id^="automatic-"] .tool-invocation-header');
      await expect(headers).toHaveCount(9);
      const gaps = await headers.evaluateAll((elements) =>
        elements.slice(1).map((element, index) => {
          const previous = elements[index]!.getBoundingClientRect();
          return element.getBoundingClientRect().top - previous.bottom;
        })
      );
      for (const gap of gaps) {
        expect(gap).toBeGreaterThanOrEqual(0);
        expect(gap).toBeLessThanOrEqual(4);
      }
      const shell = page.locator('[data-msg-id="automatic-5"]');
      await expect(shell).not.toHaveClass(/interactive-item-render-empty/);
      await shell.scrollIntoViewIfNeeded();
      await shell.locator('.tool-invocation-header').click();
      await expect(shell.locator('.tool-invocation-header')).toContainText(
        'Background command finished: npm test'
      );
      await expect(shell.locator('.tool-invocation-detail')).toContainText('Long test output');
      await expect(page.locator('.inline-edit-composer-slot')).toHaveCount(0);

      if (history) {
        const list = page.locator('.interactive-list');
        await list.evaluate((element) => {
          element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
          element.scrollTop = 0;
          element.dispatchEvent(new Event('scroll'));
        });
        await expect(owner).toHaveCount(0);
        await list.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          element.dispatchEvent(new Event('scroll'));
        });
        await expect(shell.locator('.tool-invocation-detail')).toContainText('Long test output');
      }
      await summary.click();
      await expect(shell).toHaveClass(/interactive-item-render-empty/);
      await expect(page.locator('.interactive-list')).not.toContainText('Long test output');
      await page.screenshot({ path: testInfo.outputPath('automatic-activity.png') });
    });
  }
}
