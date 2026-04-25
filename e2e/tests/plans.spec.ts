import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('planning mode ends up with a plan using realistic provider models', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready');

  await expect(page.getByTitle('Back to sessions').locator('..').getByText('Plan migration rollout')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open plan' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Implement the plan' })).toBeVisible();
  await expect(page.locator('.assistant-turn-content').last()).toContainText('Migration Plan');
  await expect(page.locator('.assistant-turn-content').last()).toContainText(
    'Validate default-permission flows with a real bash request'
  );

  await expect(page.locator('.model-name-text')).toContainText('GLM 5.1');
  await page.locator('.model-picker-btn').click();
  await expect(page.getByText('GitHub Copilot', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'GPT-5 mini' })).toBeVisible();
  await expect(page.getByText('Z.ai', { exact: true })).toBeVisible();
  await expect(page.locator('.dropdown-item').filter({ hasText: 'GLM 5.1' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByTitle('Select agent').click();
  await expect(page.getByRole('button', { name: /Plan Draft implementation plans/i })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Open plan' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: { planOpenRequests: string[] };
        }).__varroE2E;
        return value?.planOpenRequests[0] || null;
      })
    )
    .toContain('# Migration Plan');
});

test('implementing a plan sends the build prompt and rejecting it hides the actions', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready');

  await page.getByRole('button', { name: 'Implement the plan' }).click();

  await expect(page.locator('.chat-turn-user').last()).toContainText(
    'Implement the plan from your last response in the current workspace.'
  );
  await expect(page.locator('.chat-turn-assistant').last()).toContainText('Mock assistant response for: Implement the plan from your last response');

  const promptBody = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ path: string; body?: unknown }> };
    }).__varroE2E;
    return value?.requests.filter((request) => request.path.endsWith('/prompt_async')).at(-1)?.body as
      | { agent?: string }
      | undefined;
  });

  expect(promptBody).toMatchObject({ agent: 'build' });

  await page.goto('/e2e/harness/index.html?scenario=plan-ready');
  await page.getByRole('button', { name: 'Skip for now' }).click();

  await expect(page.getByRole('button', { name: 'Open plan' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Implement the plan' })).toHaveCount(0);
});
