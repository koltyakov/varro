import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('renders a child permission in its active parent and completes child work after manual approval', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/e2e/harness/index.html?scenario=subagent-permissions');

  await expect(
    page.locator('.interactive-session > .chat-header .chat-header-title-text')
  ).toHaveText('Parent permission orchestration');
  await expect(page.locator('.permission-prompt-text')).toHaveText('Run command');
  await expect(page.locator('.permission-meta-value')).toHaveText(
    'npm run test:e2e -- child-verification'
  );
  await expect(page.getByTitle('Send (Enter)')).toBeDisabled();
  await page.getByRole('button', { name: 'Allow once' }).click();

  await expect(page.locator('.permission-prompt')).toHaveCount(0);
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
              getSessionMessages?: (sessionId: string) => Array<{
                info: { time: { completed?: number } };
                parts: Array<{ id: string; type: string; state?: { status: string } }>;
              }>;
            };
          }
        ).__varroE2E;
        const child = state?.getSessionMessages?.('session-child-permissions')[1];
        return {
          response: state?.permissionResponses[0] || null,
          completed: child?.info.time.completed !== undefined,
          toolStatus: child?.parts.find((part) => part.id === 'tool-child-permission-1')?.state
            ?.status,
        };
      })
    )
    .toEqual({
      response: {
        sessionId: 'session-child-permissions',
        permissionId: 'permission-child-verification',
        response: 'once',
      },
      completed: true,
      toolStatus: 'completed',
    });
  await page.getByTitle('Back to sessions').click();
  await expect(
    page
      .locator('.session-item')
      .filter({ hasText: 'Parent permission orchestration' })
      .locator('.session-item-indicator.is-running')
  ).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('responds to a pending permission request', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=pending-permission');

  await expect(page.getByText('Permission Required')).toBeVisible();
  await expect(page.locator('.permission-prompt-text')).toHaveText('Run command');
  await expect(page.locator('.permission-meta-value')).toHaveText('npm test');
  await page.getByRole('button', { name: 'Allow always' }).click();

  await expect(page.locator('.permission-prompt')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = (
          window as Window & {
            __varroE2E?: { permissionResponses: Array<{ response: string }> };
          }
        ).__varroE2E;
        return value?.permissionResponses[0]?.response || null;
      })
    )
    .toBe('always');
});

test('rejects a pending permission request', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=pending-permission');

  await expect(page.getByText('Permission Required')).toBeVisible();
  await expect(page.locator('.permission-prompt-text')).toHaveText('Run command');
  await expect(page.locator('.permission-meta-value')).toHaveText('npm test');
  await page.getByRole('button', { name: 'Reject' }).click();

  await expect(page.locator('.permission-prompt')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = (
          window as Window & {
            __varroE2E?: { permissionResponses: Array<{ response: string }> };
          }
        ).__varroE2E;
        return value?.permissionResponses[0]?.response || null;
      })
    )
    .toBe('reject');
});

test('restores a linked permission to full flow after its tool starts compacting', async ({
  page,
}) => {
  await page.setViewportSize({ width: 504, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=returning-linked-permission');

  await expect(page.getByText('Allow access to the temporary sandbox?')).toBeVisible();
  await expect(page.locator('.assistant-active-activity-item')).toBeVisible();
  const blockedTool = page
    .locator('.tool-invocation-header')
    .filter({ hasText: 'Remove temporary sandbox' });
  await expect(blockedTool).toBeVisible();
  await expect(blockedTool.locator('.tool-call-wait-icon.tool-status-pending')).toBeVisible();
  await expect(blockedTool.locator('.tool-call-spinner')).toHaveCount(0);
  expect(
    await blockedTool.evaluate((tool) => {
      const prompt = document.querySelector('.permission-prompt');
      return (
        !!prompt && !!(tool.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
    })
  ).toBe(true);
  await page.waitForTimeout(2_100);
  await page.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.locator('.permission-prompt-text')).toHaveText('Run command');
  await expect(page.locator('.permission-meta-value')).toHaveText(
    'rm -rf /tmp/varro-sandbox'
  );
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  const geometry = await page.locator('.permission-prompt').evaluate((prompt) => {
    const promptRect = prompt.getBoundingClientRect();
    const messageList = document.querySelector<HTMLElement>('.interactive-list');
    const listRect = messageList?.getBoundingClientRect();
    const actionsRect = prompt
      .querySelector<HTMLElement>('.permission-prompt-actions')
      ?.getBoundingClientRect();
    return {
      actionCount: prompt.querySelectorAll('.permission-prompt-actions button').length,
      promptHeight: promptRect.height,
      promptFullyVisible:
        !!listRect && promptRect.top >= listRect.top && promptRect.bottom <= listRect.bottom,
      actionsFullyVisible:
        !!listRect &&
        !!actionsRect &&
        actionsRect.top >= listRect.top &&
        actionsRect.bottom <= listRect.bottom,
    };
  });

  expect(geometry.actionCount).toBe(3);
  expect(geometry.promptHeight).toBeGreaterThan(100);
  expect(geometry.promptFullyVisible).toBe(true);
  expect(geometry.actionsFullyVisible).toBe(true);
});

test('keeps a linked permission visible when its tool row is hidden in chat', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=hidden-linked-permission');

  await expect(page.getByText('Permission Required')).toBeVisible();
  await expect(page.locator('.permission-prompt-text')).toHaveText('Run command');
  await expect(page.locator('.permission-meta-value')).toHaveText('npm test');
  await expect(page.locator('.tool-invocation-title')).toHaveCount(0);

  await page.getByRole('button', { name: 'Allow once' }).click();

  await expect(page.locator('.permission-prompt')).toHaveCount(0);
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
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
        return value?.permissionResponses[0] || null;
      })
    )
    .toEqual({
      sessionId: 'session-hidden-linked-permission',
      permissionId: 'permission-hidden-linked-1',
      response: 'once',
    });
});

