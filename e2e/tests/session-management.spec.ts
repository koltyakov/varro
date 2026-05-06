import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('host new-session command creates and focuses a fresh session', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=new-session-command');

  await expect(page.locator('.chat-header-title-text').first()).toHaveText('Mock Session 2');
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: { requests: Array<{ method: string; path: string }> };
        }).__varroE2E;
        return value?.requests.filter((request) => request.method === 'POST' && request.path === '/session')
          .length;
      })
    )
    .toBe(1);
});

test('filters sessions through the session search input', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=session-search');

  const search = page.getByLabel('Search sessions');
  await expect(search).toBeVisible();

  await search.fill('beta');
  await expect(page.locator('.session-item-title')).toContainText(['Beta rollout notes']);
  await expect(page.locator('.session-item')).toHaveCount(1);

  await search.fill('zzz');
  await expect(page.getByText('No matching sessions', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.locator('.session-item-title')).toContainText([
    'Beta rollout notes',
    'Gamma cleanup pass',
  ]);
});

test('opens a filtered session with keyboard navigation', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=session-search');

  const search = page.getByLabel('Search sessions');
  await expect(search).toBeVisible();

  await search.fill('gamma');
  await expect(page.locator('.session-item')).toHaveCount(1);
  await search.press('ArrowDown');
  await search.press('Enter');

  await expect(page.locator('.chat-header-title-text').first()).toHaveText('Gamma cleanup pass');
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
});

test('wraps session keyboard focus from the end of the list', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=session-search');

  const search = page.getByLabel('Search sessions');
  await expect(search).toBeVisible();

  await search.press('ArrowUp');
  await page.keyboard.press('Enter');

  await expect(page.locator('.chat-header-title-text').first()).toHaveText('Gamma cleanup pass');
});
