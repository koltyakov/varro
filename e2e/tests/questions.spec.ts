import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('answers a standalone question prompt', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=question-prompt');

  const submitButton = page.getByRole('button', { name: 'Submit' });
  const canaryOption = page.getByRole('radio', { name: /Canary/ });

  await expect(page.getByText('Rollout choice', { exact: true })).toBeVisible();
  await expect(submitButton).toBeDisabled();

  await canaryOption.click();

  await expect(canaryOption).toHaveAttribute('aria-checked', 'true');
  await expect(submitButton).toBeEnabled();
  await submitButton.click();

  const replyRequest = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ method: string; path: string; body?: unknown }> };
    }).__varroE2E;
    return value?.requests.find((request) => request.path === '/question/question-prompt-1/reply') || null;
  });

  expect(replyRequest).toMatchObject({
    method: 'POST',
    body: { answers: [['Canary']] },
  });
});

test('skips a standalone question prompt', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=question-prompt');

  await page.getByRole('button', { name: 'Skip' }).click();

  const rejectRequest = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ method: string; path: string }> };
    }).__varroE2E;
    return value?.requests.find((request) => request.path === '/question/question-prompt-1/reject') || null;
  });

  expect(rejectRequest).toMatchObject({ method: 'POST' });
});
