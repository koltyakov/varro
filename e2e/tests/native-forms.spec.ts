import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { getE2EState } from './helpers';

async function choose(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page
    .getByRole('listbox', { name: label, exact: true })
    .locator(`[data-value="${value}"]`)
    .click();
}

async function checkInlineDetails(choice: Locator) {
  const layout = await choice.evaluate((element) => {
    const label = element.querySelector('.question-option-label')!.getClientRects()[0]!;
    const description = element.querySelector('.question-option-desc')!.getClientRects()[0]!;
    return {
      labelRight: label.right,
      labelTop: label.top,
      detailLeft: description.left,
      detailTop: description.top,
    };
  });
  expect(layout.detailLeft).toBeGreaterThan(layout.labelRight);
  expect(Math.abs(layout.detailTop - layout.labelTop)).toBeLessThanOrEqual(2);
}

async function checkGrowingInput(input: Locator) {
  await expect(input).toHaveJSProperty('tagName', 'TEXTAREA');
  await expect(input).toHaveAttribute('rows', '1');
  const metrics = await input.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      line: Number.parseFloat(style.lineHeight),
      inset:
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom) +
        Number.parseFloat(style.borderTopWidth) +
        Number.parseFloat(style.borderBottomWidth),
      height: element.getBoundingClientRect().height,
    };
  });
  expect(metrics.height).toBeCloseTo(metrics.line + metrics.inset, 0);
  const original = await input.elementHandle();
  await input.fill('First line');
  await input.press('End');
  await input.press('Shift+Enter');
  await input.pressSequentially('Second line');
  await expect(input).toHaveValue('First line\nSecond line');
  await expect(input).toBeFocused();
  expect(await input.evaluate((element, previous) => element === previous, original)).toBe(true);
  expect((await input.boundingBox())!.height).toBeCloseTo(2 * metrics.line + metrics.inset, 0);
  expect(await input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(
    'First line\nSecond line'.length
  );
  await input.fill('One\nTwo\nThree\nFour\nFive\nSix');
  expect((await input.boundingBox())!.height).toBeCloseTo(4 * metrics.line + metrics.inset, 0);
  await expect(input).toHaveCSS('overflow-y', 'auto');
  expect(await input.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await input.fill('Wrapped text '.repeat(80));
  expect((await input.boundingBox())!.height).toBeCloseTo(4 * metrics.line + metrics.inset, 0);
  await input.fill('Short again');
  expect((await input.boundingBox())!.height).toBeCloseTo(metrics.height, 0);
  await input.fill('');
}

async function checkIntegratedCustomInput(input: Locator, optionHeight: number) {
  const row = input.locator(
    'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " native-question-choice ")][1]'
  );
  const rowBox = (await row.boundingBox())!;
  const inputBox = (await input.boundingBox())!;
  expect(rowBox.height).toBeCloseTo(optionHeight, 0);
  expect(inputBox.y - rowBox.y).toBeCloseTo(1, 0);
  expect(rowBox.x + rowBox.width - inputBox.x - inputBox.width).toBeCloseTo(1, 0);
  expect(rowBox.y + rowBox.height - inputBox.y - inputBox.height).toBeCloseTo(1, 0);
  for (const side of ['top', 'right', 'bottom'])
    await expect(row).toHaveCSS(`padding-${side}`, '0px');
  for (const side of ['top', 'right', 'bottom', 'left']) {
    await expect(input).toHaveCSS(`margin-${side}`, '0px');
    await expect(input).toHaveCSS(`border-${side}-width`, '0px');
  }
  await expect(input).toHaveCSS('padding-left', '0px');
  await expect(input).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await input.hover();
  await expect(input).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await input.focus();
  await expect(input).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
}

for (const width of [480, 1100]) {
  test(`integrates custom inputs into option rows without an inset background at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/e2e/harness/index.html?scenario=native-question-inputs');
    const custom = page.getByRole('textbox', { name: 'Capabilities: custom option', exact: true });
    const standardRow = page.locator('.native-multiselect-choice').first();
    const optionHeight = (await standardRow.boundingBox())!.height;
    const labelLeft = (await standardRow.locator('.question-option-label').boundingBox())!.x;
    expect((await custom.boundingBox())!.x).toBeCloseTo(labelLeft, 0);
    for (const theme of ['vscode-dark', 'vscode-light', 'vscode-high-contrast-light']) {
      await page.evaluate((bodyTheme) => {
        document.body.className = bodyTheme;
      }, theme);
      await checkIntegratedCustomInput(custom, optionHeight);
    }
    await custom.fill('Custom value');
    await page
      .getByRole('checkbox', { name: 'Capabilities: select custom value 1', exact: true })
      .check();
    await checkIntegratedCustomInput(custom, optionHeight);
    await page.screenshot({ path: testInfo.outputPath('integrated-checkbox-input.png') });
    await page.goto('/e2e/harness/index.html?scenario=native-question-prompt');
    const customAnswer = page.getByRole('textbox', {
      name: 'Restore actual limits: custom answer',
      exact: true,
    });
    for (const theme of ['vscode-dark', 'vscode-light', 'vscode-high-contrast-light']) {
      await page.evaluate((bodyTheme) => {
        document.body.className = bodyTheme;
      }, theme);
      await checkIntegratedCustomInput(customAnswer, optionHeight);
    }
    await customAnswer.fill('My answer');
    await expect(page.getByRole('radio', { name: 'Custom answer', exact: true })).toBeChecked();
    await checkIntegratedCustomInput(customAnswer, optionHeight);
    await page.screenshot({ path: testInfo.outputPath('integrated-radio-input.png') });
  });

  test(`grows free text and custom values to four input-styled lines at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/e2e/harness/index.html?scenario=native-question-inputs');
    const form = page.getByRole('form', { name: 'Questions', exact: true });
    await expect(form.getByRole('radio')).toHaveCount(0);
    await expect(form.getByRole('combobox')).toHaveCount(0);
    const notes = form.getByRole('textbox', { name: 'Notes', exact: true });
    const custom = form.getByRole('textbox', { name: 'Capabilities: custom option', exact: true });
    for (const input of [notes, custom]) await checkGrowingInput(input);
    await notes.fill('First');
    await notes.press('End');
    await notes.press('Enter');
    await notes.pressSequentially('Second');
    await expect(notes).toHaveValue('First\nSecond');
    await expect(form.getByRole('button', { name: /Add custom value/ })).toHaveCount(0);
    await expect(form.getByText('Custom values', { exact: true })).toHaveCount(0);
    await expect(form.getByText(/Enter to add/)).toHaveCount(0);
    await custom.fill('One\nTwo\nThree\nFour\nFive');
    await page.screenshot({ path: testInfo.outputPath('growing-inputs.png') });
    await page.reload();
    await expect(notes).toHaveValue('First\nSecond');
    await expect(custom).toHaveValue('One\nTwo\nThree\nFour\nFive');
    expect(await custom.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true
    );
    await expect(form).toBeVisible();
    await expect(form.locator('.native-form-clear')).toHaveCount(0);
    await page.goto('/e2e/harness/index.html?scenario=native-question-prompt');
    await checkGrowingInput(
      page.getByRole('textbox', { name: 'Restore actual limits: custom answer', exact: true })
    );
    await expect(page.getByRole('form', { name: 'Questions', exact: true })).toBeVisible();
  });

  test(`adds editable custom checkbox rows automatically at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/e2e/harness/index.html?scenario=native-question-inputs');
    const form = page.getByRole('form', { name: 'Questions', exact: true });
    const search = form.getByRole('checkbox', { name: 'Search', exact: true });
    await search
      .locator('..')
      .locator('..')
      .getByText('Search across the workspace', { exact: true })
      .click();
    await expect(search).toBeChecked();
    await checkInlineDetails(search.locator('..').locator('..'));
    const custom = form.getByRole('textbox', { name: 'Capabilities: custom option', exact: true });
    const rows = form.locator('[data-custom-row]');
    const firstCheck = form.getByRole('checkbox', {
      name: 'Capabilities: select custom value 1',
      exact: true,
    });
    await expect(rows).toHaveCount(1);
    await expect(firstCheck).toBeDisabled();
    await expect(custom).toHaveAttribute('placeholder', 'Type your own answer');
    await expect(rows.getByRole('button')).toHaveCount(0);
    await custom.fill('Custom one');
    await expect(rows).toHaveCount(2);
    await expect(firstCheck).toBeEnabled();
    await expect(firstCheck).not.toBeChecked();
    await expect(custom).toBeFocused();
    await custom.press('End');
    await custom.press('Enter');
    await custom.pressSequentially('with details');
    await expect(custom).toHaveValue('Custom one\nwith details');
    await expect(custom).toBeFocused();
    await firstCheck.check();
    const second = form.getByRole('textbox', {
      name: 'Capabilities: custom option 2',
      exact: true,
    });
    await second.fill('x'.repeat(300));
    await expect(rows).toHaveCount(3);
    expect(
      await rows.nth(1).evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('custom-checkbox-rows.png') });
    await expect(rows.getByRole('button')).toHaveCount(0);
    const blankInput = await rows.last().getByRole('textbox').elementHandle();
    await second.fill('');
    await expect(rows).toHaveCount(2);
    await expect(second).toBeFocused();
    expect(await second.evaluate((element, original) => element === original, blankInput)).toBe(
      true
    );
    await second.fill('Keep unchecked');
    await expect(rows).toHaveCount(3);
    await page.reload();
    await expect(search).toBeChecked();
    await expect(custom).toHaveValue('Custom one\nwith details');
    await expect(firstCheck).toBeChecked();
    await expect(second).toHaveValue('Keep unchecked');
    await expect(
      form.getByRole('checkbox', { name: 'Capabilities: select custom value 2', exact: true })
    ).not.toBeChecked();
    await expect(
      form.getByRole('checkbox', { name: 'Capabilities: select custom value 3', exact: true })
    ).toBeDisabled();
    await firstCheck.uncheck();
    await expect(custom).toHaveValue('Custom one\nwith details');
    await firstCheck.check();
    await form.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(form).toHaveCount(0);
    const reply = await getE2EState(page, () => {
      // SAFETY: The harness owns this recorded API request list.
      const harness = (
        window as Window & { __varroE2E?: { requests: Array<{ path: string; body?: unknown }> } }
      ).__varroE2E;
      return harness?.requests.find(
        (request) => request.path === '/question/frm_native_question/reply'
      );
    });
    expect(reply?.body).toEqual({
      kind: 'native-form',
      sessionID: 'session-native-question',
      answer: { capabilities: ['search', 'Custom one\nwith details'] },
    });
  });
}

for (const width of [480, 1100]) {
  test(`styles native form menus and keeps labels, validation and checkboxes aligned at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/e2e/harness/index.html?scenario=native-form-prompt');
    const trigger = page.getByRole('combobox', { name: 'Region', exact: true });
    await trigger.click();
    const menu = page.getByRole('listbox', { name: 'Region', exact: true });
    await expect(menu).toBeVisible();
    await expect(page.locator('.native-form select')).toHaveCount(0);
    await expect(menu).toHaveCSS('position', 'fixed');
    await expect(menu).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const menuBox = await menu.boundingBox();
    expect(menuBox!.x).toBeGreaterThanOrEqual(8);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(width - 8);
    const rightInset = await trigger.evaluate((element) => {
      const icon = element.querySelector('.native-form-select-chevron')!;
      return element.getBoundingClientRect().right - icon.getBoundingClientRect().right;
    });
    expect(rightInset).toBeGreaterThanOrEqual(12);
    await page.screenshot({ path: testInfo.outputPath('themed-dropdown.png') });
    await trigger.press('Escape');
    await expect(menu).toHaveCount(0);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(trigger).toBeFocused();
    const region = page.locator('[data-field-key="region"]');
    await expect(region).toHaveCSS('margin-top', '16px');
    await expect(region).toHaveCSS('border-top-width', '0px');
    await expect(region).toHaveCSS('border-right-width', '0px');
    const error = region.getByRole('alert');
    await expect(error).toHaveText('Answer required');
    const required = region.locator('.native-form-required');
    await expect(required).toHaveText('*');
    await expect(required).toHaveAttribute('aria-hidden', 'true');
    expect(
      await required.evaluate(
        (element) =>
          getComputedStyle(element).color !== getComputedStyle(element.parentElement!).color
      )
    ).toBe(true);
    await expect(trigger).toHaveAttribute('aria-required', 'true');
    await expect(region.locator('.native-form-field-heading')).not.toContainText('(required)');
    await expect(error).toHaveCSS('font-size', '11px');
    await expect(error).toHaveCSS('margin-top', '0px');
    const labelBox = await region.locator('.native-form-field-heading').boundingBox();
    const controlBox = await trigger.boundingBox();
    const errorBox = await error.boundingBox();
    expect(controlBox!.y - labelBox!.y - labelBox!.height).toBeCloseTo(4, 0);
    expect(errorBox!.y - controlBox!.y - controlBox!.height).toBeCloseTo(4, 0);
    const checkbox = page.getByRole('checkbox', {
      name: 'External setup: I completed this action',
      exact: true,
    });
    const alignment = await checkbox.evaluate((element) => {
      const control = element.getBoundingClientRect();
      const label = element.closest('label')!.getBoundingClientRect();
      return Math.abs(control.top + control.height / 2 - label.top - label.height / 2);
    });
    expect(alignment).toBeLessThanOrEqual(1);
    await page.getByRole('textbox', { name: 'Retry count', exact: true }).fill('0');
    const clear = page.getByRole('button', { name: 'Clear Retry count', exact: true });
    await expect(clear).toBeVisible();
    await expect(page.getByText('Leave unanswered', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('compact-validation.png') });
    await clear.click();
    await expect(page.getByRole('textbox', { name: 'Retry count', exact: true })).toHaveValue('');
    await expect(clear).toHaveCount(0);
  });
}

