/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: The test inspects controlled request records from the isolated E2E harness. */
import { expect, test } from '@playwright/test';

test('Problems picker hides added entries and restores them when their attachment is removed', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=file-search');
  const composer = page.getByRole('textbox', { name: 'Message composer' });
  await composer.fill('Review ');
  await page.evaluate(() =>
    window.postMessage(
      {
        type: 'command/attach-problems',
        payload: {
          diagnostics: [
            {
              path: '/workspace/varro/playwright.config.ts',
              line: 1,
              severity: 'error',
              message: 'Missing playwright dependency',
            },
          ],
        },
      },
      '*'
    )
  );
  const attached = page
    .locator('.chat-attachments-container .chat-attachment-chip')
    .filter({ hasText: 'Problems' });
  await expect(attached.locator('.chip-detail')).toHaveText('1');
  await composer.pressSequentially('/problems ');
  const choices = page.locator('.completion-problems');
  await expect(choices).toHaveCount(2);
  await expect(choices.first()).toContainText('1 workspace problem');
  await expect(page.locator('.composer-completion-menu')).not.toContainText(
    'Missing playwright dependency'
  );
  await choices.nth(1).click();
  await composer.pressSequentially('/problems ');
  await expect(choices).toHaveCount(0);
  await expect(page.locator('.composer-completion-empty')).toHaveText(
    'All problems already added to context'
  );
  await page.evaluate(() =>
    window.postMessage(
      {
        type: 'command/attach-problems',
        payload: {
          diagnostics: [
            {
              path: '/workspace/varro/src/other.ts',
              line: 9,
              severity: 'warning',
              message: 'Unused workspace variable',
            },
          ],
        },
      },
      '*'
    )
  );
  await expect(attached.locator('.chip-detail')).toHaveText('1');
  await composer.press('Escape');
  await attached.locator('.chip-remove').click();
  await composer.press('End');
  await composer.pressSequentially(' ');
  await expect(choices).toHaveCount(2);
  await expect(choices.nth(1)).toContainText('Missing playwright dependency');
  await expect(page.locator('.composer-completion-menu')).not.toContainText(
    'Unused workspace variable'
  );
  await choices.first().click();
  const inline = composer.locator('[data-chip-type="mention-problems"]');
  await expect(inline).toHaveCount(2);
  await expect(inline.last().locator('.inline-chip-label')).toHaveText('Problems');
  await expect(inline.last().locator('.inline-chip-detail')).toHaveText('1');
  await composer.pressSequentially('/problems ');
  await expect(choices).toHaveCount(0);
  await expect(page.locator('.composer-completion-empty')).toHaveText(
    'All problems already added to context'
  );
});

test('Problems search filters locally across words and selects the first match on Enter', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=file-search');
  const composer = page.getByRole('textbox', { name: 'Message composer' });
  await composer.fill('/problems ');
  const choices = page.locator('.completion-problems');
  await expect(choices).toHaveCount(3);
  await composer.pressSequentially('unused warning other.ts');
  await expect(choices).toHaveCount(2);
  await expect(choices.first()).toContainText('All');
  await expect(choices.nth(1)).toHaveClass(/selected/);
  await expect(choices.nth(1)).toContainText('Unused workspace variable');
  await composer.fill('/problems no_such_problem');
  await expect(choices).toHaveCount(0);
  await expect(page.locator('.composer-completion-empty')).toHaveText('No matching problems');
  await composer.fill('/problems warning /workspace/varro/src/other.ts unused');
  await expect(choices).toHaveCount(2);
  await expect(choices.nth(1)).toHaveClass(/selected/);
  expect(
    await page.evaluate(
      () =>
        (
          window as Window & {
            __varroE2E?: { requests: Array<{ path: string }> };
          }
        ).__varroE2E?.requests.filter((request) => request.path === '/varro/workspace-problems')
          .length
    )
  ).toBe(1);
  await composer.press('Enter');
  await expect(
    composer.locator('[data-chip-type="mention-problems"] .inline-chip-detail')
  ).toHaveText('L9');
  await expect(
    composer.locator('[data-chip-type="mention-problems"] .inline-chip-label')
  ).toHaveText('other.ts');
  await expect(composer).not.toContainText('/problems');
});

