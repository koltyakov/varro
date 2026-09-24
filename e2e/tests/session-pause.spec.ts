import { expect, test } from '@playwright/test';
import type { ExtensionMessage } from '../../src/shared/protocol';

for (const width of [486, 900]) {
  test(`pause divider resumes a virtualized session at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const composer = page.locator('.rich-composer');
    await expect(composer).toBeVisible();
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'server/status',
            payload: { state: 'running', url: 'mock://opencode', apiVersion: 2 },
          } satisfies ExtensionMessage,
        })
      );
    });
    await composer.fill('/pause');
    await composer.press('Enter');
    const divider = page.locator('.session-pause-divider');
    await expect(divider).toHaveCount(1);
    await expect(divider.locator('.model-change-label')).toHaveText('Paused');
    const resume = divider.getByRole('button', { name: 'Resume', exact: true });
    await expect(resume).toHaveText('');
    await expect(resume.locator('.ui-icon')).toHaveCount(1);
    await expect(divider).toHaveClass(/assistant-dialog-summary/);
    await expect(divider.getByRole('button', { name: 'Copy final response' })).toHaveCount(0);
    await expect
      .poll(() =>
        page
          .locator('.interactive-list')
          .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
      )
      .toBeLessThanOrEqual(2);
    await page.mouse.move(0, 0);
    await expect(resume).toHaveCSS('opacity', '0');
    const initialHeight = await divider.evaluate(
      (element) => element.getBoundingClientRect().height
    );
    await divider.hover();
    await expect(resume).toHaveCSS('opacity', '1');
    expect(await divider.evaluate((element) => element.getBoundingClientRect().height)).toBe(
      initialHeight
    );
    await page.mouse.move(0, 0);
    await resume.focus();
    await expect(resume).toHaveCSS('opacity', '1');
    await composer.fill('Keep this draft');
    await divider.hover();
    await resume.click();
    await expect(divider.locator('.model-change-label')).toHaveText('Paused and resumed');
    await expect(divider.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
    await expect(divider.getByRole('button', { name: 'Fork chat from here' })).toHaveCount(1);
    await expect(composer).toHaveText('Keep this draft');
    expect(await divider.evaluate((element) => element.getBoundingClientRect().height)).toBe(
      initialHeight
    );
  });
}
