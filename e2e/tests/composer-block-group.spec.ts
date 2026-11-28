import { expect, test } from '@playwright/test';
import { openComposerBlocks } from './composer-block-fixture';

const TODO_ITEMS = '.todo-block:not(.changed-files-block) .todo-block-item';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 720 });
});

test('groups visible composer blocks behind a centered tab menu with dimmed counters', async ({
  page,
}) => {
  await openComposerBlocks(page, {
    queue: 2,
    goal: 'active',
    todos: { completed: 2, total: 5 },
    background: 1,
    files: 4,
  });
  const tabs = page.getByRole('tablist', { name: 'Chat input panels' });
  await expect(tabs.getByRole('tab')).toHaveText([
    'Queue 2',
    'Goal',
    'Todos 2/5',
    'Background 1',
    'Files 4',
  ]);
  await expect(tabs.locator('.composer-block-tab-count').first()).toHaveCSS('opacity', '0.7');

  // The menu is a plain centered row of text tabs, separate from the block card below it.
  const selectedTab = tabs.getByRole('tab', { name: /Queue/ });
  await expect(selectedTab).toHaveCSS('border-top-width', '0px');
  await expect(selectedTab).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(tabs).toHaveCSS('border-bottom-width', '0px');
  const listBox = (await tabs.boundingBox())!;
  const firstBox = (await tabs.getByRole('tab').first().boundingBox())!;
  const lastBox = (await tabs.getByRole('tab').last().boundingBox())!;
  const leftSpace = firstBox.x - listBox.x;
  const rightSpace = listBox.x + listBox.width - lastBox.x - lastBox.width;
  expect(Math.abs(leftSpace - rightSpace)).toBeLessThanOrEqual(1);
  const cardBox = (await page.locator('.chat-queue-container').first().boundingBox())!;
  expect(cardBox.y).toBeGreaterThan(listBox.y + listBox.height);

  // The first tab is selected and only its block is shown.
  await expect(tabs.getByRole('tab', { name: /Queue/ })).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByRole('list', { name: 'Queued messages' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Session goal' })).toBeHidden();
  await expect(page.locator('.todo-block:not(.changed-files-block)')).toBeHidden();

  const todosTab = tabs.getByRole('tab', { name: /Todos/ });
  await todosTab.click();
  await expect(page.locator(TODO_ITEMS)).toHaveCount(5);
  await expect(panel.getByRole('list', { name: 'Queued messages' })).toBeHidden();
  // The block keeps its own header and collapses from it exactly as without tabs.
  const todoHeader = page.locator('.todo-block:not(.changed-files-block) .todo-block-header');
  await expect(todoHeader.locator('.todo-block-title')).toHaveText('Todos');
  await todoHeader.click();
  await expect(todoHeader).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator(TODO_ITEMS)).toHaveCount(0);
  await todoHeader.click();
  await expect(todoHeader).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator(TODO_ITEMS)).toHaveCount(5);

  // A tab is always selected; selecting it again keeps its block shown.
  await todosTab.click();
  await expect(todosTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(TODO_ITEMS).first()).toBeVisible();

  // Arrow keys move between tabs.
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: /Background/ })).toBeFocused();
  await expect(page.getByRole('list', { name: 'Background services' })).toBeVisible();
  await page.keyboard.press('End');
  await expect(tabs.getByRole('tab', { name: /Files/ })).toHaveAttribute('aria-selected', 'true');
  // Files keeps its own collapsed header and opens from it.
  const filesHeader = page.locator('.changed-files-block .todo-block-header');
  await expect(filesHeader).toHaveAttribute('aria-expanded', 'false');
  await filesHeader.click();
  await expect(page.locator('.changed-files-item')).toHaveCount(4);
});

const ALL_BLOCKS = {
  queue: 1,
  goal: 'active',
  todos: { completed: 0, total: 2 },
  background: 1,
  files: 1,
} as const;

test('moves tabs that do not fit into a dropdown instead of wrapping', async ({ page }) => {
  await page.setViewportSize({ width: 300, height: 720 });
  await openComposerBlocks(page, ALL_BLOCKS);
  const tabList = page.getByRole('tablist');
  const more = page.getByRole('button', { name: 'More panels' });
  await expect(more).toBeVisible();
  const tabs = tabList.getByRole('tab');
  const visibleCount = await tabs.count();
  expect(visibleCount).toBeLessThan(5);
  // Everything stays on one line inside the composer width.
  const menuBox = (await page.locator('.composer-block-menu').boundingBox())!;
  const moreBox = (await more.boundingBox())!;
  for (const tab of await tabs.all()) {
    const box = (await tab.boundingBox())!;
    expect(Math.abs(box.y - moreBox.y)).toBeLessThanOrEqual(2);
    expect(box.x + box.width).toBeLessThanOrEqual(menuBox.x + menuBox.width);
  }
  expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(menuBox.x + menuBox.width);

  await more.click();
  const menu = page.getByRole('menu', { name: 'More panels' });
  const items = menu.getByRole('menuitem');
  await expect(items).toHaveCount(5 - visibleCount);
  await expect(items.first()).toBeFocused();
  const last = items.last();
  const lastKind = (await last.getAttribute('data-kind'))!;
  await last.click();
  await expect(menu).toHaveCount(0);
  // The chosen tab joins the line as the selected tab and its block shows.
  const chosen = tabList.locator(`[data-kind="${lastKind}"]`);
  await expect(chosen).toHaveAttribute('aria-selected', 'true');
  await expect(chosen).toBeFocused();
  await expect(more).toBeVisible();

  await more.click();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
});

