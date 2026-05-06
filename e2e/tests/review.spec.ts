import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('review slash command sends the review prompt', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=review-slash');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('/review');
  await expect(page.getByText('Review current code changes')).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(page.locator('.chat-turn-user').last()).toContainText(
    'review the current changes in my code and provide feedback'
  );

  const promptBody = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ path: string; body?: unknown }> };
    }).__varroE2E;
    return value?.requests.find((request) => request.path.endsWith('/prompt_async'))?.body as
      | { parts?: Array<{ text?: string }> }
      | undefined;
  });

  expect(JSON.stringify(promptBody)).toContain('review the current changes in my code and provide feedback');
});
