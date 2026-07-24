import { expect, test } from '@playwright/test';

test('exhausted provider limit shows retry context and a descriptive toolbar chip', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=usage-limit');

  await expect(page.locator('.chat-usage-limit-message')).toBeVisible();
  const chip = page.locator('.toolbar-limit-chip');
  const badge = chip.locator('.toolbar-limit-chip-badge');
  await expect(chip).toBeVisible();
  await expect(badge).toHaveClass(/\berror\b/);
  await expect(chip).toContainText('0%');
  await expect(chip).toHaveAttribute('title', /Messages/);
  await expect(chip).toHaveAttribute('title', /0/);
  await expect(chip).toHaveAttribute('title', /40/);
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

test('narrow toolbar keeps provider limit and composer controls within their rows', async ({
  page,
}) => {
  await page.setViewportSize({ width: 348, height: 260 });
  await page.goto('/e2e/harness/index.html?scenario=usage-limit');

  await expect(page.locator('.toolbar-limit-chip')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send (Enter)' })).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.chat-input-toolbars').evaluateAll((rows) =>
        rows.every((row) => row.scrollWidth <= row.clientWidth + 1)
      )
    )
    .toBe(true);
});
