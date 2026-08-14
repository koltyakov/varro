import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getScrollMetrics, waitForAnimationFrames } from './helpers';

async function delayPromptRequest(page: Page, delayMs: number) {
  await page.evaluate((delay) => {
    const harness = window as Window & {
      __sendToExtension?: (message: unknown) => void | Promise<void>;
    };
    const originalSend = harness.__sendToExtension;
    harness.__sendToExtension = async (message) => {
      const request = message as { type?: string; payload?: { path?: string } };
      if (request.type === 'api/request' && request.payload?.path?.endsWith('/prompt_async')) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      await originalSend?.(message);
    };
  }, delayMs);
}

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
        const value = (
          window as Window & {
            __varroE2E?: { requests: Array<{ path: string }> };
          }
        ).__varroE2E;
        return (
          value?.requests.filter((request) => request.path.endsWith('/prompt_async')).length || 0
        );
      })
    )
    .toBe(1);

  await expect(page.getByText('Add a smoke test for the sidebar', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-turn-assistant').last()).toContainText(
    'Mock assistant response for:'
  );
  await expect(page.locator('.chat-turn-assistant').last()).toContainText(
    'Add a smoke test for the sidebar'
  );
});

test('keeps URL boundaries editable in the composer', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const composer = page.locator('.rich-composer').first();
  await composer.fill('https://iconoir.com');
  const url = composer.locator('.composer-external-link');
  await expect(url).toHaveText('https://iconoir.com');

  await url.click();
  await page.keyboard.press('End');
  await page.keyboard.type(" what's this");

  await expect(composer).toHaveText("https://iconoir.com what's this");
  await expect(url).toHaveText('https://iconoir.com');
  await expect(composer).toBeFocused();

  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('plain follow-up');

  await expect(composer).toHaveText('plain follow-up');
  await expect(composer.locator('.composer-external-link')).toHaveCount(0);
  await expect(composer).toBeFocused();
});

test('replaces a selected session reference when pasting', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=session-search');

  const composer = page.locator('.rich-composer').first();
  await composer.fill('before session:session-search-beta after');
  const reference = composer.locator('.composer-session-reference');
  await expect(reference).toHaveText('Beta rollout notes');

  await reference.locator('.inline-chip-label').evaluate((label) => {
    const range = document.createRange();
    range.selectNodeContents(label);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await composer.evaluate((editor) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'replacement');
    editor.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
    );
  });

  await expect(composer).toHaveText('before replacement after');
  await expect(composer.locator('.composer-session-reference')).toHaveCount(0);
});

test('undoes deleted decorated composer text without duplication', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=session-search');

  const composer = page.locator('.rich-composer').first();
  const original =
    'session:session-search-beta session:session-search-beta\nhttps://iconoir.com';
  await composer.fill(original);
  await expect(composer.locator('.composer-session-reference')).toHaveCount(2);
  await expect(composer.locator('.composer-external-link')).toHaveCount(1);

  await composer
    .locator('.composer-session-reference')
    .first()
    .locator('.inline-chip-label')
    .evaluate((label) => {
      const range = document.createRange();
      range.selectNodeContents(label);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
  await composer.press('Backspace');
  await expect(composer.locator('.composer-session-reference')).toHaveCount(1);
  await composer.press('ControlOrMeta+z');

  await expect(composer.locator('.composer-session-reference')).toHaveCount(2);
  await expect(composer.locator('.composer-external-link')).toHaveCount(1);
  await expect(composer).toContainText('Beta rollout notes Beta rollout notes');
  await expect(composer).toContainText('https://iconoir.com');
});

test('undoes select-all deletion without duplicating plain text', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const composer = page.locator('.rich-composer').first();
  await composer.click();
  await page.keyboard.type('123');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await expect(composer).toHaveText('');
  await page.keyboard.press('ControlOrMeta+z');

  await expect(composer).toHaveText('123');
  await expect
    .poll(() =>
      composer.evaluate((editor) => {
        const selection = window.getSelection();
        if (!selection?.anchorNode) return -1;
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.setEnd(selection.anchorNode, selection.anchorOffset);
        return range.toString().length;
      })
    )
    .toBe(3);
});