test('chooses themed dropdown options with the keyboard without submitting the form', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=native-form-prompt');
  const region = page.getByRole('combobox', { name: 'Region', exact: true });
  await region.focus();
  await region.press('ArrowDown');
  await region.press('End');
  await region.press('Enter');
  await expect(region).toBeFocused();
  await expect(region).toHaveText('Same region');
  await expect(region).toHaveAttribute('aria-expanded', 'false');
  await region.press('Space');
  const menu = page.getByRole('listbox', { name: 'Region', exact: true });
  await expect(menu.locator('[data-value="value:west"]')).toHaveAttribute('aria-selected', 'true');
  await region.press('Tab');
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Connection settings' })).toBeVisible();
});

test('submits typed answers by key and omits an inactive required field', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=native-form-prompt');
  const form = page.getByRole('form', { name: 'Connection settings' });
  await expect(form).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Proxy URL', exact: true })).toHaveCount(0);
  await choose(page, 'Use proxy?', 'true');
  await page
    .getByRole('textbox', { name: 'Proxy URL', exact: true })
    .fill('https://proxy.example.com');
  await choose(page, 'Use proxy?', 'false');
  await choose(page, 'Use proxy?', 'true');
  await expect(page.getByRole('textbox', { name: 'Proxy URL', exact: true })).toHaveValue(
    'https://proxy.example.com'
  );
  await choose(page, 'Use proxy?', 'false');
  await page.getByRole('textbox', { name: 'Retry count', exact: true }).fill('0');
  await choose(page, 'Region', 'value:west');
  await page
    .getByRole('checkbox', { name: 'External setup: I completed this action', exact: true })
    .check();
  // A text input uses the form's native Enter submission, not a synthetic button click.
  await page.getByRole('textbox', { name: 'Retry count', exact: true }).press('Enter');
  await expect(form).toHaveCount(0);
  const requests = await getE2EState(page, () => {
    // SAFETY: The controlled harness exposes recorded API requests on this browser global.
    const harness = (
      window as Window & {
        __varroE2E?: { requests: Array<{ path: string; method: string; body?: unknown }> };
      }
    ).__varroE2E;
    return harness?.requests ?? [];
  });
  expect(requests.filter((request) => request.path === '/question/frm_native/reply')).toMatchObject(
    [
      {
        method: 'POST',
        body: {
          kind: 'native-form',
          sessionID: 'session-native-form',
          answer: { proxy: false, count: 0, region: 'west', setup: true },
        },
      },
    ]
  );
});

