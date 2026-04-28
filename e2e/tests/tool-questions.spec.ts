import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('renders linked tool questions inline instead of as standalone prompts', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=linked-tool-question');

  await expect(page.getByText('Target environment', { exact: true })).toBeVisible();
  await expect(page.getByText('Which environment should I target?', { exact: true })).toBeVisible();
  await expect(page.locator('.question-prompt-card')).toHaveCount(1);
  await expect(page.locator('.tool-invocation-title')).toHaveCount(0);
});

test('submits answers for linked tool questions', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=linked-tool-question');

  const submitButton = page.getByRole('button', { name: 'Submit' });
  await expect(submitButton).toBeDisabled();

  await page.getByRole('radio', { name: /Staging/ }).click();
  await expect(submitButton).toBeEnabled();
  await submitButton.click();

  const replyRequest = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ method: string; path: string; body?: unknown }> };
    }).__varroE2E;
    return value?.requests.find((request) => request.path === '/question/linked-tool-question-1/reply') || null;
  });

  expect(replyRequest).toMatchObject({
    method: 'POST',
    body: { answers: [['Staging']] },
  });
});

test('skips linked tool questions inline', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=linked-tool-question');

  await page.getByRole('button', { name: 'Skip' }).click();

  const rejectRequest = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ method: string; path: string }> };
    }).__varroE2E;
    return value?.requests.find((request) => request.path === '/question/linked-tool-question-1/reject') || null;
  });

  expect(rejectRequest).toMatchObject({ method: 'POST' });
});
