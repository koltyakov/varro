import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { waitForAnimationFrames, waitForHarnessStartup } from './helpers';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

async function copyImage(page: Page, color: string) {
  await page.evaluate(async (fill) => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas context unavailable');
    context.fillStyle = fill;
    context.fillRect(0, 0, 2, 2);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((image) => {
        if (image) resolve(image);
        else reject(new Error('Image encoding failed'));
      }, 'image/png');
    });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }, color);
}

test('clicking the attachment row takes focus and keeps pasted images out of the draft', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');
  await waitForHarnessStartup(page);
  const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
  await composer.click();
  await copyImage(page, 'red');
  await page.keyboard.press('ControlOrMeta+v');

  const row = page.getByRole('group', { name: 'Attachments', exact: true });
  const chips = row.locator('.chat-attachment-chip');
  await expect(chips).toHaveCount(1);
  await composer.fill('Existing draft');
  const frame = page.locator('.chat-input-container');
  await waitForAnimationFrames(page, 20);
  const focusedBorder = await frame.evaluate((element) => getComputedStyle(element).borderColor);

  const bounds = await row.boundingBox();
  if (!bounds) throw new Error('Expected attachment row bounds');
  await row.click({ position: { x: bounds.width - 4, y: bounds.height / 2 } });
  await expect(row).toBeFocused();
  await expect(frame).toHaveCSS('border-color', focusedBorder);

  for (const [index, color] of ['green', 'blue'].entries()) {
    await copyImage(page, color);
    if (index === 0) {
      await page.keyboard.press('ControlOrMeta+v');
    } else {
      // Reproduce VS Code's retained-selection target. Browser-only Chromium
      // does not grant Electron's execCommand('paste') privilege.
      await page.evaluate(async () => {
        const clipboardData = new DataTransfer();
        for (const item of await navigator.clipboard.read()) {
          for (const type of item.types.filter((mimeType) => mimeType.startsWith('image/'))) {
            clipboardData.items.add(new File([await item.getType(type)], 'image.png', { type }));
          }
        }
        const staleTarget = document.querySelector('.rich-composer');
        if (!staleTarget) throw new Error('Expected retained composer target');
        staleTarget.dispatchEvent(
          new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
        );
      });
    }
    await expect(chips).toHaveCount(index + 2);
    await expect(composer).toHaveText('Existing draft');
    await expect(composer.locator('.inline-chip')).toHaveCount(0);
    await expect(row).toBeFocused();
  }

  await composer.click();
  await composer.press('End');
  await copyImage(page, 'yellow');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(composer).toContainText('Image 4');
  await expect(composer.locator('.inline-chip')).toHaveCount(1);
  await expect(chips).toHaveCount(3);
  await expect(composer).toBeFocused();
});
