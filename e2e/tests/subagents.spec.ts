/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These E2E callbacks update protocol-shaped subagent state owned by the controlled harness fixture. */
import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';
import type { MessageEntry } from '../../src/webview/types';
import type { ServerEvent } from '../../src/shared/protocol';

test('keeps a parent turn pending and shows the waiting block only for off-screen subagents', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 794 });
  await page.goto('/e2e/harness/index.html?scenario=subagent-sessions&childTaskState=running');
  const card = page.locator('.tool-invocation-task .tool-invocation-header');
  await expect(card).toBeVisible();
  await page.evaluate(() => {
    const harness = (
      window as typeof window & {
        __varroE2E: {
          getSessionMessages(id: string): MessageEntry[];
          replayServerEvent(event: ServerEvent): void;
        };
      }
    ).__varroE2E;
    const assistant = harness
      .getSessionMessages('session-parent')
      .find((entry) => entry.info.role === 'assistant');
    if (!assistant || assistant.info.role !== 'assistant')
      throw new Error('Missing parent assistant');
    const messageID = 'parent-progress';
    harness.replayServerEvent({
      type: 'message.updated',
      properties: {
        info: {
          ...assistant.info,
          id: messageID,
          finish: 'stop',
          time: { created: Date.now(), completed: Date.now() },
        },
      },
    });
    harness.replayServerEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'parent-progress-text',
          messageID,
          sessionID: 'session-parent',
          type: 'text',
          text: Array.from(
            { length: 24 },
            (_, index) => `Check ${index + 1} finished. Subagent validation is still running.`
          ).join('\n\n'),
        },
      },
    });
    harness.replayServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-parent', status: { type: 'idle' } },
    });
  });
  const waiting = page.locator('.chat-subagent-waiting');
  await expect(waiting).toContainText('Waiting for 1 subagent');
  await expect(waiting).toContainText('Inspect API routes');
  await expect(card).not.toBeInViewport();
  await expect(page.locator('.trailing-assistant-summary-row')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();

  const list = page.locator('.interactive-list');
  await list.hover();
  await page.mouse.wheel(0, -2400);
  await expect(card).toBeInViewport({ ratio: 0.5 });
  await expect(waiting).toHaveCount(0);
  await expect(page.locator('.trailing-assistant-summary-row')).toHaveCount(0);

  await page.mouse.wheel(0, 2400);
  await expect(card).not.toBeInViewport();
  await expect(waiting).toBeVisible();
  await page.evaluate(() => {
    const harness = (
      window as typeof window & {
        __varroE2E: { replayServerEvent(event: ServerEvent): void };
      }
    ).__varroE2E;
    harness.replayServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-child-a', status: { type: 'idle' } },
    });
  });
  await expect(waiting).toHaveCount(0);
  await expect(page.locator('.trailing-assistant-summary-row')).toBeVisible();
});

