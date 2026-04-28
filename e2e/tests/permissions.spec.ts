import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('responds to a pending permission request', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=pending-permission');

  await expect(page.getByText('Permission Required')).toBeVisible();
  await expect(page.getByText('Allow running npm test?')).toBeVisible();
  await page.getByRole('button', { name: 'Always' }).click();

  await expect(page.getByText('Allow running npm test?')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = (window as Window & {
          __varroE2E?: { permissionResponses: Array<{ response: string }> };
        }).__varroE2E;
        return value?.permissionResponses[0]?.response || null;
      })
    )
    .toBe('always');
});

test('rejects a pending permission request', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=pending-permission');

  await expect(page.getByText('Permission Required')).toBeVisible();
  await expect(page.getByText('Allow running npm test?')).toBeVisible();
  await page.getByRole('button', { name: 'Reject' }).click();

  await expect(page.getByText('Allow running npm test?')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = (window as Window & {
          __varroE2E?: { permissionResponses: Array<{ response: string }> };
        }).__varroE2E;
        return value?.permissionResponses[0]?.response || null;
      })
    )
    .toBe('reject');
});

test('keeps a linked permission visible when its tool row is hidden in chat', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=hidden-linked-permission');

  await expect(page.getByText('Permission Required')).toBeVisible();
  await expect(page.getByText('Allow running npm test?')).toBeVisible();
  await expect(page.locator('.tool-invocation-title')).toHaveCount(0);

  await page.getByRole('button', { name: 'Once' }).click();

  await expect(page.getByText('Allow running npm test?')).toHaveCount(0);
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: {
            permissionResponses: Array<{
              sessionId: string;
              permissionId: string;
              response: string;
            }>;
          };
        }).__varroE2E;
        return value?.permissionResponses[0] || null;
      })
    )
    .toEqual({
      sessionId: 'session-hidden-linked-permission',
      permissionId: 'permission-hidden-linked-1',
      response: 'once',
    });
});

test('default permissions end up with a bash permission request for opencode version', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await expect(page.getByRole('button', { name: 'Default permissions' })).toBeVisible();
  await expect(page.locator('.model-name-text')).toContainText('GPT-5 mini');

  await page.getByTitle('Select agent').click();
  await page.getByRole('button', { name: /Plan Draft implementation plans/i }).click();
  await expect(page.getByTitle('Select agent')).toContainText('Plan');

  await page.getByTitle('GitHub Copilot / GPT-5 mini').click();
  await page.getByRole('button', { name: 'GLM 5.1' }).click();
  await expect(page.locator('.model-name-text')).toContainText('GLM 5.1');

  const composer = page.locator('textarea');
  await composer.fill('In default permissions mode, get opencode version using bash by running opencode --version.');
  await page.getByTitle('Send (Enter)').click();

  await expect(page.getByText('Permission Required')).toBeVisible();
  await expect(page.getByText('Allow running opencode --version?')).toBeVisible();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: { requests: Array<{ method: string; path: string; body?: unknown }> };
        }).__varroE2E;
        const createRequest = value?.requests.find(
          (request) => request.method === 'POST' && request.path === '/session'
        );
        return createRequest?.body || null;
      })
    )
    .toBeTruthy();

  const createBody = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ method: string; path: string; body?: unknown }> };
    }).__varroE2E;
    return value?.requests.find((request) => request.method === 'POST' && request.path === '/session')
      ?.body as
      | { permission?: Array<{ permission: string; action: string; pattern: string }> }
      | undefined;
  });

  expect(createBody?.permission).toContainEqual({ permission: 'bash', pattern: '*', action: 'ask' });

  const promptBody = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ path: string; body?: unknown }> };
    }).__varroE2E;
    return value?.requests.find((request) => request.path.endsWith('/prompt_async'))?.body as
      | { agent?: string; model?: { providerID: string; modelID: string } }
      | undefined;
  });

  expect(promptBody).toMatchObject({
    agent: 'build',
    model: { providerID: 'z-ai', modelID: 'glm-5.1' },
  });
});

test('groups duplicate permission prompts into a single prompt with a count', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=grouped-permissions');

  await expect(page.getByText('Permission Required')).toBeVisible();
  await expect(page.getByText('Allow running npm test?')).toBeVisible();
  await expect(page.locator('.permission-prompt-count')).toContainText('2');

  await page.getByRole('button', { name: 'Once' }).click();

  await expect(page.getByText('Allow running npm test?')).toHaveCount(0);
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: {
            permissionResponses: Array<{ permissionId: string; response: string }>;
          };
        }).__varroE2E;
        return (value?.permissionResponses || []).map(({ permissionId, response }) => ({
          permissionId,
          response,
        }));
      })
    )
    .toEqual([
      { permissionId: 'permission-group-1', response: 'once' },
      { permissionId: 'permission-group-2', response: 'once' },
    ]);
});

test('keeps grouped permission prompts bundled when rejecting them', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=grouped-permissions');

  await expect(page.locator('.permission-prompt-count')).toContainText('2');
  await page.getByRole('button', { name: 'Reject' }).click();

  await expect(page.getByText('Allow running npm test?')).toHaveCount(0);
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: {
            permissionResponses: Array<{ permissionId: string; response: string }>;
          };
        }).__varroE2E;
        return (value?.permissionResponses || []).map(({ permissionId, response }) => ({
          permissionId,
          response,
        }));
      })
    )
    .toEqual([
      { permissionId: 'permission-group-1', response: 'reject' },
      { permissionId: 'permission-group-2', response: 'reject' },
    ]);
});