test('VS Code Add to Context accumulates attachments without changing the draft text', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=file-search');
  const composer = page.getByRole('textbox', { name: 'Message composer' });
  await expect(composer).toBeVisible();
  await composer.fill('Explain this');
  await page.evaluate(() =>
    window.postMessage(
      {
        type: 'command/attach-problems',
        payload: {
          diagnostics: [
            {
              path: '/workspace/varro/oxlint.config.mts',
              line: 1,
              column: 30,
              severity: 'error',
              message: "Cannot find module 'oxlint'",
              source: 'ts',
              code: 2307,
            },
          ],
        },
      },
      '*'
    )
  );
  const chip = page
    .locator('.chat-attachments-container .chat-attachment-chip')
    .filter({ hasText: 'Problems' });
  await expect(chip).toHaveCount(1);
  await expect(chip.locator('.chip-detail')).toHaveText('1');
  await expect(composer).toHaveText('Explain this');
  await expect(composer.locator('[data-chip-type="mention-problems"]')).toHaveCount(0);
  await expect(composer).not.toContainText('Cannot find module');
  await chip.hover();
  await expect(page.getByRole('tooltip')).toContainText("Cannot find module 'oxlint'");
  await page.evaluate(() =>
    window.postMessage(
      {
        type: 'command/attach-problems',
        payload: {
          diagnostics: [
            {
              path: '/workspace/varro/other.ts',
              line: 9,
              severity: 'warning',
              message: 'Unused variable',
            },
          ],
        },
      },
      '*'
    )
  );
  await expect(chip.locator('.chip-detail')).toHaveText('2');
  await expect(composer).toHaveText('Explain this');
  expect(
    await page.evaluate(
      () =>
        (
          window as Window & {
            __varroE2E?: { requests: Array<{ path: string }> };
          }
        ).__varroE2E?.requests.some((request) => request.path.includes('prompt_async')) ?? false
    )
  ).toBe(false);
});

