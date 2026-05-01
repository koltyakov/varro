import { expect, test } from '@playwright/test';

test('exhausted provider limit shows error chip in toolbar', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=usage-limit');

  const chip = page.locator('.toolbar-limit-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveClass(/\berror\b/);
  await expect(chip).toContainText('0%');
});

test('exhausted provider limit chip has descriptive title', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=usage-limit');

  const chip = page.locator('.toolbar-limit-chip');
  await expect(chip).toBeVisible();
  const title = await chip.getAttribute('title');
  expect(title).toBeTruthy();
  expect(title).toContain('Messages');
  expect(title).toContain('0');
  expect(title).toContain('40');
});

test('provider limit chip is absent for scenarios without a rate-limited provider', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=usage-limit');

  const chip = page.locator('.toolbar-limit-chip');
  await expect(chip).toBeVisible();

  await page.goto('/e2e/harness/index.html?scenario=plan-ready');
  await expect(page.locator('.toolbar-limit-chip')).toHaveCount(0);
});

test('retry session status shows provider limit context alongside error', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=usage-limit');

  await expect(page.locator('.chat-usage-limit-message')).toBeVisible();

  const chip = page.locator('.toolbar-limit-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveClass(/\berror\b/);
});
