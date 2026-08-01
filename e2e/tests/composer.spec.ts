import { expect, test } from '@playwright/test';
import { getScrollMetrics, waitForAnimationFrames } from './helpers';

test('creates a session and sends a prompt through the mocked bridge', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await expect(composer).toBeVisible();
  await composer.click();
  await composer.fill('Add a smoke test for the sidebar');
  await expect(composer).toHaveText('Add a smoke test for the sidebar');

  const sendButton = page.getByTitle('Send (Enter)');
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

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

  await expect(page.getByText('Add a smoke test for the sidebar', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-turn-assistant').last()).toContainText('Mock assistant response for:');
  await expect(page.locator('.chat-turn-assistant').last()).toContainText('Add a smoke test for the sidebar');
});

test('shows todos and queues follow-up messages while a session is busy', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=todo-queue');

  await expect(page.getByRole('button', { name: /Todos/i })).toBeVisible();
  await expect(page.locator('.todo-block-item-text')).toContainText([
    'Add queue coverage for busy sessions',
    'Confirm todos stay visible above the composer',
  ]);

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Queue the follow-up after the current response finishes');
  await page.getByTitle('Add to queue (Enter)').click();

  const queueList = page.getByRole('list', { name: 'Queued messages' });
  await expect(queueList).toBeVisible();
  await expect(queueList.getByRole('listitem')).toContainText(
    'Queue the follow-up after the current response finishes'
  );

  await page.getByRole('button', { name: /Todos/i }).click();
  const queueGeometry = await page.evaluate(() => {
    const queue = document.querySelector('.chat-queue-container')?.getBoundingClientRect();
    const row = document.querySelector('.chat-queue-item')?.getBoundingClientRect();
    const todo = document.querySelector('.todo-block')?.getBoundingClientRect();
    return {
      queueWidth: queue?.width ?? 0,
      rowHeight: row?.height ?? 0,
      todoWidth: todo?.width ?? 0,
      todoHeight: todo?.height ?? 0,
    };
  });
  expect(Math.abs(queueGeometry.queueWidth - queueGeometry.todoWidth)).toBeLessThanOrEqual(1);
  expect(queueGeometry.rowHeight).toBe(28);
  expect(queueGeometry.rowHeight).toBeLessThan(queueGeometry.todoHeight);

  const queueControls = queueList.getByRole('listitem').locator('.chat-queue-control');
  await expect(queueControls).toHaveCount(4);
  const controlSizes = await queueControls.evaluateAll((controls) =>
    controls.map((control) => {
      const rect = control.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    })
  );
  expect(controlSizes).toEqual(Array.from({ length: 4 }, () => ({ width: 24, height: 24 })));
  const iconSizes = await queueControls.locator('svg').evaluateAll((icons) =>
    icons.map((icon) => {
      const rect = icon.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    })
  );
  expect(iconSizes).toEqual([
    { width: 10, height: 10 },
    { width: 14, height: 14 },
    { width: 14, height: 14 },
    { width: 14, height: 14 },
  ]);

  const steerButton = page.getByRole('button', { name: 'Send as Steer' });
  await expect(steerButton).toHaveText('');
  await expect(steerButton).toBeVisible();
  await steerButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  await expect(page.locator('.chat-turn-user').last()).toContainText(
    'Queue the follow-up after the current response finishes'
  );
});

