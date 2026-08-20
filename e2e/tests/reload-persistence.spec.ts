/* oxlint-disable anti-slop/no-runtime-typeof -- Playwright callbacks validate serialized browser state before reading persistence fields. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: The asserted browser state is produced by this test's controlled harness fixture. */
import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

const SESSION_ID = 'session-reload-persistence';

test('keeps selected model, agent, MCP, and permission mode after reload', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=reload-persistence');

  await page.getByLabel('Select agent').click();
  await page.getByRole('button', { name: /Plan Draft implementation plans/i }).click();
  await expect(page.getByLabel('Select agent')).toContainText('Plan');

  await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
  await page.getByRole('button', { name: 'GLM 5.1', exact: true }).click();
  await expect(page.locator('.model-name-text')).toContainText('GLM 5.1');
  await expect(page.getByLabel('Thinking level')).toContainText('Default');

  await page.getByRole('button', { name: 'Default permissions' }).click();
  await page.getByRole('button', { name: 'Full access' }).click();
  await expect(page.getByRole('button', { name: 'Full access permissions' })).toBeVisible();

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('/mcp');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: /github/i }).click();
  await expect(page.locator('.dropdown-item.selected').filter({ hasText: 'github' })).toBeVisible();
  await page.keyboard.press('Escape');

  await expect
    .poll(() =>
      getE2EState(page, () => ({
        sessionSelectedAgents: localStorage.getItem('varro.sessionSelectedAgents'),
        sessionSelectedModels: localStorage.getItem('varro.sessionSelectedModels'),
        sessionPermissionModes: localStorage.getItem('varro.sessionPermissionModes'),
        sessionSelectedMcps: localStorage.getItem('varro.sessionSelectedMcps'),
      }))
    )
    .toMatchObject({
      sessionSelectedAgents: JSON.stringify({ [SESSION_ID]: 'plan' }),
      sessionSelectedModels: JSON.stringify({
        [SESSION_ID]: { providerID: 'z-ai', modelID: 'glm-5.1' },
      }),
      sessionPermissionModes: JSON.stringify({ [SESSION_ID]: 'full' }),
      sessionSelectedMcps: JSON.stringify({ [SESSION_ID]: ['chrome', 'github'] }),
    });

  await page.reload();

  await expect(page.getByLabel('Select agent')).toContainText('Plan');
  await expect(page.locator('.model-name-text')).toContainText('GLM 5.1');
  await expect(page.getByLabel('Thinking level')).toContainText('Default');
  await expect(page.getByRole('button', { name: 'Full access permissions' })).toBeVisible();

  await composer.click();
  await composer.fill('/mcp');
  await page.keyboard.press('Enter');
  await expect(page.locator('.dropdown-item.selected').filter({ hasText: 'chrome' })).toBeVisible();
  await expect(page.locator('.dropdown-item.selected').filter({ hasText: 'github' })).toBeVisible();
});

test('keeps composer text and attached files after reload', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await expect(composer).toBeVisible();
  await composer.fill('Keep this file context');
  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'files/dropped',
        payload: [
          {
            path: '/workspace/varro/src/persisted.ts',
            relativePath: 'src/persisted.ts',
            type: 'file',
          },
        ],
      },
      '*'
    );
  });
  await expect(
    page.locator('.chat-attachment-chip').filter({ hasText: 'persisted.ts' })
  ).toBeVisible();

  await page.reload();

  await expect(composer).toHaveText('Keep this file context');
  await expect(
    page.locator('.chat-attachment-chip').filter({ hasText: 'persisted.ts' })
  ).toBeVisible();
  await composer.press('Enter');

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { requests: Array<{ method: string; path: string; body?: unknown }> };
          }
        ).__varroE2E;
        const promptReq = value?.requests.find(
          (request) => request.method === 'POST' && request.path.includes('prompt_async')
        );
        if (!promptReq?.body || typeof promptReq.body !== 'object') return false;
        const body = promptReq.body as { parts?: Array<{ type: string; text?: string }> };
        return !!body.parts?.some(
          (part) => part.type === 'text' && part.text === 'src/persisted.ts'
        );
      })
    )
    .toBe(true);
  await expect(
    page
      .locator('.chat-attachments-container .chat-attachment-chip')
      .filter({ hasText: 'persisted.ts' })
  ).toHaveCount(0);
});