test('focuses missing required answers and does not acknowledge external work automatically', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=native-form-prompt');
  const form = page.getByRole('form', { name: 'Connection settings' });
  await expect(form).toBeVisible();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Region', exact: true })).toBeFocused();
  await expect(
    page.getByText('Confirm that you completed the external action', { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'External setup: I completed this action', exact: true })
  ).not.toBeChecked();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(form).toHaveCount(0);
});

test('restores pending form answers after reload without submitting them', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=native-form-prompt');
  await choose(page, 'Use proxy?', 'true');
  await page
    .getByRole('textbox', { name: 'Proxy URL', exact: true })
    .fill('https://retained.example.com');
  await page.getByRole('textbox', { name: 'Retry count', exact: true }).fill('0');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Use proxy?', exact: true })).toHaveText('Yes');
  await expect(page.getByRole('textbox', { name: 'Proxy URL', exact: true })).toHaveValue(
    'https://retained.example.com'
  );
  await expect(page.getByRole('textbox', { name: 'Retry count', exact: true })).toHaveValue('0');
  const noReply = await getE2EState(page, () => {
    // SAFETY: This browser global is the harness-owned recorded request list.
    const harness = (window as Window & { __varroE2E?: { requests: Array<{ path: string }> } })
      .__varroE2E;
    return !harness?.requests.some((request) => request.path === '/question/frm_native/reply');
  });
  expect(noReply).toBe(true);
});

