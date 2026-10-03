/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These E2E callbacks invoke and inspect plan hooks installed by the controlled harness fixture. */
import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

for (const theme of ['dark', 'light', 'high-contrast', 'high-contrast-light']) {
  test(`themed plan actions center labels and wrap without clipping in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await page.goto(`/e2e/harness/index.html?scenario=plan-ready&theme=${theme}`);

    const actions = page.locator('.assistant-dialog-summary-actions');
    const open = page.getByRole('button', { name: 'Open plan' });
    const implement = page.getByRole('button', { name: 'Implement the plan' });
    const skip = page.getByRole('button', { name: 'Skip for now' });
    await expect(implement).toHaveClass(/assistant-dialog-summary-action-implement/);
    await expect(actions).toHaveCSS('justify-content', 'flex-end');
    await expect(actions).toHaveCSS('flex-wrap', 'wrap');
    const borders = await actions
      .locator('button')
      .evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).borderColor));
    expect(new Set(borders).size).toBe(3);
    await expect(open).toHaveCSS('font-weight', '400');
    await expect(implement).toHaveCSS('font-weight', '500');
    const emphasis = await implement.evaluate((element) => {
      const style = getComputedStyle(element);
      const token = document.createElement('span');
      token.style.backgroundColor = 'var(--color-vscode-accent)';
      element.append(token);
      const accent = getComputedStyle(token).backgroundColor;
      token.remove();
      return { background: style.backgroundColor, accent };
    });
    expect(emphasis.background).not.toBe(emphasis.accent);
    await page.screenshot({ path: testInfo.outputPath('plan-actions.png') });

    await open.focus();
    await expect(open).toBeFocused();
    await expect(open).toHaveCSS('outline-style', 'none');
    await expect(open).toHaveCSS('outline-width', '0px');

    for (const width of [480, 280]) {
      await page.setViewportSize({ width, height: 800 });
      for (const button of [open, implement, skip]) {
        await expect(button).toBeVisible();
        await expect(button).toHaveCSS('min-height', '26px');
        await expect(button).toHaveCSS('border-top-width', '1px');
        const labelCenterOffset = await button.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const label = element.querySelector('span')!.getBoundingClientRect();
          return Math.abs(label.top + label.height / 2 - (box.top + box.height / 2));
        });
        expect(labelCenterOffset).toBeLessThanOrEqual(0.5);
        await expect
          .poll(() =>
            button.evaluate((element) => {
              const buttonBox = element.getBoundingClientRect();
              const actionsBox = element.parentElement!.getBoundingClientRect();
              return (
                buttonBox.left >= actionsBox.left - 1 &&
                buttonBox.right <= actionsBox.right + 1 &&
                buttonBox.top >= actionsBox.top - 1 &&
                buttonBox.bottom <= actionsBox.bottom + 1 &&
                buttonBox.right <= window.innerWidth
              );
            })
          )
          .toBe(true);
      }
    }
  });
}

test('planning mode ends up with a plan using realistic provider models', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready');

  await expect(
    page.getByLabel('Back to sessions').locator('..').getByText('Plan migration rollout')
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open plan' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Implement the plan' })).toBeVisible();
  await expect(page.locator('.assistant-turn-content').last()).toContainText('Migration Plan');
  await expect(page.getByRole('heading', { name: 'Migration Plan' })).toHaveCSS(
    'margin-top',
    '0px'
  );
  await expect(page.locator('.assistant-turn-content').last()).toContainText(
    'Validate default-permission flows with a real bash request'
  );

  await expect(page.locator('.model-name-text')).toContainText('GLM 5.1');
  await page.locator('.model-picker-btn').click();
  const modelPicker = page.locator('.dropdown-menu').first();
  await expect(modelPicker.getByText('GitHub Copilot', { exact: true })).toBeVisible();
  await expect(modelPicker.getByRole('button', { name: 'GPT-5 mini', exact: true })).toBeVisible();
  await expect(modelPicker.getByText('Z.ai', { exact: true })).toBeVisible();
  await expect(page.locator('.dropdown-item').filter({ hasText: 'GLM 5.1' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByLabel('Select agent').click();
  await expect(
    page.getByRole('button', { name: /Plan Draft implementation plans/i })
  ).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Open plan' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { planOpenRequests: string[] };
          }
        ).__varroE2E;
        return value?.planOpenRequests[0] || null;
      })
    )
    .toContain('# Migration Plan');
});

test('implementing a plan sends the build prompt', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready');

  await page.getByRole('button', { name: 'Implement the plan' }).click();

  const action = page.locator('.plan-implementation-action');
  await expect(action).toHaveText('Implement the plan');
  await expect(action).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(action).toHaveCSS('border-top-width', '0px');
  await expect(action).not.toHaveClass(/user-message-card-editable/);
  await expect(action.locator('.user-message-text-scroll')).toHaveCount(0);
  await expect(page.locator('.chat-turn-assistant').last()).toContainText(
    'Mock assistant response for: Implement the plan from your last response'
  );

  const promptBody = await getE2EState(page, () => {
    const value = (
      window as Window & {
        __varroE2E?: { requests: Array<{ path: string; body?: unknown }> };
      }
    ).__varroE2E;
    return value?.requests
      .filter((request) =>
        new URL(request.path, 'http://varro.test').pathname.endsWith('/prompt_async')
      )
      .at(-1)?.body as { agent?: string } | undefined;
  });

  expect(promptBody).toMatchObject({
    agent: 'build',
    parts: [
      {
        type: 'text',
        text: 'Implement the plan from your last response in the current workspace. Make the code changes instead of revising the plan.',
      },
    ],
  });
});

test('skipping a plan replaces the plan actions with a confirmation', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready');

  await page.getByRole('button', { name: 'Skip for now' }).click();

  await page.mouse.move(0, 0);
  await expect(page.getByRole('button', { name: 'Open plan' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Implement the plan' })).toBeHidden();
  await expect(page.locator('.assistant-dialog-summary-plan-skipped-label')).toHaveText(
    'Plan skipped'
  );
});

test('keeps skipped plan actions hidden after reload', async ({ page }) => {
  // Reload must retain the same plan revision rather than regenerate a newer session timestamp.
  await page.clock.setFixedTime(new Date('2026-09-29T12:00:00Z'));
  await page.goto('/e2e/harness/index.html?scenario=plan-ready');

  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.mouse.move(0, 0);
  await expect(page.getByRole('button', { name: 'Open plan' })).toBeHidden();

  await page.reload();

  await expect(page.locator('.assistant-dialog-summary-plan-skipped-label')).toHaveText(
    'Plan skipped'
  );
  await expect(page.getByRole('button', { name: 'Open plan' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Implement the plan' })).toBeHidden();
});

test('skipped plan actions appear on hover and keyboard focus without moving the row', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready');
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.mouse.move(0, 0);

  const row = page.locator('.assistant-dialog-summary-plan-skipped');
  const open = row.getByRole('button', { name: 'Open plan' });
  const implement = row.getByRole('button', { name: 'Implement the plan' });
  await expect(open).toBeHidden();
  const before = await row.boundingBox();
  await row.hover();
  await expect(open).toBeVisible();
  await expect(implement).toBeVisible();
  expect(await row.boundingBox()).toEqual(before);
  await open.click();
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & { __varroE2E?: { planOpenRequests: string[] } })
          .__varroE2E;
        return value?.planOpenRequests.length ?? 0;
      })
    )
    .toBe(1);

  await page.mouse.move(0, 0);
  await page.getByRole('textbox', { name: 'Message composer' }).click();
  await expect(open).toBeHidden();
  await row.focus();
  await expect(open).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(open).toBeFocused();
  await implement.click();
  await expect(page.locator('.plan-implementation-action')).toHaveText('Implement the plan');
  await expect(row).toHaveCount(0);
  await expect(page.locator('.assistant-dialog-summary-plan-skipped-actions')).toHaveCount(0);
});
