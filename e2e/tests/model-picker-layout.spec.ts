import { expect, test } from '@playwright/test';

for (const width of [280, 420, 1000]) {
  test(`uses pinned model row space at ${width}px without hidden provider or checkmark gaps`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/e2e/harness/index.html?scenario=model-search');
    await expect(page.locator('.model-picker-btn')).toBeVisible();
    await page.evaluate(() => {
      localStorage.setItem(
        'varro.pinnedModels',
        JSON.stringify(['copilot:gpt-5-mini', 'openai:gpt-4o'])
      );
      localStorage.setItem(
        'varro.modelDisplayNames',
        JSON.stringify({
          'copilot:gpt-5-mini': 'Very Long Selected Model Name That Needs Ellipsis',
          'openai:gpt-4o': 'Very Long Unselected Model Name That Needs Ellipsis',
        })
      );
    });
    await page.reload();
    await page.locator('.model-picker-btn').click();
    await page.getByLabel('Search models').focus();
    await page.mouse.move(0, 0);

    const rows = page.locator('.model-picker-row.pinned');
    await expect(rows).toHaveCount(2);
    for (const selected of [false, true]) {
      const row = rows.filter({
        has: page.locator(selected ? '[data-model-id="gpt-5-mini"]' : '[data-model-id="gpt-4o"]'),
      });
      const provider = row.locator('.model-picker-provider-name');
      const name = row.locator('.dropdown-name');
      const check = row.locator('.dropdown-check');
      await expect(provider).toBeHidden();
      await expect(check).toHaveCount(selected ? 1 : 0);

      const idle = await row.evaluate((element) => {
        const wrap = element.querySelector<HTMLElement>('.dropdown-name-wrap')!;
        const nameElement = element.querySelector<HTMLElement>('.dropdown-name')!;
        const checkElement = element.querySelector<HTMLElement>('.dropdown-check');
        const box = nameElement.getBoundingClientRect();
        const gap = Number.parseFloat(getComputedStyle(wrap).gap);
        return {
          width: box.width,
          unusedSpace: wrap.getBoundingClientRect().right - box.right,
          checkSpace: checkElement ? checkElement.getBoundingClientRect().width + gap : 0,
          truncated: nameElement.scrollWidth > nameElement.clientWidth,
        };
      });
      expect(idle.truncated).toBe(true);
      expect(Math.abs(idle.unusedSpace - idle.checkSpace)).toBeLessThanOrEqual(1);

      await name.hover();
      await expect(provider).toBeVisible();
      await expect(check).toHaveCount(selected ? 1 : 0);
      const hovered = await name.boundingBox();
      expect(hovered!.width).toBeLessThan(idle.width);
      const providerBox = await provider.boundingBox();
      expect(providerBox!.x).toBeGreaterThanOrEqual(hovered!.x + hovered!.width);
      if (selected) {
        const checkBox = await check.boundingBox();
        expect(checkBox!.x).toBeGreaterThanOrEqual(providerBox!.x + providerBox!.width);
      }

      await page.mouse.move(0, 0);
      await expect(provider).toBeHidden();
      await row.locator('.model-picker-item').focus();
      await expect(provider).toBeVisible();
      await page.getByLabel('Search models').focus();
      await expect(provider).toBeHidden();
    }
  });
}