test('ellipsizes the composer placeholder at narrow widths', async ({ page }) => {
  await page.setViewportSize({ width: 220, height: 320 });
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const composer = page.locator('.rich-composer[data-empty="true"]').first();
  await expect(composer).toBeVisible();
  const placeholderStyle = await composer.evaluate((element) => {
    const style = getComputedStyle(element, '::before');
    return {
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
    };
  });
  expect(placeholderStyle).toEqual({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });
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
  expect(queueGeometry.todoHeight).toBe(queueGeometry.rowHeight);

  const queueControls = queueList.getByRole('listitem').locator('.chat-queue-control');
  await expect(queueControls).toHaveCount(5);
  const controlSizes = await queueControls.evaluateAll((controls) =>
    controls.map((control) => {
      const rect = control.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    })
  );
  expect(controlSizes).toEqual(Array.from({ length: 5 }, () => ({ width: 24, height: 24 })));
  const iconSizes = await queueControls.locator('svg').evaluateAll((icons) =>
    icons.map((icon) => {
      const rect = icon.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    })
  );
  expect(iconSizes).toEqual([
    { width: 10, height: 10 },
    { width: 16, height: 16 },
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

test('keeps an optimistic steer visible through canonical parts and stale history handoff', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=todo-queue&stalePromptSync=1');
  const text = 'Keep this steer visible while history catches up';
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill(text);
  await page.getByTitle('Add to queue (Enter)').click();

  await page.evaluate((promptText) => {
    const harness = window as Window & { optimisticMessageSamples?: boolean[] };
    harness.optimisticMessageSamples = [];
    const sample = () => {
      const visible = [...document.querySelectorAll<HTMLElement>('.chat-turn-user')].some((row) =>
        row.textContent?.includes(promptText)
      );
      harness.optimisticMessageSamples?.push(visible);
      if ((harness.optimisticMessageSamples?.length ?? 0) < 50) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, text);

  const steerButton = page.getByRole('button', { name: 'Send as Steer' });
  await steerButton.focus();
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { optimisticMessageSamples?: boolean[] }).optimisticMessageSamples
            ?.length ?? 0
      )
    )
    .toBe(50);

  const samples = await page.evaluate(
    () =>
      (window as Window & { optimisticMessageSamples?: boolean[] }).optimisticMessageSamples ?? []
  );
  const firstVisible = samples.indexOf(true);
  expect(firstVisible).toBeGreaterThanOrEqual(0);
  expect(samples.slice(firstVisible).every(Boolean)).toBe(true);
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);
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

test('keeps pre-input panel space reserved while the @ selector is open', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=todo-queue');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Keep this queued while choosing a file');
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

  await composer.fill('@');
  await expect(page.locator('.composer-completion-menu')).toBeVisible();
  await expect(queue).toBeHidden();
  await expect(todo).toBeHidden();
  await expect(queue).toHaveCount(1);
  await expect(todo).toHaveCount(1);

  const whileOpen = await page.evaluate(() => ({
    inputTop: document.querySelector('.chat-input-shell')?.getBoundingClientRect().top ?? 0,
    queueHeight:
      document.querySelector('.chat-queue-container')?.getBoundingClientRect().height ?? 0,
    todoHeight:
      document.querySelector('.todo-block:not(.changed-files-block)')?.getBoundingClientRect()
        .height ?? 0,
  }));

  expect(before.queueHeight).toBeGreaterThan(0);
  expect(before.todoHeight).toBeGreaterThan(0);
  expect(whileOpen.inputTop).toBeCloseTo(before.inputTop, 2);
  expect(whileOpen.queueHeight).toBeCloseTo(before.queueHeight, 2);
  expect(whileOpen.todoHeight).toBeCloseTo(before.todoHeight, 2);
  await expect(inputShell).toBeVisible();

  await composer.fill('');
  await expect(page.locator('.composer-completion-menu')).toHaveCount(0);
  await expect(queue).toBeVisible();
  await expect(todo).toBeVisible();
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

  await expect(page.getByTitle('src/components/StickyHeader.tsx')).toContainText(
    'StickyHeader.tsx'
  );

  await composer.fill('@queue');
  await expect(page.getByText('tests/e2e/queue.spec.ts')).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(page.getByTitle('tests/e2e/queue.spec.ts')).toContainText('queue.spec.ts');
});

test('sending from mid transcript snaps back to bottom and keeps following new turns', async ({
  page,
}) => {
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

  await expect(
    page.getByText('Second follow mode regression check', { exact: true })
  ).toBeVisible();
  await expect(page.locator('.chat-turn-assistant').last()).toContainText(
    'Mock assistant response for: Second follow mode regression check'
  );
  await expect
    .poll(async () => (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom)
    .toBeLessThanOrEqual(15);
});

test('keeps existing transcript context visible while placing a new turn', async ({ page }) => {
  await page.setViewportSize({ width: 504, height: 1272 });
  await page.goto('/e2e/harness/index.html?scenario=new-turn-placement');

  const list = page.locator('.interactive-list');
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  const previousResponse = page.locator('[data-msg-id="message-new-turn-placement-assistant"]');
  await expect(list.locator('[data-msg-id]')).toHaveCount(2);
  await expect(previousResponse).toBeInViewport();
  await expect
    .poll(async () => (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom)
    .toBeLessThanOrEqual(2);

  await composer.fill('Test message');
  await delayPromptRequest(page, 2_000);
  await page.evaluate(() => {
    const samples: number[] = [];
    let frames = 0;
    const sample = () => {
      const cards = document.querySelectorAll<HTMLElement>('.user-message-card');
      const card = cards.item(cards.length - 1);
      const container = card?.closest<HTMLElement>('.interactive-list');
      if (card && container && cards.length > 1) {
        samples.push(card.getBoundingClientRect().top - container.getBoundingClientRect().top);
      }
      frames += 1;
      if (frames < 90) requestAnimationFrame(sample);
    };
    Object.assign(window, { newTurnTopSamples: samples });
    requestAnimationFrame(sample);
  });
  await page.getByTitle('Send (Enter)').click();

  const newTurn = page.locator('.user-message-card').filter({ hasText: 'Test message' });
  await expect(newTurn).toBeVisible();
  await waitForAnimationFrames(page, 70);

  const placement = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    samples:
      (
        window as Window & {
          newTurnTopSamples?: number[];
        }
      ).newTurnTopSamples ?? [],
  }));
  expect(placement.samples.length).toBeGreaterThan(1);
  expect(Math.min(...placement.samples)).toBeGreaterThan(placement.clientHeight / 2);
  await expect(previousResponse).toBeInViewport();

  await expect(page.locator('.append-scroll-bottom-reserve')).toHaveCount(0);
  await expect
    .poll(async () => (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom)
    .toBeLessThanOrEqual(2);
});

test('keeps the sent card and previous Worked summary stable through Thinking', async ({
  page,
}) => {
  await page.setViewportSize({ width: 504, height: 792 });
  await page.goto('/e2e/harness/index.html?scenario=todo-completion');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  const text = 'Keep this message continuously visible';
  await expect(page.getByRole('button', { name: /Todos/i })).toContainText('1/1');
  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'message-todo-completion-final-text',
              sessionID: 'session-todo-completion',
              messageID: 'message-todo-completion-assistant',
              type: 'text',
              text: 'All completed work is verified.',
            },
          },
        },
      },
      '*'
    );
  });
  await expect(
    page.locator('.trailing-assistant-summary-row .assistant-dialog-summary')
  ).toContainText('Worked for');
  await delayPromptRequest(page, 2_000);
  await composer.fill(text);
  await page.evaluate((promptText) => {
    const harness = window as Window & {
      sentUserCardPaintSamples?: Array<{
        visibleRatio: number;
        thinking: boolean;
        top: number | null;
        managed: boolean;
      }>;
      previousWorkedSamples?: Array<{
        top: number | null;
        owner: 'trailing' | 'row' | null;
        count: number;
      }>;
    };
    const samples: Array<{
      visibleRatio: number;
      thinking: boolean;
      top: number | null;
      managed: boolean;
    }> = [];
    harness.sentUserCardPaintSamples = samples;
    const previousWorkedSamples: Array<{
      top: number | null;
      owner: 'trailing' | 'row' | null;
      count: number;
    }> = [];
    harness.previousWorkedSamples = previousWorkedSamples;
    let seen = false;
    let frames = 0;
    const sample = () => {
      const list = document.querySelector<HTMLElement>('.interactive-list');
      const rowSummary = document.querySelector<HTMLElement>(
        '[data-msg-id="message-todo-completion-assistant"] > .assistant-dialog-summary'
      );
      const trailingSummary = document.querySelector<HTMLElement>(
        '.trailing-assistant-summary-row .assistant-dialog-summary'
      );
      const workedSummaries = [rowSummary, trailingSummary].filter(
        (summary): summary is HTMLElement => !!summary?.textContent?.includes('Worked for')
      );
      const workedSummary = workedSummaries[0];
      previousWorkedSamples.push({
        top:
          workedSummary && list
            ? workedSummary.getBoundingClientRect().top - list.getBoundingClientRect().top
            : null,
        owner:
          rowSummary === workedSummary
            ? 'row'
            : trailingSummary === workedSummary
              ? 'trailing'
              : null,
        count: workedSummaries.length,
      });

      const cards = [...document.querySelectorAll<HTMLElement>('.user-message-card')];
      const card = cards.findLast((candidate) => candidate.textContent?.includes(promptText));
      const row = card?.closest<HTMLElement>('[data-msg-id]');
      const container = card?.closest<HTMLElement>('.interactive-list');
      const thinking = !!document.querySelector('.interactive-loading-row .loading-indicator');
      if (card && row && container) {
        seen = true;
        const cardRect = card.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const paintedHeight = Math.max(
          0,
          Math.min(cardRect.bottom, rowRect.bottom) - Math.max(cardRect.top, rowRect.top)
        );
        samples.push({
          visibleRatio: cardRect.height > 0 ? paintedHeight / cardRect.height : 0,
          thinking,
          top: cardRect.top - container.getBoundingClientRect().top,
          managed: container.classList.contains('managed-scroll-anchor'),
        });
      } else if (seen) {
        samples.push({ visibleRatio: 0, thinking, top: null, managed: false });
      }
      frames += 1;
      if (frames < 60) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, text);

  await page.getByTitle('Send (Enter)').click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { sentUserCardPaintSamples?: unknown[] }).sentUserCardPaintSamples
            ?.length ?? 0
      )
    )
    .toBeGreaterThan(40);

  const samples = await page.evaluate(
    () =>
      (
        window as Window & {
          sentUserCardPaintSamples?: Array<{
            visibleRatio: number;
            thinking: boolean;
            top: number | null;
            managed: boolean;
          }>;
        }
      ).sentUserCardPaintSamples ?? []
  );
  expect(samples.some((sample) => sample.thinking)).toBe(true);
  expect(Math.min(...samples.map((sample) => sample.visibleRatio))).toBeGreaterThan(0.95);
  expect(samples.every((sample) => sample.managed)).toBe(true);
  const tops = samples.flatMap((sample) => (sample.top === null ? [] : [sample.top]));
  for (let index = 1; index < tops.length; index += 1) {
    expect(tops[index]!).toBeLessThanOrEqual(tops[index - 1]! + 0.5);
  }

  const workedSamples = await page.evaluate(
    () =>
      (
        window as Window & {
          previousWorkedSamples?: Array<{
            top: number | null;
            owner: 'trailing' | 'row' | null;
            count: number;
          }>;
        }
      ).previousWorkedSamples ?? []
  );
  expect(workedSamples.some((sample) => sample.owner === 'trailing')).toBe(true);
  expect(workedSamples.some((sample) => sample.owner === 'row')).toBe(true);
  expect(workedSamples.every((sample) => sample.count === 1 && sample.top !== null)).toBe(true);
  const workedTops = workedSamples.map((sample) => sample.top!);
  for (let index = 1; index < workedTops.length; index += 1) {
    expect(workedTops[index]!).toBeLessThanOrEqual(workedTops[index - 1]! + 0.5);
  }
});