for (const selection of ['All', 'Unused workspace variable']) {
  test(`/problems attaches ${selection} from the workspace picker`, async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=file-search');
    const composer = page.getByRole('textbox', { name: 'Message composer' });
    await expect(composer).toBeVisible();
    await composer.fill('/problems');
    await expect(page.locator('.composer-completion-menu')).toContainText('/problems');
    await composer.press('Enter');
    await expect(composer).toHaveText('/problems ');
    const choices = page.locator('.completion-problems');
    await expect(choices).toHaveCount(3);
    await expect(choices.first()).toContainText('All');
    await page.evaluate(() => {
      document.documentElement.style.setProperty(
        '--vscode-problemsErrorIcon-foreground',
        'rgb(240, 80, 80)'
      );
      document.documentElement.style.setProperty(
        '--vscode-problemsWarningIcon-foreground',
        'rgb(220, 170, 30)'
      );
    });
    await expect(choices.nth(0).locator('.problems-icon')).toHaveCSS('color', 'rgb(240, 80, 80)');
    await expect(choices.nth(1).locator('.problems-icon')).toHaveAttribute(
      'data-severity',
      'error'
    );
    await expect(choices.nth(1).locator('.problems-icon')).toHaveCSS('color', 'rgb(240, 80, 80)');
    await expect(choices.nth(2).locator('.problems-icon')).toHaveAttribute(
      'data-severity',
      'warning'
    );
    await expect(choices.nth(2).locator('.problems-icon')).toHaveCSS('color', 'rgb(220, 170, 30)');
    await choices.filter({ hasText: selection }).click();
    const chips = composer.locator('[data-chip-type="mention-problems"]');
    await expect(chips).toHaveCount(1);
    const chip = chips.last();
    await expect(chip.locator('.inline-chip-label')).toHaveText(
      selection === 'All' ? 'Problems' : 'other.ts'
    );
    await expect(chip.locator('.inline-chip-detail')).toHaveText(selection === 'All' ? '2' : 'L9');
    await expect(
      page
        .locator('.chat-attachments-container .chat-attachment-chip')
        .filter({ hasText: 'Problems' })
    ).toHaveCount(0);
    await expect(chip.locator('.problems-icon')).toHaveCSS(
      'color',
      selection === 'All' ? 'rgb(240, 80, 80)' : 'rgb(220, 170, 30)'
    );
    await chip.hover();
    await expect(page.getByRole('tooltip')).toContainText('Unused workspace variable');
    await page.mouse.move(0, 0);
    await chip.evaluate((element) => {
      const range = document.createRange();
      range.setStartAfter(element);
      range.collapse(true);
      const browserSelection = window.getSelection()!;
      browserSelection.removeAllRanges();
      browserSelection.addRange(range);
    });
    await composer.press('Backspace');
    await expect(chips).toHaveCount(0);
    await composer.press('ControlOrMeta+z');
    await expect(chips).toHaveCount(1);
    await composer.press('End');
    await composer.pressSequentially('Explain these diagnostics');
    await composer.press('Enter');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const requests = (
            window as Window & {
              __varroE2E?: {
                requests: Array<{ path: string; body?: { parts?: Array<{ text?: string }> } }>;
              };
            }
          ).__varroE2E?.requests;
          return (
            requests
              ?.find((request) => request.path.includes('prompt_async'))
              ?.body?.parts?.map((part) => part.text ?? '')
              .join('\n') ?? ''
          );
        })
      )
      .toContain('Unused workspace variable');
    const prompt = await page.evaluate(
      () =>
        (
          window as Window & {
            __varroE2E?: {
              requests: Array<{ path: string; body?: { parts?: Array<{ text?: string }> } }>;
            };
          }
        ).__varroE2E?.requests
          .find((request) => request.path.includes('prompt_async'))
          ?.body?.parts?.map((part) => part.text ?? '')
          .join('\n') ?? ''
    );
    expect(prompt.includes('Missing playwright dependency')).toBe(selection === 'All');
    expect(prompt).not.toContain('/problems');
    const message = page
      .locator('.user-message-card')
      .filter({ hasText: 'Explain these diagnostics' })
      .last();
    await expect(message).not.toContainText('Unused workspace variable');
    await expect(message.locator('.user-message-text-scroll .inline-chip')).toHaveCount(1);
    await expect(message.locator('.user-message-text-scroll .inline-chip').last()).toContainText(
      selection === 'All' ? 'Problems' : 'other.ts'
    );
    await expect(
      message.locator('.message-attachment-chip').filter({ hasText: 'Problems' })
    ).toHaveCount(0);
  });
}