test('keeps pre-input panel space reserved while model and MCP pickers are open', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=todo-queue');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Keep this queued while choosing a model');
  await page.getByTitle('Add to queue (Enter)').click();

  const queue = page.locator('.chat-queue-container');
  const todo = page.locator('.todo-block:not(.changed-files-block)');
  const inputShell = page.locator('.chat-input-shell');
  await expect(queue).toBeVisible();
  await expect(todo).toBeVisible();

  const before = await page.evaluate(() => ({
    inputTop: document.querySelector('.chat-input-shell')?.getBoundingClientRect().top ?? 0,
    queueHeight:
      document.querySelector('.chat-queue-container')?.getBoundingClientRect().height ?? 0,
    todoHeight:
      document.querySelector('.todo-block:not(.changed-files-block)')?.getBoundingClientRect()
        .height ?? 0,
  }));

  await page.locator('.model-picker-btn').click();
  await expect(page.locator('.dropdown-menu')).toBeVisible();
  await expect(queue).toBeHidden();
  await expect(todo).toBeHidden();
  await expect(queue).toHaveCount(1);
  await expect(todo).toHaveCount(1);

  const after = await page.evaluate(() => ({
    inputTop: document.querySelector('.chat-input-shell')?.getBoundingClientRect().top ?? 0,
    queueHeight:
      document.querySelector('.chat-queue-container')?.getBoundingClientRect().height ?? 0,
    todoHeight:
      document.querySelector('.todo-block:not(.changed-files-block)')?.getBoundingClientRect()
        .height ?? 0,
  }));

  expect(before.queueHeight).toBeGreaterThan(0);
  expect(before.todoHeight).toBeGreaterThan(0);
  expect(after.inputTop).toBeCloseTo(before.inputTop, 2);
  expect(after.queueHeight).toBeCloseTo(before.queueHeight, 2);
  expect(after.todoHeight).toBeCloseTo(before.todoHeight, 2);
  await expect(inputShell).toBeVisible();

  await page.keyboard.press('Escape');
  await composer.fill('/mcp');
  await expect(page.getByText('Open the MCP picker for this session')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.dropdown-menu')).toBeVisible();
  await expect(queue).toBeHidden();
  await expect(todo).toBeHidden();
  await expect(queue).toHaveCount(1);
  await expect(todo).toHaveCount(1);

  const mcpAfter = await page.evaluate(() => ({
    inputTop: document.querySelector('.chat-input-shell')?.getBoundingClientRect().top ?? 0,
    queueHeight:
      document.querySelector('.chat-queue-container')?.getBoundingClientRect().height ?? 0,
    todoHeight:
      document.querySelector('.todo-block:not(.changed-files-block)')?.getBoundingClientRect()
        .height ?? 0,
  }));

  expect(mcpAfter.inputTop).toBeCloseTo(before.inputTop, 2);
  expect(mcpAfter.queueHeight).toBeCloseTo(before.queueHeight, 2);
  expect(mcpAfter.todoHeight).toBeCloseTo(before.todoHeight, 2);
  await expect(inputShell).toBeVisible();
});

test('reorders and edits queued follow-up messages in place', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=todo-queue');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  for (const text of ['First follow-up', 'Second follow-up', 'Third follow-up']) {
    await composer.fill(text);
    await page.getByTitle('Add to queue (Enter)').click();
  }

  const queueList = page.getByRole('list', { name: 'Queued messages' });
  const labels = queueList.locator('.chat-queue-label');
  await expect(labels).toHaveText(['First follow-up', 'Second follow-up', 'Third follow-up']);
  const rows = queueList.getByRole('listitem');
  const firstActions = rows.first().locator('.chat-queue-actions');
  const secondActions = rows.nth(1).locator('.chat-queue-actions');
  await expect(firstActions).toHaveCSS('position', 'absolute');
  await expect(firstActions).toHaveCSS('opacity', '0');
  await expect(secondActions).toHaveCSS('opacity', '0');
  await rows.first().hover();
  await expect(firstActions).toHaveCSS('opacity', '1');
  await rows.nth(1).hover();
  await expect(secondActions).toHaveCSS('opacity', '1');
  await expect(firstActions).toHaveCSS('opacity', '0');

  await queueList
    .getByRole('button', { name: 'Reorder queued message: First follow-up' })
    .dragTo(queueList.getByRole('listitem').nth(1));

  await expect(labels).toHaveText(['Second follow-up', 'First follow-up', 'Third follow-up']);
  await expect(page.locator('.chat-drop-overlay')).toHaveCount(0);

  await queueList
    .getByRole('listitem')
    .nth(1)
    .getByRole('button', { name: 'Edit queued message' })
    .click();
  await expect(queueList.getByRole('listitem')).toHaveCount(3);
  const editingRow = queueList.getByRole('listitem').nth(1);
  await expect(editingRow).toHaveClass(/is-editing/);
  await expect(editingRow).toContainText('Editing');
  await expect(editingRow).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');
  await expect(editingRow).toHaveCSS('border-radius', '0px');
  await expect(editingRow.locator('[aria-label="Send as Steer"]')).toBeHidden();
  await expect(editingRow.locator('[aria-label="Remove from queue"]')).toBeHidden();
  const cancelEditButton = editingRow.getByRole('button', { name: 'Cancel queued message edit' });
  await expect(cancelEditButton).toBeVisible();
  await expect(cancelEditButton).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(
    editingRow.getByRole('button', { name: 'Reorder queued message: First follow-up' })
  ).toHaveCSS('visibility', 'visible');
  await composer.fill('First follow-up edited');
  await page.getByTitle('Add to queue (Enter)').click();

  await expect(labels).toHaveText([
    'Second follow-up',
    'First follow-up edited',
    'Third follow-up',
  ]);
  await expect(queueList.locator('.chat-queue-item.is-editing')).toHaveCount(0);

  const editedRow = queueList.getByRole('listitem').nth(1);
  await editedRow.hover();
  await editedRow.getByRole('button', { name: 'Edit queued message' }).click();
  await composer.fill('Discard this edit');
  await queueList.getByRole('button', { name: 'Cancel queued message edit' }).click();

  await expect(composer).toHaveText('');
  await expect(labels).toHaveText([
    'Second follow-up',
    'First follow-up edited',
    'Third follow-up',
  ]);
  await expect(queueList.locator('.chat-queue-item.is-editing')).toHaveCount(0);
});

