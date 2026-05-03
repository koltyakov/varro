import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('archives an individual session row', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=row-archive');

  const row = page.locator('.session-item').filter({ hasText: 'Archive row target' });
  await row.hover();
  await row.getByTitle('Archive').click();

  const deleteRequest = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ method: string; path: string }> };
    }).__varroE2E;
    return (
      value?.requests.find(
        (request) => request.method === 'DELETE' && request.path === '/session/session-row-archive-a'
      ) || null
    );
  });

  expect(deleteRequest).toMatchObject({ method: 'DELETE', path: '/session/session-row-archive-a' });
});
