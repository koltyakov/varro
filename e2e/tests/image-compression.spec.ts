import { expect, test } from '@playwright/test';

test('compresses a real pasted PNG, restores it and sends the smaller image', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');
  await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
  await page.getByText('GPT-4.1', { exact: true }).click();
  await expect(page.getByLabel('OpenAI / GPT-4.1')).toBeVisible();
  const composer = page.locator('.rich-composer').first();
  await composer.fill('Describe ');
  await composer.evaluate(async (node) => {
    const canvas = document.createElement('canvas');
    canvas.width = 3000;
    canvas.height = 1500;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    const pixels = context.createImageData(canvas.width, canvas.height);
    let seed = 17;
    for (let index = 0; index < pixels.data.length; index += 4) {
      if (index % 8 === 0) seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = seed >>> 24;
      pixels.data[index + 3] = index === 0 ? 0 : 255;
    }
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('PNG encoding failed'))),
        'image/png'
      )
    );
    if (blob.size > 5 * 1024 * 1024)
      throw new Error(`Test PNG exceeds attachment limit: ${blob.size}`);
    if (!node.isConnected) throw new Error('Composer detached before paste');
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([blob], 'clipboard.png', { type: 'image/png' }));
    node.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard })
    );
  });
  const indicator = page.locator('.chip-image-size').first();
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveAttribute('title', /Large image · .* MB · Right-click/);
  await expect(indicator).not.toHaveAttribute('role', 'button');
  const chip = page.locator('.inline-chip[data-chip-type="image"]').first();
  await expect(chip).toHaveClass(/image-size-warning/);
  await chip.hover();
  const preview = page.locator('.chat-attachment-image-preview img');
  await expect(preview).toBeVisible();
  const originalUrl = await preview.getAttribute('src');

  await page.setViewportSize({ width: 380, height: 650 });
  await chip.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Compress image' });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('2048 × 1024');
  await expect(menu).toContainText(/Current image: 3000 × 1500 · .* MB/);
  await expect(menu.getByRole('menuitem', { name: /^Recommended/ })).toContainText(
    /2048 × 1024 · .* (KB|MB) \(\d+% smaller\)/
  );
  await expect(menu.getByRole('menuitem', { name: /^Smaller size/ })).toContainText(
    /1280 × 640 · .* (KB|MB) \(\d+% smaller\)/
  );
  await expect(menu.getByRole('menuitem', { name: /Custom/ })).toHaveCount(0);
  const box = await menu.boundingBox();
  const chipBox = await chip.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(380);
  expect(box!.y + box!.height).toBeLessThanOrEqual(650);
  expect(box!.y + box!.height).toBeLessThanOrEqual(chipBox!.y - 5);
  expect(box!.width).toBeGreaterThanOrEqual(280);
  expect(box!.width).toBeLessThan(320);
  expect(await menu.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
  const footer = await menu.evaluate((element) => {
    const button = element.querySelector('button');
    const details = button?.querySelector('span');
    const current = element.querySelector('.image-compression-current');
    const transparency = element.querySelector('.image-compression-transparency');
    const note = transparency?.parentElement;
    if (!button || !details || !current || !transparency || !note)
      throw new Error('Missing image-menu copy');
    return {
      labelLeft: details.getBoundingClientRect().left,
      currentLeft: current.getBoundingClientRect().left,
      noteLeft: note.getBoundingClientRect().left,
      currentColor: getComputedStyle(current).color,
      labelColor: getComputedStyle(button).color,
      transparencyDisplay: getComputedStyle(transparency).display,
      transparencyTop: transparency.getBoundingClientRect().top,
      noteTop: note.getBoundingClientRect().top,
    };
  });
  expect(footer.currentLeft).toBe(footer.labelLeft);
  expect(footer.noteLeft).toBe(footer.labelLeft);
  expect(footer.currentColor).toBe(footer.labelColor);
  expect(footer.transparencyDisplay).toBe('block');
  expect(footer.transparencyTop).toBeGreaterThan(footer.noteTop);
  await menu.getByRole('menuitem', { name: /^Recommended/ }).click();
  await expect(chip).not.toHaveClass(/image-size-warning/);
  await chip.hover();
  await expect(preview).toBeVisible();
  await expect
    .poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(2048);
  await expect(preview).not.toHaveAttribute('src', originalUrl!);
  await chip.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Restore original' }).click();
  await chip.hover();
  await expect(preview).toHaveAttribute('src', originalUrl!);
  await chip.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /^Smaller size/ }).click();
  await chip.hover();
  await expect
    .poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(1280);
  const smallerUrl = await preview.getAttribute('src');
  await composer.press('ControlOrMeta+z');
  await chip.hover();
  await expect(preview).toHaveAttribute('src', originalUrl!);
  await composer.press('ControlOrMeta+Shift+z');
  await chip.hover();
  await expect(preview).toHaveAttribute('src', smallerUrl!);
  await composer.press('Enter');
  await expect(page.locator('.chip-image-size')).toHaveCount(0);
  await expect(page.locator('.user-message-card img').first()).toHaveAttribute('src', smallerUrl!);
});