test('shows native question choices, descriptions and custom input without opening a dropdown', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=native-question-prompt');
  const form = page.getByRole('form', { name: 'Questions', exact: true });
  await expect(form).toBeVisible();
  await expect(form.getByRole('combobox')).toHaveCount(0);
  await expect(form.getByRole('radio')).toHaveCount(3);
  const separate = form.getByRole('radio', { name: 'Use separate Codex login', exact: true });
  const switchChat = form.getByRole('radio', { name: 'Switch chat to Codex', exact: true });
  await expect(separate).not.toBeChecked();
  await expect(switchChat).not.toBeChecked();
  await expect(form.getByText('Keep current chat authentication.', { exact: false })).toBeVisible();
  await expect(
    form.getByText('Use Codex authentication for both chat and usage.', { exact: false })
  ).toBeVisible();
  await expect(
    form.getByRole('textbox', { name: 'Restore actual limits: custom answer', exact: true })
  ).toBeVisible();
  const firstChoice = separate.locator('..');
  await checkInlineDetails(firstChoice);
  expect(
    await firstChoice
      .locator('.question-option-desc')
      .evaluate((element) => element.getClientRects().length)
  ).toBeGreaterThan(1);
  const customChoice = form.locator('.question-option-custom');
  await expect(customChoice.locator('.question-option-label')).toHaveCount(0);
  const customInput = customChoice.getByRole('textbox');
  await expect(customInput).toHaveAttribute('placeholder', 'Type your own answer');
  const alignment = await customChoice.evaluate((element) => {
    const radio = element.querySelector('input')!.getBoundingClientRect();
    const textarea = element.querySelector('textarea')!;
    const style = getComputedStyle(textarea);
    const textCenter =
      textarea.getBoundingClientRect().top +
      Number.parseFloat(style.borderTopWidth) +
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.lineHeight) / 2;
    return Math.abs(radio.top + radio.height / 2 - textCenter);
  });
  expect(alignment).toBeLessThanOrEqual(1);
  const field = form.locator('[data-field-key="q0"]');
  const headingBox = await field.locator('.native-form-field-heading').boundingBox();
  const questionBox = await field.locator(':scope > .question-prompt-hint').boundingBox();
  const answersBox = await field.locator('.native-form-answer').boundingBox();
  const aboveQuestion = questionBox!.y - headingBox!.y - headingBox!.height;
  const belowQuestion = answersBox!.y - questionBox!.y - questionBox!.height;
  expect(aboveQuestion).toBeCloseTo(4, 0);
  expect(belowQuestion).toBeCloseTo(8, 0);
  await page.screenshot({ path: testInfo.outputPath('question-radio-choices.png') });
  await separate.focus();
  await separate.press('ArrowDown');
  await expect(switchChat).toBeChecked();
  await expect(separate).not.toBeChecked();
  await expect(form.locator('.native-form-clear')).toHaveCount(0);
  await form.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(form).toHaveCount(0);
  const reply = await getE2EState(page, () => {
    // SAFETY: The harness owns this recorded API request list.
    const harness = (
      window as Window & { __varroE2E?: { requests: Array<{ path: string; body?: unknown }> } }
    ).__varroE2E;
    return harness?.requests.find(
      (request) => request.path === '/question/frm_native_question/reply'
    );
  });
  expect(reply?.body).toEqual({
    kind: 'native-form',
    sessionID: 'session-native-question',
    answer: { q0: 'switch-chat' },
  });
});