test('keeps keyboard navigation on the selected tab when widening removes More panels', async ({
  page,
}) => {
  await page.setViewportSize({ width: 300, height: 720 });
  await openComposerBlocks(page, ALL_BLOCKS);
  const more = page.getByRole('button', { name: 'More panels' });
  await more.press('Enter');
  const items = page.getByRole('menu', { name: 'More panels' }).getByRole('menuitem');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();

  await page.setViewportSize({ width: 486, height: 720 });
  await expect(more).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /Queue/, selected: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /Goal/, selected: true })).toBeFocused();

  await page.setViewportSize({ width: 300, height: 720 });
  await more.press('Enter');
  await expect(items.first()).toBeFocused();
  const composer = page.getByRole('textbox', { name: 'Message composer' });
  await composer.focus();
  await expect(items).toHaveCount(0);
  await page.setViewportSize({ width: 486, height: 720 });
  await expect(more).toHaveCount(0);
  await expect(composer).toBeFocused();
});

test('shows every tab without a dropdown when they fit', async ({ page }) => {
  await openComposerBlocks(page, ALL_BLOCKS);
  await expect(page.getByRole('tablist').getByRole('tab')).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'More panels' })).toHaveCount(0);
});

test('shows one or two blocks without tabs', async ({ page }) => {
  await openComposerBlocks(page, { todos: { completed: 1, total: 3 }, files: 2 });
  await expect(page.locator('.todo-block:not(.changed-files-block)')).toBeVisible();
  await expect(page.locator('.changed-files-block')).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0);
});

test('omits tabs for blocks without content', async ({ page }) => {
  await openComposerBlocks(page, { goal: 'paused', background: 1, files: 2 });
  await expect(page.getByRole('tablist').getByRole('tab')).toHaveText([
    'Goal',
    'Background 1',
    'Files 2',
  ]);
});

for (const [goal, status] of [
  ['active', 'running'],
  ['paused', 'paused'],
  ['complete', 'achieved'],
] as const) {
  test(`shows a dimmed ${status} icon instead of a goal counter`, async ({ page }) => {
    await openComposerBlocks(page, { goal, queue: 1, files: 1 });
    const goalTab = page.getByRole('tab', { name: /^Goal/ });
    const icon = goalTab.getByRole('img', { name: status });
    await expect(icon).toBeVisible();
    await expect(icon).toHaveCSS('opacity', '0.7');
    await expect(goalTab.locator('.composer-block-tab-count')).toHaveCount(0);
  });
}

test('keeps the ungrouped layout when the setting is off', async ({ page }) => {
  await openComposerBlocks(page, { grouped: false, queue: 1, todos: { completed: 0, total: 2 } });
  await expect(page.getByRole('list', { name: 'Queued messages' })).toBeVisible();
  await expect(page.locator('.todo-block')).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.locator('.composer-block-group')).toHaveCount(0);
});

test('groups running subagents with background services under one Background tab', async ({
  page,
}) => {
  await openComposerBlocks(page, {
    todos: { completed: 1, total: 3 },
    files: 2,
    background: 2,
    subagents: 2,
  });
  const backgroundTab = page.getByRole('tab', { name: /^Background/ });
  // Two services plus two running subagents.
  await expect(backgroundTab).toHaveText('Background 4');
  await expect(page.locator('.chat-subagent-waiting')).toBeHidden();
  await backgroundTab.click();
  const services = page.getByRole('list', { name: 'Background services' });
  const waiting = page.locator('.chat-subagent-waiting');
  await expect(services).toBeVisible();
  await expect(waiting).toBeVisible();
  await expect(waiting).toContainText('Waiting for 2 subagents');
  // They stay separate blocks, stacked as without grouping.
  const servicesBox = (await page.locator('.chat-background-services').boundingBox())!;
  const waitingBox = (await waiting.boundingBox())!;
  expect(waitingBox.y).toBeGreaterThanOrEqual(servicesBox.y + servicesBox.height);
});

test('shows the Background tab for running subagents without services', async ({ page }) => {
  await openComposerBlocks(page, { todos: { completed: 1, total: 3 }, files: 2, subagents: 1 });
  const backgroundTab = page.getByRole('tab', { name: /^Background/ });
  await expect(backgroundTab).toHaveText('Background 1');
  await backgroundTab.click();
  await expect(page.locator('.chat-subagent-waiting')).toContainText('Waiting for 1 subagent');
  await expect(page.getByRole('list', { name: 'Background services' })).toHaveCount(0);
});
