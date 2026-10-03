import { expect, test } from '@playwright/test';

for (const { platform, userAgent } of [
  {
    platform: 'Windows',
    userAgent: 'Windows NT 10.0; Win64; x64',
  },
  {
    platform: 'macOS',
    userAgent: 'Macintosh; Intel Mac OS X 10_15_7',
  },
  { platform: 'Linux', userAgent: 'X11; Linux x86_64' },
]) {
  test.describe(`${platform} turn counter modifier`, () => {
    test.use({ userAgent });

    test('supports repeated holds without refocusing the composer', async ({ page }) => {
      await page.goto('/e2e/harness/index.html?scenario=message-rendering');
      const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
      await composer.fill('Keep this draft');
      await page.keyboard.down('Control');
      await expect(page.locator('.prompt-number-badge')).toHaveCount(0);
      await composer.hover();
      await expect(page.locator('.prompt-number-badge')).toHaveCount(0);
      await page.keyboard.up('Control');
      await expect(page.locator('.prompt-number-badge')).toHaveCount(0);

      for (let hold = 0; hold < 3; hold += 1) {
        await page.keyboard.down('Alt');
        await expect(page.locator('.user-message-card .prompt-number-badge').first()).toHaveText(
          '1'
        );
        await expect(composer).toBeFocused();
        await page.keyboard.up('Alt');
        await expect(page.locator('.prompt-number-badge')).toHaveCount(0);
        await expect(composer).toBeFocused();
        await expect(composer).toHaveText('Keep this draft');
      }
    });
  });
}
