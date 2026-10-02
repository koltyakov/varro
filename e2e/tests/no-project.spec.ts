/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These checks read request logs exposed by the controlled E2E harness. */
import { expect, test } from '@playwright/test';

test('empty window renders the composer and sends a scratch-scoped chat through AppRoot', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/e2e/harness/index.html?scenario=blank&noProject=1');
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await expect(composer).toBeVisible();
  await expect(page.getByText('Open a folder to use Varro')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Folder', exact: true })).toHaveCount(0);
  await expect(page.locator('.workspace-picker-button')).toHaveCount(0);
  await composer.fill('Hello without a project');
  await composer.press('Enter');
  await expect(page.locator('.chat-turn-user').last()).toContainText('Hello without a project');
  await expect(
    page.getByText('Mock assistant response for: Hello without a project', { exact: false })
  ).toBeVisible();

  const requests = await page.evaluate(
    () =>
      (
        window as Window & {
          __varroE2E?: { requests: Array<{ method: string; path: string }> };
        }
      ).__varroE2E?.requests ?? []
  );
  const creation = requests.find(
    (request) =>
      request.method === 'POST' &&
      new URL(request.path, 'http://varro.test').pathname === '/session'
  );
  expect(creation).toBeDefined();
  expect(new URL(creation!.path, 'http://varro.test').searchParams.get('directory')).toBe(
    '/varro/scratch'
  );
  expect(
    requests.some(
      (request) =>
        request.method === 'POST' &&
        new URL(request.path, 'http://varro.test').pathname.endsWith('/prompt_async')
    )
  ).toBe(true);
  expect(errors).toEqual([]);
});

test('empty window still exposes missing CLI recovery instead of asking for a folder', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=server-error-missing-cli&noProject=1');
  await expect(page.getByText('OpenCode is not installed', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open terminal and install', exact: true })
  ).toBeVisible();
  await expect(page.getByText('Open a folder to use Varro')).toHaveCount(0);
});
