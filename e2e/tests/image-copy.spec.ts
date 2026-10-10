import { expect, test } from '@playwright/test';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

for (const mime of ['image/png', 'image/jpeg']) {
  test(`copies a full-size ${mime} preview through its context menu`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/e2e/harness/index.html?scenario=blank');
    await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
    await page.getByText('GPT-4.1', { exact: true }).click();
    await expect(page.getByLabel('OpenAI / GPT-4.1')).toBeVisible();
    await page.evaluate((type) => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');
      context.fillStyle = 'red';
      context.fillRect(0, 0, 160, 180);
      const url = canvas.toDataURL(type);
      window.postMessage(
        {
          type: 'composer/images-sync',
          payload: {
            images: [
              {
                id: 'copy-image',
                filename: 'Image 1',
                mime: type,
                url,
                size: atob(url.split(',')[1]!).length,
              },
            ],
          },
        },
        '*'
      );
    }, mime);

    const chip = page.locator('.chat-attachment-chip').filter({ hasText: 'Image 1' });
    await expect(chip).toHaveClass(/clickable/);
    await chip.click();
    const preview = page.locator('.chat-image-preview-img');
    await expect(preview).toBeVisible();
    await expect
      .poll(() => preview.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBe(320);
    await preview.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Image actions' });
    await expect(menu.getByRole('menuitem', { name: 'Copy image' })).toBeEnabled();
    await menu.getByRole('menuitem', { name: 'Copy image' }).click();
    await expect(menu).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Image copied' })).toBeVisible();
    await expect(preview).toBeVisible();

    const copied = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const item = items.find((value) => value.types.includes('image/png'));
      if (!item) throw new Error('Clipboard does not contain an image');
      const bitmap = await createImageBitmap(await item.getType('image/png'));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return {
        width: canvas.width,
        height: canvas.height,
        red: Array.from(context.getImageData(10, 10, 1, 1).data),
        transparent: Array.from(context.getImageData(300, 10, 1, 1).data),
      };
    });
    expect(copied.width).toBe(320);
    expect(copied.height).toBe(180);
    expect(copied.red[0]).toBeGreaterThanOrEqual(250);
    expect(copied.red[1]).toBeLessThanOrEqual(5);
    expect(copied.red[2]).toBeLessThanOrEqual(5);
    expect(copied.red[3]).toBe(255);
    if (mime === 'image/png') expect(copied.transparent[3]).toBe(0);
    expect(errors).toEqual([]);
  });
}