test('keeps a completed background launch running until its child is idle', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=subagent-sessions&childTaskState=running');
  const header = page.locator('.tool-invocation-task .tool-invocation-header');
  await expect(header.locator('.tool-call-spinner')).toBeVisible();
  await page.evaluate(() => {
    const harness = (
      window as typeof window & {
        __varroE2E: {
          getSessionMessages(id: string): MessageEntry[];
          replayServerEvent(event: ServerEvent): void;
        };
      }
    ).__varroE2E;
    const tool = harness
      .getSessionMessages('session-parent')
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool');
    if (!tool || tool.type !== 'tool' || tool.state.status !== 'running')
      throw new Error('Missing running task fixture');
    harness.replayServerEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          ...tool,
          state: {
            ...tool.state,
            status: 'completed' as const,
            input: { ...tool.state.input, background: true },
            title: tool.state.title || 'Inspect API routes',
            metadata: tool.state.metadata || {},
            output: 'The subagent is working in the background.',
            time: { start: tool.state.time.start, end: Date.now() },
          },
        },
      },
    });
    harness.replayServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-parent', status: { type: 'idle' } },
    });
  });
  await expect(header.locator('.tool-call-spinner')).toBeVisible();
  await expect(header.locator('.tool-status-completed')).toHaveCount(0);
  await expect(page.locator('.chat-subagent-waiting')).toHaveCount(0);
  await header.click();
  await expect(page.locator('.tool-invocation-running-label')).toHaveText(
    'General subagent is working'
  );
  await expect(page.locator('.structured-tool-card')).toContainText(
    'The subagent is working in the background.'
  );
  await expect(page.locator('.tool-invocation-subagent-link')).toHaveCount(0);
  await expect(header.locator('.tool-invocation-duration')).toHaveAttribute(
    'title',
    'Elapsed time'
  );

  await page.evaluate(() => {
    const harness = (
      window as typeof window & {
        __varroE2E: { replayServerEvent(event: ServerEvent): void };
      }
    ).__varroE2E;
    harness.replayServerEvent({
      type: 'session.status',
      properties: {
        sessionID: 'session-child-a',
        status: { type: 'retry', attempt: 2, message: 'Rate limited', next: Date.now() + 60_000 },
      },
    });
  });
  await expect(header.locator('.tool-call-spinner')).toBeVisible();
  await expect(page.locator('.tool-invocation-running-label')).toHaveText(
    'General subagent is retrying'
  );
  await expect(page.locator('.tool-invocation-running-detail')).toHaveText(
    'Attempt 2 · Rate limited'
  );

  await page.evaluate(() => {
    const harness = (
      window as typeof window & {
        __varroE2E: { replayServerEvent(event: ServerEvent): void };
      }
    ).__varroE2E;
    harness.replayServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-child-a', status: { type: 'idle' } },
    });
  });
  await expect(header.locator('.tool-call-spinner')).toHaveCount(0);
  await expect(header.locator('.tool-status-completed')).toBeVisible();
  await expect(page.locator('.tool-invocation-subagent-link')).toHaveText('Open subagent session');
  await expect(page.locator('.tool-invocation-retry-label')).toHaveCount(0);
});

test('uses a compact actions label/value row only inside active task details', async ({ page }) => {
  await page.goto(
    '/e2e/harness/index.html?scenario=subagent-sessions&childTaskState=running&childTaskBackground=1'
  );
  await expect(page.locator('.child-task-controls')).toHaveCount(0);
  await page.locator('.tool-invocation-header').click();
  const actions = page.locator('.structured-tool-card > .child-task-controls');
  await expect(actions.locator('.structured-tool-label')).toHaveText('actions');
  await expect(actions.getByRole('button', { name: 'Stop task', exact: true })).toBeEnabled();
  await expect(actions.getByRole('button', { name: 'Background', exact: true })).toBeEnabled();
  for (const name of ['Stop task', 'Background']) {
    const action = actions.getByRole('button', { name, exact: true });
    await expect(action).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(action).toHaveCSS('border-width', '0px');
    await expect(action).toHaveCSS('padding', '0px');
    const style = await action.evaluate((button) => {
      const computed = getComputedStyle(button);
      const reference = document.createElement('span');
      reference.style.color = 'var(--color-vscode-fg)';
      reference.style.fontFamily = 'var(--font-sans)';
      button.append(reference);
      const expected = getComputedStyle(reference);
      const result = {
        color: computed.color,
        foreground: expected.color,
        font: computed.fontFamily,
        uiFont: expected.fontFamily,
      };
      reference.remove();
      return result;
    });
    expect(style.color).toBe(style.foreground);
    expect(style.font).toBe(style.uiFont);
    await action.hover();
    await expect(action).toHaveCSS('text-decoration-line', 'underline');
    await action.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(action).toBeFocused();
    await page.mouse.move(0, 0);
    await expect(action).toHaveCSS('text-decoration-line', 'underline');
  }
  await expect(page.getByRole('button', { name: 'Stop whole task', exact: true })).toHaveCount(0);
  const geometry = await actions.evaluate((row) => {
    const next = row.nextElementSibling;
    if (!(next instanceof HTMLElement)) throw new Error('Missing scalar row');
    const bounds = row.getBoundingClientRect();
    const scalar = next.getBoundingClientRect();
    return {
      rowHeight: bounds.height,
      scalarHeight: scalar.height,
      actionLabelX: row.querySelector('.structured-tool-label')!.getBoundingClientRect().x,
      scalarLabelX: next.querySelector('.structured-tool-label')!.getBoundingClientRect().x,
      actionValueX: row.querySelector('.structured-tool-value-line')!.getBoundingClientRect().x,
      scalarValueX: next.querySelector('.structured-tool-value-line')!.getBoundingClientRect().x,
      buttons: [...row.querySelectorAll('button')].map(
        (button) => button.getBoundingClientRect().height
      ),
    };
  });
  expect(Math.abs(geometry.rowHeight - geometry.scalarHeight)).toBeLessThanOrEqual(1);
  expect(geometry.actionLabelX).toBe(geometry.scalarLabelX);
  expect(geometry.actionValueX).toBe(geometry.scalarValueX);
  expect(geometry.buttons).toHaveLength(2);
  for (const height of geometry.buttons) {
    expect(height).toBeGreaterThan(0);
    expect(height).toBeLessThan(20);
  }
  await page.locator('.tool-invocation-header').click();
  await expect(page.locator('.child-task-controls')).toHaveCount(0);
});

