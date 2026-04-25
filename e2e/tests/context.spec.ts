import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('opens the context popup and compacts the session', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=context-compact');

  await page.getByLabel(/Context usage/).click();
  await expect(page.getByText('Context Window', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compact session' })).toBeVisible();
  await page.getByRole('button', { name: 'Compact session' }).click();

  const summarizeCount = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ path: string }> };
    }).__varroE2E;
    return value?.requests.filter((request) => request.path.endsWith('/summarize')).length || 0;
  });

  expect(summarizeCount).toBe(1);
});