test('keeps first-turn Thinking directly after the prompt', async ({ page }) => {
  await page.setViewportSize({ width: 504, height: 1272 });
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const list = page.locator('.interactive-list');
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('First turn positioning');
  await delayPromptRequest(page, 1_000);
  await page.evaluate(() => {
    const gapSamples: number[] = [];
    const sample = () => {
      const prompt = document.querySelector<HTMLElement>('.user-message-card');
      const loading = document.querySelector<HTMLElement>(
        '.interactive-loading-row .loading-indicator'
      );
      if (prompt && loading) {
        const promptRect = prompt.getBoundingClientRect();
        const loadingRect = loading.getBoundingClientRect();
        gapSamples.push(loadingRect.top - promptRect.bottom);
      }
      requestAnimationFrame(sample);
    };
    Object.assign(window, { firstTurnThinkingGapSamples: gapSamples });
    requestAnimationFrame(sample);
  });
  await page.getByTitle('Send (Enter)').click();

  const newTurn = page.locator('.user-message-card').filter({ hasText: 'First turn positioning' });
  const loadingRow = page.locator('.interactive-loading-row');
  await expect(newTurn).toBeVisible();
  await expect(loadingRow.locator('.loading-indicator')).toBeVisible();
  await waitForAnimationFrames(page, 15);

  const geometry = await list.evaluate((element) => {
    const prompt = element.querySelector<HTMLElement>('.user-message-card');
    const loading = element.querySelector<HTMLElement>('.interactive-loading-row');
    const track = element.querySelector<HTMLElement>('.interactive-list-track');
    if (!prompt || !loading || !track) throw new Error('First-turn geometry is unavailable');
    const containerRect = element.getBoundingClientRect();
    const promptRect = prompt.getBoundingClientRect();
    const loadingRect = loading.getBoundingClientRect();
    const inset = Number.parseFloat(
      getComputedStyle(track).getPropertyValue('--latest-user-message-sticky-gap')
    );
    return {
      promptTop: promptRect.top - containerRect.top - inset,
      responseSpace: loadingRect.top - promptRect.bottom,
    };
  });

  expect(geometry.promptTop).toBeGreaterThanOrEqual(0);
  expect(geometry.promptTop).toBeLessThanOrEqual(16);
  expect(geometry.responseSpace).toBeGreaterThanOrEqual(0);
  expect(geometry.responseSpace).toBeLessThanOrEqual(40);
  const thinkingGapSamples = await page.evaluate(
    () =>
      (
        window as Window & {
          firstTurnThinkingGapSamples?: number[];
        }
      ).firstTurnThinkingGapSamples ?? []
  );
  expect(thinkingGapSamples.length).toBeGreaterThan(1);
  expect(Math.max(...thinkingGapSamples) - Math.min(...thinkingGapSamples)).toBeLessThanOrEqual(
    0.5
  );
});

test('yields send-triggered bottom follow to direct upward transcript input', async ({ page }) => {
  await page.setViewportSize({ width: 504, height: 1272 });
  await page.goto('/e2e/harness/index.html?scenario=new-turn-placement');

  const list = page.locator('.interactive-list');
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await expect
    .poll(async () => (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom)
    .toBeLessThanOrEqual(2);

  await composer.fill('Cancel placement with direct input');
  await delayPromptRequest(page, 1_000);
  await page.getByTitle('Send (Enter)').click();
  const newTurn = page
    .locator('.user-message-card')
    .filter({ hasText: 'Cancel placement with direct input' });
  await expect(newTurn).toBeVisible();

  await list.hover();
  await page.mouse.wheel(0, -160);
  await waitForAnimationFrames(page, 12);

  const offset = await newTurn.evaluate((element) => {
    const container = element.closest<HTMLElement>('.interactive-list');
    const track = element.closest<HTMLElement>('.interactive-list-track');
    if (!container || !track) throw new Error('New turn geometry is unavailable');
    const inset = Number.parseFloat(
      getComputedStyle(track).getPropertyValue('--latest-user-message-sticky-gap')
    );
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top - inset;
  });
  expect(offset).toBeGreaterThan(40);
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