for (const status of ['completed', 'error'] as const) {
  test(`never shows management controls for ${status} tools`, async ({ page }) => {
    await page.goto(`/e2e/harness/index.html?scenario=subagent-sessions&childTaskState=${status}`);
    await page.locator('.tool-invocation-header').click();
    await expect(page.locator('.structured-tool-card')).toBeVisible();
    await expect(page.locator('.child-task-controls')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop whole task', exact: true })).toHaveCount(0);
  });

  test(`removes the actions row when an active tool becomes ${status}`, async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=subagent-sessions&childTaskState=running');
    await page.locator('.tool-invocation-header').click();
    await expect(page.locator('.child-task-controls')).toBeVisible();
    await page.evaluate((terminal) => {
      const harness = (
        window as typeof window & {
          __varroE2E: {
            getSessionMessages(id: string): MessageEntry[];
            replayServerEvent(event: ServerEvent): void;
          };
        }
      ).__varroE2E;
      const tool = harness
        .getSessionMessages('session-parent')
        .flatMap((message) => message.parts)
        .find((part) => part.type === 'tool');
      if (!tool || tool.type !== 'tool') throw new Error('Missing active task fixture');
      harness.replayServerEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            ...tool,
            state:
              terminal === 'completed'
                ? {
                    status: 'completed' as const,
                    input: tool.state.input,
                    metadata: { sessionId: 'session-child-a' },
                    title: 'Inspect API routes',
                    output: 'Done',
                    time: { start: 1, end: 2 },
                  }
                : {
                    status: 'error' as const,
                    input: tool.state.input,
                    metadata: { sessionId: 'session-child-a' },
                    error: 'Child interrupted.',
                    time: { start: 1, end: 2 },
                  },
          },
        },
      });
    }, status);
    await expect(page.locator('.child-task-controls')).toHaveCount(0);
  });
}

