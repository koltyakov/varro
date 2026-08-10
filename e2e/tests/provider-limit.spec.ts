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

test('provider limit popup responds to repeated clicks', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=usage-limit');

  const chip = page.locator('.toolbar-limit-chip');
  const popup = page.locator('.provider-limit-popup');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await chip.click();
    await expect(popup).toBeVisible();
    await chip.click();
    await expect(popup).toHaveCount(0);
  }
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
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  const metaRow = page.locator('.chat-input-toolbars.toolbar-meta');
  for (const width of [348, 260]) {
    await page.setViewportSize({ width, height: 260 });
    await expect
      .poll(() =>
        metaRow.evaluate((row) => {
          const left = row.querySelector<HTMLElement>('.toolbar-meta-left');
          const right = row.querySelector<HTMLElement>('.toolbar-meta-right');
          if (!left || !right) return false;
          return Math.abs(left.getBoundingClientRect().top - right.getBoundingClientRect().top) <= 1;
        })
      )
      .toBe(true);
    await expect(metaRow.locator('.permission-mode-button .toolbar-picker-label')).toBeHidden();
    const compactLimitLabel = metaRow.locator(
      '.toolbar-limit-chip-label .toolbar-meta-compact-label'
    );
    await expect(compactLimitLabel).toBeVisible();
    await expect(compactLimitLabel).toHaveText('L');
    await expect(metaRow.locator('.toolbar-limit-chip-label .toolbar-meta-full-label')).toBeHidden();
    await expect
      .poll(() =>
        page.locator('.chat-input-toolbars').evaluateAll((rows) =>
          rows.every((row) => row.scrollWidth <= row.clientWidth + 1)
        )
      )
      .toBe(true);
  }
});

test('narrow toolbar abbreviates the MCP label', async ({ page }) => {
  await page.setViewportSize({ width: 260, height: 260 });
  await page.goto('/e2e/harness/index.html?scenario=mcp-pickers');

  const mcpLabel = page.locator('.toolbar-mcp-count-label');
  await expect(mcpLabel.locator('.toolbar-meta-compact-label')).toBeVisible();
  await expect(mcpLabel.locator('.toolbar-meta-compact-label')).toHaveText('M');
  await expect(mcpLabel.locator('.toolbar-meta-full-label')).toBeHidden();
});