test.describe('question answer hairlines', () => {
  test.use({ deviceScaleFactor: 2 });

  test('keeps half-pixel strokes and subtly highlights selected answers', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 480, height: 900 });
    await page.goto('/e2e/harness/index.html?scenario=native-question-prompt');
    const choices = page.locator('.native-question-choice');
    await expect(choices).toHaveCount(3);
    const stroke = await choices.first().evaluate((element) => getComputedStyle(element).boxShadow);
    expect(stroke).toContain('inset');
    expect(stroke).toContain('0.5px');
    expect(stroke).toMatch(/(?:,|\/)\s*0\.08\b/);
    for (const choice of await choices.all()) {
      await expect(choice).toHaveCSS('box-shadow', stroke);
      await expect(choice).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
      await expect(choice).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    }
    await choices.first().hover();
    await expect(choices.first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(choices.first()).toHaveCSS('box-shadow', stroke);
    await expect(choices.first()).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await page.getByRole('radio', { name: 'Use separate Codex login', exact: true }).check();
    await expect(choices.first()).toHaveClass(/selected/);
    await expect(choices.first()).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const selectedStroke = await choices
      .first()
      .evaluate((element) => getComputedStyle(element).boxShadow);
    expect(selectedStroke).toContain('inset');
    expect(selectedStroke).toContain('0.5px');
    expect(selectedStroke).not.toBe(stroke);
    await expect(choices.first()).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    const custom = page.getByRole('textbox', {
      name: 'Restore actual limits: custom answer',
      exact: true,
    });
    await custom.fill('Keep the existing account');
    await expect(choices.last()).toHaveClass(/selected/);
    await expect(choices.last()).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(choices.last()).toHaveCSS('box-shadow', selectedStroke);
    await expect(choices.last()).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await expect(choices.first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(choices.first()).toHaveCSS('box-shadow', stroke);
    await page.screenshot({ path: testInfo.outputPath('question-answer-hairlines.png') });
  });
});

