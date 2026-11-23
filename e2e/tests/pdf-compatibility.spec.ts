import { expect, test } from '@playwright/test';
import { nativePdfFixture } from '../../src/shared/native-pdf.test-support';
import { postWebviewMessage } from './helpers';

for (const width of [380, 1280]) {
  test(`PDFs with unknown model support remain in the draft at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/e2e/harness/index.html?scenario=blank');
    const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
    await composer.fill('Keep my PDF draft');
    await postWebviewMessage(page, { type: 'pdfs/picked', payload: [nativePdfFixture()] });
    const chip = page.locator('.chat-attachment-chip').filter({ hasText: 'text.pdf' });
    await expect(chip).toContainText('PDF');
    await expect(page.getByLabel('Send (Enter)', { exact: true })).toBeDisabled();
    await composer.press('Enter');
    await expect(
      page.getByText('PDF input support is unknown for the selected model or backend.', {
        exact: false,
      })
    ).toBeVisible();
    await expect(composer).toHaveText('Keep my PDF draft');
    await expect(chip).toBeVisible();
    const promptCount = await page.evaluate(() => {
      // SAFETY: This hook is installed by the controlled E2E harness.
      const harness = window as Window & { __varroE2E?: { requests: Array<{ path: string }> } };
      return harness.__varroE2E?.requests.filter(({ path }) =>
        /\/(prompt_async|prompt)(\?|$)/.test(path)
      ).length;
    });
    expect(promptCount).toBe(0);
    await chip.getByRole('button').last().click();
    await expect(chip).toHaveCount(0);
    await expect(page.getByLabel('Send (Enter)', { exact: true })).toBeEnabled();
  });
}
