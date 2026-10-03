import { expect, test } from '@playwright/test';

for (const theme of ['dark', 'light', 'high-contrast', 'high-contrast-light']) {
  test(`keeps focus outlines hidden after screenshot modifiers in ${theme}`, async ({ page }) => {
    await page.goto(`/e2e/harness/index.html?scenario=model-search&theme=${theme}`);

    // Start with pointer focus, then reproduce the modifiers used by Cmd+Shift+4
    // without invoking the operating system's screenshot overlay.
    const agent = page.getByLabel('Select agent');
    await agent.click();
    await page.keyboard.down('Meta');
    await page.keyboard.down('Shift');
    await expect(agent).toBeFocused();
    await expect(agent).toHaveCSS('outline-style', 'none');
    await expect(agent).toHaveCSS('outline-width', '0px');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Meta');
    await agent.press('Escape');

    // Keyboard focus still works in Portal-rendered menus, including inputs.
    const picker = page.getByLabel('GitHub Copilot / GPT-5 mini');
    await page.keyboard.press('Tab');
    await picker.focus();
    await expect(picker).toBeFocused();
    expect(await picker.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
    await expect(picker).toHaveCSS('outline-style', 'none');
    await expect(picker).toHaveCSS('outline-width', '0px');
    await picker.press('Enter');
    const search = page.getByLabel('Search models');
    await expect(search).toBeFocused();
    await expect(search).toHaveCSS('outline-style', 'none');
    await search.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toHaveCount(1);
    await expect(focused).toHaveCSS('outline-style', 'none');
    await expect(focused).toHaveCSS('outline-width', '0px');
    await search.press('Escape');

    const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
    await composer.focus();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveCSS('outline-style', 'none');
  });
}
