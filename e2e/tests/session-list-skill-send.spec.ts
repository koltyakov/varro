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