test('removes queued follow-up messages before sending them', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=todo-queue');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Queue this and then remove it');
  await page.getByTitle('Add to queue (Enter)').click();

  const queueList = page.getByRole('list', { name: 'Queued messages' });
  await expect(queueList.getByRole('listitem')).toContainText('Queue this and then remove it');

  await queueList.getByRole('listitem').hover();
  await page.getByRole('button', { name: 'Remove from queue' }).click();
  await expect(queueList.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send as Steer' })).toHaveCount(0);
});

test('preserves completed todos against stale native todo update events', async ({ page }) => {
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
          type: 'todo.updated',
          properties: {
            sessionID: 'session-todo-completion',
            todos: [
              {
                content: 'Patch stale incremental message equivalence and add regression coverage',
                status: 'completed',
                priority: 'high',
              },
            ],
            info: {
              sessionID: 'session-todo-completion',
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

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('@sticky');

  await expect(page.getByText('src/components/StickyHeader.tsx')).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(page.getByTitle('src/components/StickyHeader.tsx')).toContainText('StickyHeader.tsx');

  await composer.fill('@queue');
  await expect(page.getByText('tests/e2e/queue.spec.ts')).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(page.getByTitle('tests/e2e/queue.spec.ts')).toContainText('queue.spec.ts');
});

test('sending from mid transcript snaps back to bottom and keeps following new turns', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');

  const list = page.locator('.interactive-list');
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  const sendButton = page.getByTitle('Send (Enter)');

  await expect(list).toBeVisible();
  await expect(composer).toBeVisible();

  await expect
    .poll(async () => (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom)
    .toBeLessThanOrEqual(15);
  await waitForAnimationFrames(page, 3);

  const bottomScrollTop = await list.evaluate((element) => element.scrollTop);

  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
    element.scrollTop = Math.max(0, Math.floor(element.scrollHeight / 2));
    element.dispatchEvent(new Event('scroll'));
  });

  await expect
    .poll(async () => await list.evaluate((element) => element.scrollTop))
    .toBeLessThan(bottomScrollTop - 500);

  await composer.fill('First follow mode regression check');
  await sendButton.click();

  await expect(page.getByText('First follow mode regression check', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-turn-assistant').last()).toContainText(
    'Mock assistant response for: First follow mode regression check'
  );
  await expect
    .poll(async () => (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom)
    .toBeLessThanOrEqual(15);

  await composer.fill('Second follow mode regression check');
  await sendButton.click();

  await expect(page.getByText('Second follow mode regression check', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-turn-assistant').last()).toContainText(
    'Mock assistant response for: Second follow mode regression check'
  );
  await expect
    .poll(async () => (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom)
    .toBeLessThanOrEqual(15);
});

test('upward scroll disables follow until the list reaches bottom again', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');

  const list = page.locator('.interactive-list');

  await expect(list).toBeVisible();

  await expect
    .poll(async () => (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom)
    .toBeLessThanOrEqual(15);

  const scrollTopBefore = await list.evaluate((element) => element.scrollTop);

  await list.hover();
  await page.mouse.wheel(0, -80);

  await expect
    .poll(async () => await list.evaluate((element) => element.scrollTop))
    .toBeLessThan(scrollTopBefore - 20);

  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });

  await expect
    .poll(async () => (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom)
    .toBeLessThanOrEqual(15);
});
