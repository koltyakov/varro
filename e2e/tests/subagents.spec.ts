import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('inherits auto mode for a child permission and replies once without a prompt', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/e2e/harness/index.html?scenario=subagent-permissions&mode=auto&judge=allow');

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const state = (
          window as Window & {
            __varroE2E?: {
              permissionResponses: Array<{
                sessionId: string;
                permissionId: string;
                response: string;
              }>;
              requests: Array<{ method: string; path: string }>;
            };
          }
        ).__varroE2E;
        return {
          response: state?.permissionResponses[0] || null,
          judged: state?.requests.some(
            (request) => request.method === 'POST' && request.path === '/varro/permission/judge'
          ),
        };
      })
    )
    .toEqual({
      response: {
        sessionId: 'session-child-permissions',
        permissionId: 'permission-child-verification',
        response: 'once',
      },
      judged: true,
    });
  await expect(page.locator('.permission-prompt')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('shows the child permission in the parent when the inherited auto judge asks', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/e2e/harness/index.html?scenario=subagent-permissions&mode=auto&judge=ask');

  await expect(
    page.locator('.interactive-session > .chat-header .chat-header-title-text')
  ).toHaveText('Parent permission orchestration');
  await expect(page.locator('.permission-prompt-text')).toHaveText('Run command');
  await expect(page.locator('.permission-meta-value')).toHaveText(
    'npm run test:e2e -- child-verification'
  );
  await page.getByRole('button', { name: 'Allow once' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const state = (
          window as Window & {
            __varroE2E?: {
              permissionResponses: Array<{
                sessionId: string;
                permissionId: string;
                response: string;
              }>;
            };
          }
        ).__varroE2E;
        return state?.permissionResponses[0] || null;
      })
    )
    .toEqual({
      sessionId: 'session-child-permissions',
      permissionId: 'permission-child-verification',
      response: 'once',
    });
  expect(pageErrors).toEqual([]);
});

test('opens the subagent session list from a parent session', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  await page.goto('/e2e/harness/index.html?scenario=subagent-sessions');

  await page.locator('.session-item').filter({ hasText: 'Parent orchestration' }).hover();
  await page.getByRole('button', { name: 'Show 2 sub-agent sessions' }).click();
  await expect(page.getByText('Viewing:', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Sub-agents for Parent orchestration', { exact: true })
  ).toBeVisible();
  await expect(page.locator('.session-item-title')).toContainText([
    'Update tests',
    'Inspect API routes',
  ]);
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
  await expect(
    page.getByText('Sub-agents for Parent orchestration', { exact: true })
  ).toBeVisible();

  await page
    .locator('.session-item')
    .filter({ hasText: 'Update tests' })
    .getByRole('button')
    .first()
    .click();

  await expect(page.getByTitle('Back to sub-agent sessions')).toBeVisible();
  await expect(
    page.locator('.interactive-session > .chat-header .chat-header-title-text')
  ).toHaveText('Update tests');

  await page.getByTitle('Back to sub-agent sessions').click();
  await expect(
    page.getByText('Sub-agents for Parent orchestration', { exact: true })
  ).toBeVisible();
  await expect(page.locator('.session-item-title')).toContainText([
    'Update tests',
    'Inspect API routes',
  ]);
  expect(pageErrors).toEqual([]);
});

test('opens a subagent session with keyboard navigation from the filtered subagent list', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=subagent-sessions');

  await page.locator('.session-item').filter({ hasText: 'Parent orchestration' }).hover();
  await page.getByRole('button', { name: 'Show 2 sub-agent sessions' }).click();
  await expect(
    page.getByText('Sub-agents for Parent orchestration', { exact: true })
  ).toBeVisible();

  const sessionList = page.locator('.session-list-view').first();
  await sessionList.press('ArrowDown');
  await sessionList.press('Enter');

  await expect(
    page.locator('.interactive-session > .chat-header .chat-header-title-text')
  ).toHaveText(/Update tests|Inspect API routes/);
});
