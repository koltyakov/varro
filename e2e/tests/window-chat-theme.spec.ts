import { expect, test } from '@playwright/test';
import type { InitialWebviewState } from '../../src/shared/protocol';

test('keeps the reverse preference local to window chats across host theme changes', async ({
  page,
  context,
}) => {
  const route = '/e2e/harness/index.html?scenario=blank';
  await page.goto(route);
  await expect(page.locator('.interactive-session')).toBeVisible();
  const originalColor = await page
    .locator('body')
    .evaluate((body) => getComputedStyle(body).backgroundColor);
  const windowChat = await context.newPage();
  await windowChat.addInitScript(() => {
    let initial: InitialWebviewState | undefined;
    Object.defineProperty(window, '__initialWebviewState', {
      configurable: true,
      get: () => initial,
      set: (value: InitialWebviewState) => {
        initial = {
          ...value,
          webviewContext: {
            viewId: 'window-test',
            surface: 'editor',
            initialRoute: { type: 'new-session' },
          },
        };
      },
    });
  });
  await windowChat.setViewportSize({ width: 1200, height: 760 });
  await windowChat.goto(route);
  await expect(windowChat.locator('.interactive-session')).toBeVisible();
  await windowChat.evaluate(() => {
    document.documentElement.classList.add('varro-editor-surface');
  });
  const chatBounds = await windowChat.locator('.interactive-session').boundingBox();
  const composerFooter = windowChat.locator('.chat-input-toolbars.toolbar-meta');
  await expect(composerFooter).toBeVisible();
  const footerBounds = await composerFooter.boundingBox();
  await windowChat.evaluate(() => {
    window.postMessage(
      {
        type: 'theme/update',
        payload: {
          theme: 'dark',
          windowChatTheme: {
            source: 'Dark Modern',
            counterpart: {
              name: 'Light Modern',
              kind: 'light',
              colors: { 'editor.background': '#ffffff', 'sideBar.background': '#f8f8f8' },
            },
          },
        },
      },
      window.location.origin
    );
  });
  await expect(windowChat.locator('.window-chat-theme-toolbar')).toBeVisible();
  await expect
    .poll(() => windowChat.locator('.interactive-session').boundingBox())
    .toEqual(chatBounds);
  await expect.poll(() => composerFooter.boundingBox()).toEqual(footerBounds);
  await windowChat.getByRole('button', { name: 'Switch this chat to Light Modern' }).click();
  // Change the host theme while this window already has a local override.
  await windowChat.evaluate(() => {
    document.documentElement.style.setProperty('--vscode-editor-background', '#ffffff');
    document.body.classList.remove('vscode-dark');
    document.body.classList.add('vscode-light');
    window.postMessage(
      {
        type: 'theme/update',
        payload: {
          theme: 'light',
          windowChatTheme: {
            source: 'Light Modern',
            counterpart: {
              name: 'Dark Modern',
              kind: 'dark',
              colors: { 'editor.background': '#1f1f1f' },
            },
          },
        },
      },
      window.location.origin
    );
  });
  await expect(
    windowChat.getByRole('button', { name: 'Switch this chat to Light Modern' })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(windowChat.locator('body')).toHaveClass(/vscode-dark/);
  await expect(windowChat.locator('body')).toHaveCSS('background-color', 'rgb(31, 31, 31)');
  await windowChat.getByRole('button', { name: 'Switch this chat to Light Modern' }).click();
  await expect(windowChat.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(windowChat.locator('body')).toHaveClass(/vscode-light/);
  await expect(windowChat.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('body')).toHaveCSS('background-color', originalColor);
  await expect(page.locator('.window-chat-theme-toolbar')).toHaveCount(0);
  await windowChat.getByRole('button', { name: 'Switch this chat to Dark Modern' }).click();
  await expect(windowChat.locator('body')).toHaveClass(/vscode-dark/);
  await windowChat.getByRole('button', { name: 'Switch this chat to Light Modern' }).click();
  for (const viewport of [
    { width: 1000, height: 760 },
    { width: 920, height: 760 },
    { width: 480, height: 480 },
    { width: 1018, height: 760 },
    { width: 1200, height: 760 },
  ]) {
    await windowChat.setViewportSize(viewport);
    await expect(composerFooter).toBeInViewport({ ratio: 1 });
    await expect
      .poll(async () => {
        const bounds = await composerFooter.boundingBox();
        return bounds ? bounds.y + bounds.height : Infinity;
      })
      .toBeLessThanOrEqual(viewport.height);
    const floatingToggle = windowChat.locator('.window-chat-theme-toolbar');
    if (viewport.width < 1018) {
      await expect(floatingToggle).toBeHidden();
    } else {
      await expect(floatingToggle).toBeVisible();
      await expect
        .poll(async () => {
          const toggle = await floatingToggle.boundingBox();
          const column = await windowChat.locator('.interactive-list-track').boundingBox();
          return toggle && column ? toggle.x - (column.x + column.width - 14) : -1;
        })
        .toBeGreaterThanOrEqual(8);
      await expect
        .poll(async () => {
          const toggle = await floatingToggle.boundingBox();
          const chat = await windowChat.locator('.interactive-session').boundingBox();
          return toggle && chat ? toggle.y - chat.y : -1;
        })
        .toBe(8);
    }
  }
  await windowChat.close();
  await page.reload();
  await expect(page.locator('.interactive-session')).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('background-color', originalColor);
  await expect(page.locator('.window-chat-theme-toolbar')).toHaveCount(0);
});