test('recovers a permission prompt when the live permission event is missed', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=missed-permission-event');

  await expect(page.getByText('Permission Required')).toBeVisible();
  await expect(page.locator('.permission-prompt-text')).toHaveText('Run command');
  await expect(page.locator('.permission-meta-value')).toHaveText('npm test');
  await expect(page.locator('.tool-invocation-title')).toHaveText('Run command');
  await expect(page.locator('.tool-call-wait-icon.tool-status-pending')).toBeVisible();
});

test('default permissions defer to OpenCode and surface its bash request', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await expect(page.getByRole('button', { name: 'Default permissions' })).toBeVisible();
  await expect(page.locator('.model-name-text')).toContainText('GPT-5 mini');

  await page.getByTitle('Select agent').click();
  await page.getByRole('button', { name: /Plan Draft implementation plans/i }).click();
  await expect(page.getByTitle('Select agent')).toContainText('Plan');

  await page.getByTitle('GitHub Copilot / GPT-5 mini').click();
  await page.getByRole('button', { name: 'GLM 5.1', exact: true }).click();
  await expect(page.locator('.model-name-text')).toContainText('GLM 5.1');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill(
    'In default permissions mode, get opencode version using bash by running opencode --version.'
  );
  await page.getByTitle('Send (Enter)').click();

  await expect(page.getByText('Permission Required')).toBeVisible();
  await expect(page.locator('.permission-prompt-text')).toHaveText('Run command');
  await expect(page.getByText('opencode --version', { exact: true })).toBeVisible();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { requests: Array<{ method: string; path: string; body?: unknown }> };
          }
        ).__varroE2E;
        const createRequest = value?.requests.find(
          (request) => request.method === 'POST' && request.path === '/session'
        );
        return createRequest?.body || null;
      })
    )
    .toBeTruthy();

  const permissionCreateBody = await getE2EState(page, () => {
    const value = (
      window as Window & {
        __varroE2E?: { requests: Array<{ method: string; path: string; body?: unknown }> };
      }
    ).__varroE2E;
    return value?.requests.find(
      (request) => request.method === 'POST' && request.path === '/session'
    )?.body as
      | { permission?: Array<{ permission: string; action: string; pattern: string }> }
      | undefined;
  });

  expect(permissionCreateBody?.permission).toBeUndefined();

  const promptBody = await getE2EState(page, () => {
    const value = (
      window as Window & {
        __varroE2E?: { requests: Array<{ path: string; body?: unknown }> };
      }
    ).__varroE2E;
    return value?.requests.find((request) => request.path.endsWith('/prompt_async'))?.body as
      | { agent?: string; model?: { providerID: string; modelID: string } }
      | undefined;
  });

  expect(promptBody).toMatchObject({
    agent: 'plan',
    model: { providerID: 'z-ai', modelID: 'glm-5.1' },
  });
});