test('retains a native question custom answer on reload and submits multiline text with Enter', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=native-question-prompt');
  const customRadio = page.getByRole('radio', { name: 'Custom answer', exact: true });
  const customInput = page.getByRole('textbox', {
    name: 'Restore actual limits: custom answer',
    exact: true,
  });
  await customRadio.check();
  await expect(customInput).toBeFocused();
  await customInput.fill('Keep the current chat account');
  await expect(page.locator('.native-form-clear')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Use separate Codex login', exact: true }).check();
  await expect(customRadio).not.toBeChecked();
  await customRadio.check();
  await expect(customInput).toHaveValue('Keep the current chat account');
  await customInput.press('Shift+Enter');
  await customInput.pressSequentially('and restore usage separately');
  await page.reload();
  await expect(customRadio).toBeChecked();
  await expect(customInput).toHaveValue(
    'Keep the current chat account\nand restore usage separately'
  );
  await customInput.press('Enter');
  await expect(page.getByRole('form', { name: 'Questions', exact: true })).toHaveCount(0);
  const reply = await getE2EState(page, () => {
    // SAFETY: The harness owns this recorded API request list.
    const harness = (
      window as Window & { __varroE2E?: { requests: Array<{ path: string; body?: unknown }> } }
    ).__varroE2E;
    return harness?.requests.find(
      (request) => request.path === '/question/frm_native_question/reply'
    );
  });
  expect(reply?.body).toEqual({
    kind: 'native-form',
    sessionID: 'session-native-question',
    answer: { q0: 'Keep the current chat account\nand restore usage separately' },
  });
});
