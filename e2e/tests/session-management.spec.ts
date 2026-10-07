/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These E2E checks inspect controlled session state exposed by the harness browser global. */
import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

for (const width of [800, 486, 280]) {
  test(`rename popup has roomy controls and fits a ${width}px sidebar`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/e2e/harness/index.html?scenario=session-search');
    await page.locator('.session-item').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();

    const form = page.locator('.session-item-rename-form');
    const input = page.getByLabel('Session name', { exact: true });
    const save = form.getByRole('button', { name: 'Save', exact: true });
    await expect(input).toBeFocused();
    await expect(form).toHaveCSS('width', `${Math.min(480, width - 26)}px`);
    await expect(input).toHaveCSS('min-height', '36px');
    await expect(save).toHaveCSS('min-height', '32px');
    await expect
      .poll(async () => {
        const box = await page.locator('.session-item-actions-menu').boundingBox();
        return box !== null && box.x >= 8 && box.x + box.width <= width - 8;
      })
      .toBe(true);

    await input.fill('');
    await expect(save).toBeDisabled();
    await input.fill('A longer session name with space to edit');
    await expect(save).toBeEnabled();
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(form).toHaveCount(0);
  });
}

test('host new-session command opens a draft chat and creates the session on first send', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=new-session-command');

  const countSessionCreates = () =>
    getE2EState(page, () => {
      const value = (
        window as Window & {
          __varroE2E?: { requests: Array<{ method: string; path: string }> };
        }
      ).__varroE2E;
      return (
        value?.requests.filter(
          (request) =>
            request.method === 'POST' &&
            new URL(request.path, 'http://varro.test').pathname === '/session'
        ).length || 0
      );
    });

  await expect(page.locator('.chat-header-title-text').first()).toHaveText('New Chat');
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await expect(composer).toBeVisible();
  await expect.poll(countSessionCreates).toBe(0);

  await composer.fill('Start the new session now.');
  await page.getByLabel('Send (Enter)').click();

  await expect(page.locator('.chat-header-title-text').first()).toHaveText('Mock Session 2');
  await expect(page.locator('.chat-turn-user').last()).toContainText('Start the new session now.');
  await expect.poll(countSessionCreates).toBe(1);
});

test('filters sessions through the session search input', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=session-search');

  const search = page.getByLabel('Search sessions');
  await expect(search).toBeVisible();

  await search.fill('beta');
  await expect(page.locator('.session-item-title')).toContainText(['Beta rollout notes']);
  await expect(page.locator('.session-item')).toHaveCount(1);
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const requests = (
          window as Window & {
            __varroE2E?: { requests: Array<{ method: string; path: string }> };
          }
        ).__varroE2E?.requests;
        return requests?.some((request) => {
          if (request.method !== 'GET') return false;
          const url = new URL(request.path, 'http://varro.test');
          return (
            url.pathname === '/session' &&
            url.searchParams.get('search') === 'beta' &&
            url.searchParams.get('roots') === 'true' &&
            url.searchParams.get('limit') === '30'
          );
        });
      })
    )
    .toBe(true);

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
