import { expect, test } from '@playwright/test';
import type { ClipboardImage } from '../../src/webview/lib/app-state-types';

for (const switchBeforeNewChat of [false, true]) {
  test(`pending image recovers after New Chat, vision switch first=${switchBeforeNewChat}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    let releaseImage: (() => void) | undefined;
    const imageReady = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    let imageRequested = false;
    await page.route('**/carried-image.gif', async (route) => {
      imageRequested = true;
      await imageReady;
      await route.fulfill({
        contentType: 'image/gif',
        body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
      });
    });

    try {
      await page.goto('/e2e/harness/index.html?scenario=busy-stop-send');
      await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
      await page.getByRole('button', { name: 'GLM 5.1', exact: true }).click();
      await page.locator('.rich-composer').first().fill('Describe the carried image');
      await page.evaluate(async () => {
        const path = '/src/webview/lib/state.ts';
        // SAFETY: Vite serves this attachment module from the isolated E2E harness.
        const { addClipboardImage } = (await import(path)) as {
          addClipboardImage(image: ClipboardImage): boolean;
        };
        addClipboardImage({
          id: 'pending-carried-image',
          filename: 'Image 1',
          mime: 'image/gif',
          size: 42,
          url: `${location.origin}/carried-image.gif`,
        });
      });
      await expect.poll(() => imageRequested).toBe(true);
      const imageChip = page.locator('.chat-attachment-chip').filter({ hasText: 'Image 1' });
      await expect(imageChip).toBeVisible();
      await expect(imageChip).not.toHaveClass(/clickable/);

      const selectVision = async () => {
        await page.locator('.model-picker-btn').click();
        await page.getByRole('button', { name: 'GPT-4.1', exact: true }).click();
      };
      if (switchBeforeNewChat) await selectVision();
      await page.getByRole('button', { name: 'New chat', exact: true }).first().click();
      if (!switchBeforeNewChat) await selectVision();
      await expect(page.locator('.chat-header-title-text').first()).toHaveText('New Chat');
      await expect(page.getByLabel('Send (Enter)', { exact: true })).toBeDisabled();
      releaseImage?.();

      await expect(imageChip).toHaveClass(/clickable/);
      await expect(page.getByLabel('Send (Enter)', { exact: true })).toBeEnabled();
      await imageChip.click();
      await expect(page.locator('.chat-image-preview-overlay')).toBeVisible();
      await expect
        .poll(() =>
          page.locator('.chat-image-preview-overlay img').evaluate((element) => {
            if (!(element instanceof HTMLImageElement)) throw new Error('Expected preview image');
            return element.complete && element.naturalWidth > 0;
          })
        )
        .toBe(true);
      expect(errors).toEqual([]);
    } finally {
      releaseImage?.();
    }
  });
}
