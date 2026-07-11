import { expect, test } from '@playwright/test';

test('opens the subagent session list from a parent session', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  await page.goto('/e2e/harness/index.html?scenario=subagent-sessions');

  await page.locator('.session-item').filter({ hasText: 'Parent orchestration' }).hover();
  await page.getByRole('button', { name: 'Show 2 sub-agent sessions' }).click();
  await expect(page.getByText('Viewing:', { exact: true })).toBeVisible();
  await expect(page.getByText('Sub-agents', { exact: true })).toBeVisible();
  await expect(page.locator('.session-item-title')).toContainText(['Update tests', 'Inspect API routes']);
  expect(pageErrors).toEqual([]);
});

test('does not throw while opening a subagent session from the filtered subagent list', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  await page.goto('/e2e/harness/index.html?scenario=subagent-sessions');

  await page.locator('.session-item').filter({ hasText: 'Parent orchestration' }).hover();
  await page.getByRole('button', { name: 'Show 2 sub-agent sessions' }).click();
  await expect(page.getByText('Sub-agents', { exact: true })).toBeVisible();

  await page.locator('.session-item').filter({ hasText: 'Update tests' }).getByRole('button').first().click();

  await expect(page.getByTitle('Go to top session')).toBeVisible();
  await expect(page.locator('.interactive-session > .chat-header .chat-header-title-text')).toHaveText(
    'Update tests'
  );
  expect(pageErrors).toEqual([]);
});

test('opens a subagent session with keyboard navigation from the filtered subagent list', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=subagent-sessions');

  await page.locator('.session-item').filter({ hasText: 'Parent orchestration' }).hover();
  await page.getByRole('button', { name: 'Show 2 sub-agent sessions' }).click();
  await expect(page.getByText('Sub-agents', { exact: true })).toBeVisible();

  const sessionList = page.locator('.session-list-view').first();
  await sessionList.press('ArrowDown');
  await sessionList.press('Enter');

  await expect(page.locator('.interactive-session > .chat-header .chat-header-title-text')).toHaveText(
    /Update tests|Inspect API routes/
  );
});
