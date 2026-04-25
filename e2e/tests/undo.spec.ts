import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('undo slash command reverts the latest assistant response', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=undo-session');

  const composer = page.locator('textarea');
  await composer.click();
  await composer.fill('/undo');
  await expect(page.getByText('Undo the last assistant response')).toBeVisible();
  await page.keyboard.press('Enter');

  const revertRequest = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ method: string; path: string; body?: unknown }> };
    }).__varroE2E;
    return value?.requests.find((request) => request.path.endsWith('/revert')) || null;
  });

  expect(revertRequest).toMatchObject({
    method: 'POST',
    path: '/session/session-undo/revert',
    body: { messageID: 'message-undo-assistant' },
  });
});