test('keeps a grouped permission prompt visible after a one-time approval', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=grouped-permissions');

  await expect(page.getByText('Permission Required')).toBeVisible();
  await expect(page.locator('.permission-prompt-text')).toHaveText('Run command');
  await expect(page.locator('.permission-meta-value')).toHaveText('npm test');
  await expect(page.locator('.permission-prompt-count')).toContainText('2');

  await page.getByRole('button', { name: 'Allow once' }).click();

  await expect(page.locator('.permission-prompt-text')).toHaveText('Run command');
  await expect(page.locator('.permission-meta-value')).toHaveText('npm test');
  await expect(page.locator('.permission-prompt-count')).toHaveCount(0);
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: {
              permissionResponses: Array<{ permissionId: string; response: string }>;
            };
          }
        ).__varroE2E;
        return (value?.permissionResponses || []).map(({ permissionId, response }) => ({
          permissionId,
          response,
        }));
      })
    )
    .toEqual([{ permissionId: 'permission-group-1', response: 'once' }]);
});

test('keeps grouped permission prompts bundled when rejecting them', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=grouped-permissions');

  await expect(page.locator('.permission-prompt-count')).toContainText('2');
  await page.getByRole('button', { name: 'Reject' }).click();

  await expect(page.locator('.permission-prompt')).toHaveCount(0);
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: {
              permissionResponses: Array<{ permissionId: string; response: string }>;
            };
          }
        ).__varroE2E;
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

test('clears every covered grouped permission after allowing always', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=grouped-permissions');

  await expect(page.locator('.permission-prompt-count')).toContainText('2');
  await page.getByRole('button', { name: 'Allow always' }).click();

  await expect(page.locator('.permission-prompt')).toHaveCount(0);
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: {
              permissionResponses: Array<{ permissionId: string; response: string }>;
              getPendingPermissions?: () => unknown[];
            };
          }
        ).__varroE2E;
        return {
          pending: value?.getPendingPermissions?.().length ?? -1,
          responses: (value?.permissionResponses || []).map(({ permissionId, response }) => ({
            permissionId,
            response,
          })),
        };
      })
    )
    .toEqual({
      pending: 0,
      responses: [{ permissionId: 'permission-group-1', response: 'always' }],
    });
});

test('shows distinct permission requests one at a time', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=sequential-permissions');

  await expect(page.locator('.permission-prompt')).toHaveCount(1);
  await expect(page.locator('.permission-prompt-step')).toHaveText('1 / 2');
  await expect(page.locator('.permission-prompt-text')).toHaveText('Run command');
  await expect(page.locator('.permission-meta-value')).toHaveText('npm test');

  await page.getByRole('button', { name: 'Allow once' }).click();

  await expect(page.locator('.permission-prompt')).toHaveCount(1);
  await expect(page.locator('.permission-prompt-step')).toHaveText('2 / 2');
  await expect(page.locator('.permission-prompt-text')).toHaveText('Run command');
  await expect(page.locator('.permission-meta-value')).toHaveText('npm run build');
  await page.getByRole('button', { name: 'Reject' }).click();

  await expect(page.locator('.permission-prompt')).toHaveCount(0);
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: {
              permissionResponses: Array<{ permissionId: string; response: string }>;
            };
          }
        ).__varroE2E;
        return (value?.permissionResponses || []).map(({ permissionId, response }) => ({
          permissionId,
          response,
        }));
      })
    )
    .toEqual([
      { permissionId: 'permission-sequence-1', response: 'once' },
      { permissionId: 'permission-sequence-2', response: 'reject' },
    ]);
});

test('keeps permission actions on one responsive row', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=pending-permission');

  const fullLabels = page.locator('.permission-action-label-full');
  const shortLabels = page.locator('.permission-action-label-short');
  await expect(fullLabels.first()).toBeVisible();
  await expect(shortLabels.first()).toBeHidden();

  await page.setViewportSize({ width: 400, height: 600 });
  await expect(fullLabels.first()).toBeHidden();
  await expect(shortLabels).toHaveText(['Once', 'Always', 'Reject']);

  await page.setViewportSize({ width: 260, height: 600 });
  const layout = await page.locator('.permission-prompt-actions').evaluate((actions) => {
    const actionsRect = actions.getBoundingClientRect();
    const buttons = [...actions.querySelectorAll('button')];
    const buttonRects = buttons.map((button) => button.getBoundingClientRect());
    const labels = [...actions.querySelectorAll<HTMLElement>('.permission-action-label-short')];
    return {
      oneRow: buttonRects.every((rect) => Math.abs(rect.top - buttonRects[0]!.top) < 1),
      contained: buttonRects.every(
        (rect) => rect.left >= actionsRect.left - 1 && rect.right <= actionsRect.right + 1
      ),
      usesEllipsis: labels.every((label) => getComputedStyle(label).textOverflow === 'ellipsis'),
    };
  });

  expect(layout).toEqual({ oneRow: true, contained: true, usesEllipsis: true });
});
