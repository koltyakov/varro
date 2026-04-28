import { expect, test } from '@playwright/test';

test('creates a session and sends a prompt through the mocked bridge', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const composer = page.locator('textarea');
  await expect(composer).toBeVisible();
  await composer.fill('Add a smoke test for the sidebar');
  await page.getByTitle('Send (Enter)').click();

  await expect(page.getByText('Add a smoke test for the sidebar', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-turn-assistant').last()).toContainText('Mock assistant response for:');
  await expect(page.locator('.chat-turn-assistant').last()).toContainText('Add a smoke test for the sidebar');

  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = (window as Window & {
          __varroE2E?: { requests: Array<{ path: string }> };
        }).__varroE2E;
        return value?.requests.filter((request) => request.path.endsWith('/prompt_async')).length || 0;
      })
    )
    .toBe(1);
});

test('shows todos and queues follow-up messages while a session is busy', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=todo-queue');

  await expect(page.getByRole('button', { name: /Todos/i })).toBeVisible();
  await expect(page.locator('.todo-block-item-text')).toContainText([
    'Add queue coverage for busy sessions',
    'Confirm todos stay visible above the composer',
  ]);

  const composer = page.locator('textarea');
  await composer.fill('Queue the follow-up after the current response finishes');
  await page.getByTitle('Add to queue (Enter)').click();

  const queueList = page.getByRole('list', { name: 'Queued messages' });
  await expect(queueList).toBeVisible();
  await expect(queueList.getByRole('listitem')).toContainText(
    'Queue the follow-up after the current response finishes'
  );

  await page.getByRole('button', { name: 'Send as Steer' }).click();
  await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  await expect(page.locator('.chat-turn-user').last()).toContainText(
    'Queue the follow-up after the current response finishes'
  );
});

test('removes queued follow-up messages before sending them', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=todo-queue');

  const composer = page.locator('textarea');
  await composer.fill('Queue this and then remove it');
  await page.getByTitle('Add to queue (Enter)').click();

  const queueList = page.getByRole('list', { name: 'Queued messages' });
  await expect(queueList.getByRole('listitem')).toContainText('Queue this and then remove it');

  await page.getByRole('button', { name: 'Remove from queue' }).click();
  await expect(queueList.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send as Steer' })).toHaveCount(0);
});

test('refreshes todos from the final assistant message after stale todo events', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=todo-completion');

  const todoButton = page.getByRole('button', { name: /Todos/i });
  await expect(todoButton).toBeVisible();
  await expect(todoButton).toContainText('1/1');
  await todoButton.click();
  await expect(page.locator('.todo-block-item.status-completed')).toContainText(
    'Patch stale incremental message equivalence and add regression coverage'
  );

  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'todo.updated',
          properties: {
            sessionID: 'session-todo-completion',
            todos: [
              {
                id: 'todo-1',
                content: 'Patch stale incremental message equivalence and add regression coverage',
                status: 'in_progress',
                priority: 'high',
              },
            ],
          },
        },
      },
      '*'
    );
  });

  await expect(todoButton).toContainText('1/1');
  await expect(page.locator('.todo-block-item.status-completed')).toContainText(
    'Patch stale incremental message equivalence and add regression coverage'
  );

  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'message-todo-completion-assistant',
              sessionID: 'session-todo-completion',
              role: 'assistant',
              time: { created: 0, completed: 1 },
              parentID: 'message-todo-completion-user',
              modelID: 'gpt-5-mini',
              providerID: 'copilot',
              mode: 'primary',
              agent: 'build',
              path: { cwd: '/workspace/varro', root: '/workspace/varro' },
              summary: false,
              cost: 0,
              tokens: {
                input: 32,
                output: 64,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              finish: 'stop',
            },
          },
        },
      },
      '*'
    );
  });

  await expect(todoButton).toContainText('1/1');
  await expect(page.locator('.todo-block-item.status-completed')).toContainText(
    'Patch stale incremental message equivalence and add regression coverage'
  );
});

test('attaches files from @ search using the tmp workspace fixture', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=file-search');

  const composer = page.locator('textarea');
  await composer.click();
  await composer.fill('@sticky');

  await expect(page.getByText('src/components/StickyHeader.tsx')).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(page.locator('.chat-attachment-chip')).toContainText('StickyHeader.tsx');

  await composer.fill('@queue');
  await expect(page.getByText('tests/e2e/queue.spec.ts')).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(page.getByTitle('tests/e2e/queue.spec.ts')).toContainText('queue.spec.ts');
});
