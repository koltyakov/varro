import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ExtensionMessage, ProviderLimitWindow } from '../../src/shared/protocol';

async function updateQuota(page: Page, windows: ProviderLimitWindow[]) {
  const message: ExtensionMessage = {
    type: 'provider-limit/updated',
    payload: {
      directory: '/workspace/varro',
      status: {
        providerID: 'copilot',
        modelID: 'gpt-5-mini',
        status: 'available',
        source: 'provider',
        checkedAt: Date.now(),
        windows,
      },
    },
  };
  await page.evaluate(
    (data) => window.dispatchEvent(new MessageEvent('message', { data })),
    message
  );
}

for (const theme of ['dark', 'light']) {
  for (const width of [320, 480]) {
    test(`quota warning fits ${width}px ${theme} composer and persists dismissal`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/e2e/harness/index.html?scenario=blank&theme=${theme}`);
      await expect(page.locator('.rich-composer')).toBeVisible();
      const weekly: ProviderLimitWindow = {
        id: 'seven_day',
        label: 'Weekly limit',
        unit: 'unknown',
        remaining: 8,
        limit: 100,
        resetAt: Date.now() + 76 * 60 * 60_000,
      };
      const fiveHour: ProviderLimitWindow = {
        id: 'five_hour',
        label: '5-hour limit',
        unit: 'unknown',
        remaining: 90,
        limit: 100,
        resetAt: Date.now() + 32 * 60_000,
      };
      await updateQuota(page, [fiveHour, weekly]);
      const warning = page.locator('.chat-quota-warning');
      await expect(warning).toContainText('Weekly limit: 8% left');
      await expect(warning).not.toContainText('5-hour limit');
      if (width === 480) {
        const copyBox = await warning.locator('.chat-quota-warning-copy').boundingBox();
        const actionsBox = await warning.locator('.chat-quota-warning-actions').boundingBox();
        expect(
          Math.abs(copyBox!.y + copyBox!.height / 2 - (actionsBox!.y + actionsBox!.height / 2))
        ).toBeLessThanOrEqual(1);
      }

      fiveHour.remaining = 15;
      await updateQuota(page, [fiveHour, weekly]);
      await expect(warning.locator('.chat-quota-warning-row')).toHaveCount(2);
      const warningBox = await warning.boundingBox();
      const composerBox = await page.locator('.chat-input-container').boundingBox();
      expect(warningBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect(warningBox!.x).toBeGreaterThanOrEqual(0);
      expect(warningBox!.x + warningBox!.width).toBeLessThanOrEqual(width);
      expect(warningBox!.y + warningBox!.height).toBeGreaterThanOrEqual(composerBox!.y);
      for (const content of ['.chat-quota-warning-copy', '.chat-quota-warning-actions']) {
        const contentBox = await warning.locator(content).boundingBox();
        expect(contentBox!.y + contentBox!.height).toBeLessThanOrEqual(composerBox!.y);
      }
      expect(await warning.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true
      );
      await page
        .locator('.interactive-input-part')
        .screenshot({ path: testInfo.outputPath('quota-warning.png') });

      const usage = warning.getByRole('link', { name: 'View usage' });
      await expect(usage).toHaveAttribute('href', 'https://github.com/settings/billing');
      await page.evaluate(() => {
        // Mirror VS Code's window-level link opener, which ignores defaultPrevented.
        window.addEventListener('click', (event) => {
          if (!event.isTrusted) return;
          const link = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
          if (!link?.href) return;
          // SAFETY: The controlled E2E harness records external navigation requests here.
          const harness = window as Window & { __varroE2E?: { externalUrls: string[] } };
          harness.__varroE2E?.externalUrls.push(link.href);
        });
      });
      await usage.click();
      await expect(warning.locator('.provider-limit-popup')).toHaveCount(0);
      expect(
        await page.evaluate(() => {
          // SAFETY: The controlled E2E harness records external navigation requests on this global.
          const harness = window as Window & { __varroE2E?: { externalUrls: string[] } };
          return harness.__varroE2E?.externalUrls;
        })
      ).toEqual(['https://github.com/settings/billing']);
      await usage.focus();
      await page.keyboard.press('Enter');
      expect(
        await page.evaluate(() => {
          // SAFETY: The controlled E2E harness records external navigation requests here.
          const harness = window as Window & { __varroE2E?: { externalUrls: string[] } };
          return harness.__varroE2E?.externalUrls;
        })
      ).toEqual(['https://github.com/settings/billing', 'https://github.com/settings/billing']);
      await warning.getByRole('button', { name: /Dismiss .* quota warning/ }).click();
      await expect(warning).toHaveCount(0);

      await page.reload();
      await expect(page.locator('.rich-composer')).toBeVisible();
      await updateQuota(page, [fiveHour, weekly]);
      await expect(warning).toHaveCount(0);
      fiveHour.resetAt = Date.now() + 5 * 60 * 60_000;
      await updateQuota(page, [fiveHour, weekly]);
      await expect(warning).toContainText('5-hour limit: 15% left');
      await expect(warning).not.toContainText('Weekly limit');
    });
  }
}