for (const enabled of [true, false]) {
  test(`Problems chip hides details and respects ${enabled ? 'enabled' : 'disabled'} context`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 474, height: 650 });
    await page.goto('/e2e/harness/index.html?scenario=file-search');
    const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
    await expect(composer).toBeVisible();
    await page.evaluate(() =>
      window.postMessage(
        {
          type: 'context/update',
          payload: {
            workspacePath: '/workspace/varro',
            activeFile: {
              path: '/workspace/varro/playwright.config.ts',
              relativePath: 'playwright.config.ts',
              language: 'typescript',
            },
            selection: { startLine: 1, endLine: 1 },
            diagnosticCounts: { errors: 1, warnings: 0 },
            diagnostics: [
              {
                path: '/workspace/varro/playwright.config.ts',
                line: 1,
                column: 39,
                severity: 'error',
                message: "Cannot find module '@playwright/test'",
                source: 'ts',
                code: 2307,
                intersectsSelection: true,
              },
            ],
          },
        },
        '*'
      )
    );
    const strip = page.locator('.chat-attachments-container');
    const problems = strip.getByRole('button', { name: 'Problems 1' });
    await expect(problems).toHaveAttribute('aria-pressed', 'true');
    await expect(problems.locator('.chip-label')).toHaveText('Problems');
    await expect(problems.locator('.chip-detail')).toHaveText('1');
    await expect(problems.locator('.problems-icon')).toHaveAttribute('data-severity', 'error');
    await page.evaluate(() =>
      document.documentElement.style.setProperty(
        '--vscode-problemsErrorIcon-foreground',
        'rgb(240, 80, 80)'
      )
    );
    await expect(problems.locator('.problems-icon')).toHaveCSS('color', 'rgb(240, 80, 80)');
    await expect(problems).not.toContainText('·');
    await expect(problems).not.toHaveAttribute('title');
    await problems.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toContainText('1 error, 0 warnings');
    await expect(tooltip).toContainText("Cannot find module '@playwright/test'");
    await expect(tooltip).toContainText('playwright.config.ts:1:39');
    await expect(tooltip).toContainText('ts 2307');
    await expect(tooltip).toContainText('In selection');
    const tooltipBox = await tooltip.boundingBox();
    expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
    expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(474);
    expect(tooltipBox!.y).toBeGreaterThanOrEqual(0);
    const fileDetail = strip
      .locator('.chat-attachment-chip')
      .filter({ hasText: 'playwright.config.ts' })
      .locator('.chip-detail');
    for (const property of ['font-size', 'color', 'padding-left', 'border-left-width']) {
      const expected = await fileDetail.evaluate(
        (element, name) => getComputedStyle(element).getPropertyValue(name),
        property
      );
      await expect(problems.locator('.chip-detail')).toHaveCSS(property, expected);
    }
    await problems.click();
    await expect(problems).toHaveAttribute('aria-pressed', 'false');
    await expect(problems.locator('.problems-icon')).not.toHaveCSS('color', 'rgb(240, 80, 80)');
    await expect(tooltip).toHaveCount(0);
    await page.mouse.move(0, 0);
    await problems.hover();
    await expect(tooltip).toContainText('Not included in context. Click to enable.');
    await expect(tooltip).toContainText("Cannot find module '@playwright/test'");
    if (enabled) {
      await problems.press('Enter');
      await expect(problems).toHaveAttribute('aria-pressed', 'true');
    }
    await composer.fill('Explain the problem in this file');
    await composer.press('Enter');
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as Window & {
              __varroE2E?: { requests: Array<{ path: string }> };
            }
          ).__varroE2E?.requests.some((request) => request.path.includes('prompt_async'))
        )
      )
      .toBe(true);
    const hasDetails = await page.evaluate(
      () =>
        (
          window as Window & {
            __varroE2E?: {
              requests: Array<{ path: string; body?: { parts?: Array<{ text?: string }> } }>;
            };
          }
        ).__varroE2E?.requests
          .find((request) => request.path.includes('prompt_async'))
          ?.body?.parts?.some((part) =>
            part.text?.includes("Cannot find module '@playwright/test'")
          ) ?? false
    );
    expect(hasDetails).toBe(enabled);
    const message = page
      .locator('.user-message-card')
      .filter({ hasText: 'Explain the problem in this file' })
      .last();
    await expect(message).toBeVisible();
    await expect(message).not.toContainText('Cannot find module');
    await expect(message).not.toContainText('[VS Code problems');
    if (enabled) {
      const overflow = message.getByRole('button', { name: /Show \d+ more attachments/ });
      if (await overflow.isVisible()) await overflow.click();
    }
    const sentProblems = page.locator('.message-attachment-chip').filter({ hasText: 'Problems' });
    await expect(sentProblems).toHaveCount(enabled ? 1 : 0);
    if (enabled) {
      await expect(sentProblems.locator('.chip-detail')).toHaveText('1');
      await expect(sentProblems.locator('.problems-icon')).toHaveAttribute(
        'data-severity',
        'error'
      );
      await sentProblems.hover();
      await expect(tooltip).toContainText("Cannot find module '@playwright/test'");
      await expect(tooltip).toContainText('Click to view captured details');
      await testInfo.attach('problem-context', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    }
  });
}