test('shows no controls anywhere in a child session, including active nested tasks', async ({
  page,
}) => {
  await page.goto(
    '/e2e/harness/index.html?scenario=subagent-sessions&childTaskState=running&nestedChildTask=1'
  );
  await page.locator('.tool-invocation-header').click();
  await page.locator('.tool-invocation-subagent-running').click();
  await expect(page.locator('.managed-subagent-footer')).toBeVisible();
  await expect(page.locator('.managed-subagent-controls')).toHaveCount(0);
  await page.locator('.tool-invocation-header').click();
  await expect(page.locator('.structured-tool-card')).toBeVisible();
  await expect(page.locator('.child-task-controls')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop whole task', exact: true })).toHaveCount(0);
});

test('retains the canonical child model after an empty interruption snapshot', async ({ page }) => {
  await page.goto(
    '/e2e/harness/index.html?scenario=subagent-sessions&childTaskState=completed&subagentResult=1&emptyChildModel=1'
  );
  await page.locator('.tool-invocation-header').click();
  await page.getByRole('button', { name: 'Open subagent session', exact: true }).click();
  await expect(page.locator('.managed-subagent-footer')).toBeVisible();
  await page.getByLabel('Back to parent session').click();
  await expect(
    page.locator('.interactive-session > .chat-header .chat-header-title-text')
  ).toHaveText('Parent orchestration');
  const header = page.locator('.tool-invocation-header');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  const modelRow = page
    .locator('.structured-tool-row')
    .filter({ has: page.locator('.structured-tool-label', { hasText: /^model$/ }) });
  await expect(modelRow.locator('.structured-tool-value')).toHaveText('openai/gpt-6.1-sol');
});

test('keeps a native result in Explored and navigates through the original subagent card', async ({
  page,
}) => {
  await page.goto(
    '/e2e/harness/index.html?scenario=subagent-sessions&childTaskState=completed&subagentResult=1'
  );
  const title = page.locator('.interactive-session > .chat-header .chat-header-title-text');
  await expect(title).toHaveText('Parent orchestration');
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Keep this parent draft');
  await expect(page.locator('.tool-invocation-task')).toHaveCount(1);
  await expect(page.locator('.tool-invocation-title')).toHaveText('Inspect API routes');
  const explored = page.locator('.assistant-activity-summary');
  await expect(explored).toContainText('Explored: 1 action');
  await explored.click();
  const notification = page
    .locator('.chat-tool-invocation-part')
    .filter({ hasText: 'Subagent completed' });
  await expect(notification).toHaveCount(1);
  await expect(notification).not.toHaveClass(/tool-invocation-task/);
  await notification.locator('.tool-invocation-header').click();
  await expect(notification).toContainText('Audit result');
  await explored.click();
  await expect(page.locator('.tool-invocation-header-shell')).not.toContainText(
    'Open subagent session'
  );
  await expect(page.locator('.tool-invocation-subagent-link')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop whole task', exact: true })).toHaveCount(0);
  await page.locator('.tool-invocation-header').click();
  await expect(
    page.locator('.tool-invocation-detail').getByRole('button', { name: 'Stop task', exact: true })
  ).toHaveCount(0);
  await expect(page.locator('.tool-invocation-header-shell')).not.toContainText('Stop task');
  await expect(
    page.locator('.tool-invocation-detail .tool-invocation-subagent-link')
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open subagent session', exact: true }).click();
  await expect(title).toHaveText('Inspect API routes');
  await expect(page.locator('.managed-subagent-footer .child-task-controls')).toHaveCount(0);
  await expect(page.locator('.managed-subagent-controls')).toHaveCount(0);
  await expect(page.locator('.managed-subagent-footer .child-task-controls')).toHaveCount(0);
  await page.getByLabel('Back to parent session').click();
  await expect(title).toHaveText('Parent orchestration');
  await expect(composer).toHaveText('Keep this parent draft');
  await expect(
    page.locator('[data-msg-id="native-result"] .user-message-card-editable')
  ).toHaveCount(0);
});

test('keeps a standalone native result available as an ordinary Explored action', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=subagent-sessions&subagentResult=1');
  await expect(page.locator('.tool-invocation-task')).toHaveCount(0);
  await expect(page.locator('.chat-tool-invocation-part')).toHaveCount(0);
  await page.locator('.assistant-activity-summary').click();
  await expect(page.locator('.tool-invocation-title')).toHaveText('Subagent completed: Audit auth');
  await page.locator('.tool-invocation-header').click();
  await expect(page.locator('.tool-invocation-detail')).toContainText('Audit result');
  await expect(page.locator('.user-message-card-editable')).toHaveCount(0);
});

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

  await expect(page.getByLabel('Back to sub-agent sessions')).toBeVisible();
  await expect(
    page.locator('.interactive-session > .chat-header .chat-header-title-text')
  ).toHaveText('Update tests');

  await page.getByLabel('Back to sub-agent sessions').click();
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
