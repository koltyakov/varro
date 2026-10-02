import { expect, test } from '@playwright/test';

test('starter hints use two columns and stack in a narrow view', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const logo = page.locator('.chat-empty-logo');
  const grid = page.locator('.chat-empty-hint-grid');
  const hints = grid.locator('.chat-empty-hint');
  const newlineHint = page.locator('.chat-empty-hints > .chat-empty-hint');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveCSS('opacity', '1');
  await expect(logo).toHaveCSS(
    'filter',
    'grayscale(1) brightness(1.1) drop-shadow(rgba(0, 0, 0, 0.28) 0px 1px 1px)'
  );
  await expect(hints).toHaveCount(4);
  await expect(newlineHint).toHaveText('ShiftEnter new line');
  await expect(newlineHint).toHaveCSS('opacity', '1');
  const hintColor = await hints.first().evaluate((element) => getComputedStyle(element).color);
  await expect(newlineHint).toHaveCSS('color', hintColor);
  const keycaps = page.locator('.chat-empty-hint kbd');
  await expect(keycaps).toHaveCount(6);
  for (const keycap of await keycaps.all()) {
    await expect(keycap).toHaveCSS('height', '20px');
    await expect(keycap).toHaveCSS('border-radius', '3px');
    await expect(keycap).toHaveCSS('border-top-width', '1px');
    await expect(keycap).toHaveCSS('box-shadow', 'rgba(0, 0, 0, 0.36) 0px 1px 2px 0px');
  }

  const wideBoxes = await hints.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, bottom: box.bottom };
    })
  );
  expect(wideBoxes[0]!.y).toBe(wideBoxes[1]!.y);
  expect(wideBoxes[2]!.y).toBe(wideBoxes[3]!.y);
  expect(wideBoxes[1]!.x).toBeGreaterThan(wideBoxes[0]!.x);
  expect(wideBoxes[2]!.y - wideBoxes[0]!.bottom).toBe(8);

  const logoBox = await logo.boundingBox();
  const gridBox = await grid.boundingBox();
  expect(gridBox!.width).toBe(280);
  await expect(grid).toHaveCSS('column-gap', '12px');
  expect(gridBox!.y - (logoBox!.y + logoBox!.height)).toBeCloseTo(40, 0);
  const newlineBox = await newlineHint.boundingBox();
  expect(newlineBox!.y - (gridBox!.y + gridBox!.height)).toBeCloseTo(28, 0);
  expect(newlineBox!.x + newlineBox!.width / 2).toBeCloseTo(gridBox!.x + gridBox!.width / 2, 0);
  await expect(hints.nth(3)).toHaveCSS('opacity', '1');

  await page.setViewportSize({ width: 240, height: 800 });
  await expect
    .poll(() =>
      grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
    )
    .toBe(1);
  const narrowBoxes = await hints.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right };
    })
  );
  for (let index = 0; index < narrowBoxes.length; index++) {
    const box = narrowBoxes[index]!;
    expect(box.x).toBe(narrowBoxes[0]!.x);
    expect(box.right).toBeLessThanOrEqual(240);
    if (index > 0) expect(box.y).toBeGreaterThan(narrowBoxes[index - 1]!.y);
  }
});

for (const lightTheme of ['vscode-light', 'vscode-high-contrast-light']) {
  test(`starter logo keeps original colors in ${lightTheme}`, async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=blank');
    const logo = page.locator('.chat-empty-logo');
    await expect(logo).toBeVisible();
    const originalSource = await logo.getAttribute('src');

    await page.locator('body').evaluate((element, theme) => {
      element.classList.remove('vscode-dark', 'vscode-high-contrast');
      element.classList.add(theme);
    }, lightTheme);
    await expect(logo).toHaveCSS('opacity', '0.8');
    await expect(logo).toHaveCSS('filter', 'drop-shadow(rgba(0, 0, 0, 0.28) 0px 1px 1px)');
    expect(await logo.getAttribute('src')).toBe(originalSource);

    await page.locator('body').evaluate((element, theme) => {
      element.classList.remove(theme);
      element.classList.add('vscode-dark');
    }, lightTheme);
    await expect(logo).toHaveCSS('opacity', '1');
    await expect(logo).toHaveCSS(
      'filter',
      'grayscale(1) brightness(1.1) drop-shadow(rgba(0, 0, 0, 0.28) 0px 1px 1px)'
    );
  });
}

test('starter keycaps and logo shadow follow VS Code keybinding theme colors', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const emptyState = page.locator('.chat-empty-state');
  const hints = page.locator('.chat-empty-hints');
  await expect(hints).toBeVisible();

  for (const theme of [
    {
      background: 'rgb(51, 51, 51)',
      foreground: 'rgb(204, 204, 204)',
      border: 'rgb(85, 85, 85)',
      shadow: 'rgb(17, 17, 17)',
    },
    {
      background: 'rgb(238, 238, 238)',
      foreground: 'rgb(51, 51, 51)',
      border: 'rgb(204, 204, 204)',
      shadow: 'rgb(170, 170, 170)',
    },
  ]) {
    await emptyState.evaluate((element, colors) => {
      for (const [name, color] of Object.entries(colors)) {
        element.style.setProperty(`--vscode-keybindingLabel-${name}`, color);
      }
    }, theme);
    await expect(page.locator('.chat-empty-logo')).toHaveCSS(
      'filter',
      `grayscale(1) brightness(1.1) drop-shadow(${theme.shadow} 0px 1px 1px)`
    );
    const keycapStyles = await hints.locator('kbd').evaluateAll((elements) =>
      elements.map((element) => {
        const styles = getComputedStyle(element);
        return {
          background: styles.backgroundColor,
          foreground: styles.color,
          border: styles.borderColor,
          shadow: styles.boxShadow,
        };
      })
    );
    for (const styles of keycapStyles) {
      expect(styles).toEqual({
        background: theme.background,
        foreground: theme.foreground,
        border: theme.border,
        shadow: `${theme.shadow} 0px 1px 2px 0px`,
      });
    }
  }
});
