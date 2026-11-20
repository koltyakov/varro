import { expect, test } from '@playwright/test';

for (const sendMethod of ['Enter', 'button']) {
  test(`sessions-list skill command opens a new session on ${sendMethod}`, async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=session-search&skillCommand=1');
    await expect(page.getByLabel('Search sessions')).toBeVisible();
    const composer = page.locator('.session-list-new-session .rich-composer');
    await composer.fill('/control check machines');
    await expect(composer.locator('[data-chip-type="mention-skill"]')).toHaveText('control');

    if (sendMethod === 'Enter') await composer.press('Enter');
    else await page.getByLabel('Send (Enter)').click();

    await expect(page.locator('.chat-header-title-text').first()).toHaveText('Mock Session 4');
    await expect(page.locator('.chat-turn-user').last()).toContainText('check machines');
    const bubble = page.locator('.user-message-card').last();
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText('check machines');
    await expect(page.getByLabel('Search sessions')).not.toBeVisible();
    await expect(page.locator('.rich-composer').first()).toBeEmpty();
  });

  test(`sessions-list goal command opens a new session on ${sendMethod}`, async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=session-search&goalCommand=1');
    await expect(page.getByLabel('Search sessions')).toBeVisible();
    const composer = page.locator('.session-list-new-session .rich-composer');
    await composer.fill('/goal Wait for 1 minute');

    if (sendMethod === 'Enter') await composer.press('Enter');
    else await page.getByLabel('Send (Enter)').click();

    await expect(page.locator('.chat-header-title-text').first()).toHaveText('Mock Session 4');
    const bubble = page.locator('.user-message-card').last();
    await expect(bubble).toContainText('goal Wait for 1 minute');
    const goalChip = bubble.locator('.inline-chip[data-copy-marker="/goal"]');
    await expect(goalChip.locator('.inline-chip-label')).toHaveText('goal');
    await expect(goalChip.locator('[data-chip-icon="skill"]')).toBeVisible();
    const commands = await page.evaluate(() => {
      // SAFETY: The isolated harness exposes the requests submitted by this page.
      const harness = (
        window as typeof window & {
          __varroE2E: { requests: Array<{ method: string; path: string; body?: unknown }> };
        }
      ).__varroE2E;
      return harness.requests
        .filter(
          (request) =>
            request.method === 'POST' && /\/session\/[^/]+\/command(?:\?|$)/.test(request.path)
        )
        .map((request) => request.body);
    });
    expect(commands).toEqual([
      expect.objectContaining({ command: 'goal', arguments: 'Wait for 1 minute' }),
    ]);
    await expect(page.getByLabel('Search sessions')).not.toBeVisible();
    await expect(page.locator('.rich-composer').first()).toBeEmpty();
  });
}

test('sessions-list skill command restores its chip and text after rejection', async ({ page }) => {
  await page.goto(
    '/e2e/harness/index.html?scenario=session-search&skillCommand=1&skillCommandFailure=1'
  );
  await expect(page.getByLabel('Search sessions')).toBeVisible();
  const composer = page.locator('.session-list-new-session .rich-composer');
  await composer.fill('/control check machines');
  await expect(composer.locator('[data-chip-type="mention-skill"]')).toHaveText('control');
  await page.getByLabel('Send (Enter)').click();

  await expect(page.getByLabel('Search sessions')).toBeVisible();
  await expect(composer).toContainText('check machines');
  await expect(composer.locator('[data-chip-type="mention-skill"]')).toHaveText('control');
  await expect(page.getByText('Skill command rejected', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-turn-user')).toHaveCount(0);
});

test('sessions-list goal command restores its draft after rejection', async ({ page }) => {
  await page.goto(
    '/e2e/harness/index.html?scenario=session-search&goalCommand=1&goalCommandFailure=1'
  );
  await expect(page.getByLabel('Search sessions')).toBeVisible();
  const composer = page.locator('.session-list-new-session .rich-composer');
  await composer.fill('/goal Wait for 1 minute');
  await page.getByLabel('Send (Enter)').click();

  await expect(page.getByLabel('Search sessions')).toBeVisible();
  await expect(composer).toHaveText('/goal Wait for 1 minute');
  await expect(page.getByText('Goal command rejected', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-turn-user')).toHaveCount(0);
});
