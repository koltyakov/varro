import { expect, test } from '@playwright/test';
import { postWebviewMessage } from './helpers';

for (const theme of ['dark', 'light', 'high-contrast', 'high-contrast-light']) {
  test(`busy-send menu matches other menu highlights in ${theme}`, async ({ page }) => {
    await page.goto(`/e2e/harness/index.html?scenario=busy-stop-send&theme=${theme}`);
    const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
    await page.getByLabel('Select agent', { exact: true }).click();
    const referenceAction = page
      .locator('.agent-popover .toolbar-popover-item:not(.selected)')
      .first();
    await referenceAction.hover();
    await expect
      .poll(() => referenceAction.evaluate((element) => element.getAnimations().length))
      .toBe(0);
    const highlight = await referenceAction.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, foreground: style.color };
    });
    await composer.click();
    await composer.fill('Choose a send action');
    await page.getByLabel('More send options').click();

    const menu = page.locator('.busy-menu');
    const actions = menu.locator('button');
    await expect(actions).toHaveCount(3);
    for (const action of await actions.all()) {
      await expect(action).toBeEnabled();
      await action.hover();
      await expect(action).toHaveCSS('background-color', highlight.background);
      await expect(action).toHaveCSS('color', highlight.foreground);
    }

    await composer.hover();
    await page.keyboard.press('Tab');
    const focusedAction = menu.locator('button:focus-visible');
    await expect(focusedAction).toHaveCount(1);
    await expect(focusedAction).toHaveCSS('background-color', highlight.background);
    await expect(focusedAction).toHaveCSS('color', highlight.foreground);
  });

  test(`send button distinguishes enabled and disabled styles in ${theme}`, async ({ page }) => {
    await page.goto(`/e2e/harness/index.html?scenario=blank&theme=${theme}`);
    const send = page.getByLabel('Send (Enter)', { exact: true });
    const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();

    await expect(send).toBeDisabled();
    await expect(send).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(send).toHaveCSS('border-top-width', '1px');
    await expect(send).toHaveCSS('box-shadow', 'none');
    await expect(send).toHaveCSS('opacity', '1');
    const disabledColor = await send.evaluate((element) => getComputedStyle(element).color);
    await send.hover();
    await expect(send).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(send).toHaveCSS('transform', 'none');

    await composer.fill('Ready to send');
    await composer.hover();
    await expect(send).toBeEnabled();
    const buttonColors = {
      background:
        theme === 'dark'
          ? 'rgb(14, 99, 156)'
          : theme === 'light'
            ? 'rgb(15, 108, 189)'
            : theme === 'high-contrast'
              ? 'rgb(0, 0, 0)'
              : 'rgb(255, 255, 255)',
      foreground: theme === 'high-contrast-light' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)',
      hover:
        theme === 'dark'
          ? 'rgb(17, 119, 187)'
          : theme === 'light'
            ? 'rgb(17, 94, 163)'
            : theme === 'high-contrast'
              ? 'rgb(15, 15, 15)'
              : 'rgb(243, 243, 243)',
    };
    await expect(send).toHaveCSS('background-color', buttonColors.background);
    await expect(send).toHaveCSS('color', buttonColors.foreground);
    await expect(send).not.toHaveCSS('color', disabledColor);
    await expect(send).toHaveCSS('box-shadow', 'none');
    const borderColor = await send.evaluate((element) => getComputedStyle(element).borderTopColor);
    for (const side of ['top', 'right', 'bottom', 'left']) {
      await expect(send).toHaveCSS(`border-${side}-width`, '1px');
      await expect(send).toHaveCSS(`border-${side}-color`, borderColor);
    }
    await send.hover();
    await expect(send).toHaveCSS('background-color', buttonColors.hover);

    await composer.fill('');
    await expect(send).toBeDisabled();
    await expect(send).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(send).toHaveCSS('color', disabledColor);
  });
}

test('a deferred provider refresh does not block the composer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.pressSequentially('Send while refresh is deferred', { delay: 10 });

  // Active agents can defer a provider refresh. Existing routes remain usable.
  await postWebviewMessage(page, { type: 'providers/status', payload: { pending: true } });

  await expect(page.locator('.chat-send-button')).toBeEnabled();

  expect(errors).toEqual([]);
});

test('a deferred provider refresh still changes Stop to Add to queue', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=busy-stop-send');
  await postWebviewMessage(page, { type: 'providers/status', payload: { pending: true } });

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Queue while refresh is deferred');

  await expect(page.getByLabel('Stop')).toBeHidden();
  const send = page.getByLabel('Add to queue (Enter)');
  const options = page.getByLabel('More send options');
  await expect(send).toBeEnabled();
  await expect(options).toBeVisible();
  await expect(send).toHaveCSS('box-shadow', 'none');
  await expect(send).toHaveCSS('border-right-width', '0px');
  const borderColor = await send.evaluate((element) => getComputedStyle(element).borderTopColor);
  for (const side of ['top', 'bottom']) {
    await expect(send).toHaveCSS(`border-${side}-width`, '1px');
    await expect(options).toHaveCSS(`border-${side}-width`, '1px');
    await expect(send).toHaveCSS(`border-${side}-color`, borderColor);
    await expect(options).toHaveCSS(`border-${side}-color`, borderColor);
  }
  await expect(options).toHaveCSS('border-right-color', borderColor);
  await expect(options).toHaveCSS('height', '28px');
  await expect(send).toHaveCSS('height', '28px');
});
