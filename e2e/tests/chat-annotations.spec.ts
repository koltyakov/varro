import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { UserMessage } from '../../src/shared/opencode-types';
import { waitForHarnessStartup } from './helpers';

async function selectPassage(page: Page, expectedPrefix = 'Mock assistant'): Promise<Locator> {
  const passage = page.locator('.chat-turn-assistant p').last();
  await expect(passage).toBeVisible();
  const measure = () =>
    passage.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const boxes = Array.from(range.getClientRects());
      const first = boxes[0];
      const last = boxes.at(-1);
      if (!first || !last) return null;
      return {
        left: first.left,
        right: last.right,
        startY: first.top + first.height / 2,
        endY: last.top + last.height / 2,
      };
    });
  // Retain the coordinates from the successful read. A second read can hit an
  // empty streaming paragraph after the first read has already passed.
  let rect = await measure();
  if (!rect) {
    await expect
      .poll(async () => {
        rect = await measure();
        return rect;
      })
      .not.toBeNull();
  }
  if (!rect) throw new Error('Expected rendered assistant text for selection');
  await page.mouse.move(rect.left, rect.startY);
  await page.mouse.down();
  await page.mouse.move(rect.right + 2, rect.endY, { steps: 10 });
  await page.mouse.up();
  const selectedText = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selectedText.startsWith(expectedPrefix)).toBe(true);
  return passage;
}

async function prepare(page: Page, theme = 'dark') {
  await page.goto(`/e2e/harness/index.html?scenario=blank&theme=${theme}`);
  await waitForHarnessStartup(page);
  const composer = page.getByRole('textbox', { name: 'Message composer' });
  await composer.fill('Explain the proposed change');
  await composer.press('Enter');
  await expect(page.locator('.chat-turn-assistant').last()).toContainText(
    'Mock assistant response for:'
  );
  await expect(page.getByLabel('Send (Enter)')).toBeVisible();
  return composer;
}

test('selects assistant text when its geometry is temporarily empty', async ({ page }) => {
  await page.addInitScript(() => {
    const getClientRects = Range.prototype.getClientRects;
    let reads = 0;
    Range.prototype.getClientRects = function () {
      if (
        this.startContainer === this.endContainer &&
        this.startContainer instanceof Element &&
        this.startContainer.matches('.chat-turn-assistant p')
      ) {
        // Reproduce an empty paragraph between reads without timing the stream.
        reads += 1;
        if (reads % 2 === 1) return getClientRects.call(document.createRange());
      }
      return getClientRects.call(this);
    };
  });
  await prepare(page);
  await selectPassage(page);
});

test('annotates selected chat text, preserves the draft, and sends the passage and note', async ({
  page,
}) => {
  const composer = await prepare(page);
  await composer.fill('Please reconsider.');
  const passage = await selectPassage(page);
  const quote = await page.evaluate(() => window.getSelection()!.toString().trim());
  await passage.click({ button: 'right', position: { x: 10, y: 10 } });
  await page.getByRole('menuitem', { name: 'Annotate', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Annotate selected text' });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText(quote);
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await dialog
    .getByRole('textbox', { name: 'Annotation', exact: true })
    .fill("I don't agree. Check this assumption.");
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const chip = composer.locator('.inline-chip');
  await expect(chip).toHaveText("I don't agree. Check this assumption.");
  await expect(chip.locator('.inline-chip-icon.ui-icon')).toHaveCount(1);
  await expect(chip.locator('.file-type-icon')).toHaveCount(0);
  await expect(chip).not.toHaveAttribute('title');
  await chip.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip.locator('.chat-annotation-tooltip-note')).toHaveText(
    "I don't agree. Check this assumption."
  );
  await expect(tooltip.locator('.chat-annotation-tooltip-quote')).toHaveText(quote);
  await expect(tooltip).toContainText('Source session:');
  await expect(composer).toContainText('Please reconsider.');
  await expect(composer).toBeFocused();
  await composer.press('Enter');
  await expect(chip).toHaveCount(0);
  const sentChip = page.locator('.chat-turn-user').last().locator('.inline-chip');
  await expect(sentChip).toHaveText("I don't agree. Check this assumption.");
  await expect(sentChip.locator('.ui-icon')).toHaveCount(1);
  await expect(sentChip.locator('.file-type-icon')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        // SAFETY: The isolated E2E harness records synthetic backend requests for assertions.
        const harness = window as Window & {
          __varroE2E?: {
            requests: Array<{
              path: string;
              body?: { parts?: Array<{ type: string; url?: string }> };
            }>;
          };
        };
        const request = harness.__varroE2E?.requests.findLast((entry) =>
          new URL(entry.path, 'http://varro.test').pathname.endsWith('/prompt_async')
        );
        const file = request?.body?.parts?.find((part) => part.type === 'file');
        return file?.url ? decodeURIComponent(file.url.split(',').slice(1).join(',')) : '';
      })
    )
    .toContain(`Selected text:\n> ${quote}\n\nComment:\nI don't agree. Check this assumption.`);
});

test('cancels without changing the draft and supports undo and removal of a saved annotation', async ({
  page,
}) => {
  const composer = await prepare(page);
  await composer.fill('Existing draft');
  let passage = await selectPassage(page);
  await passage.click({ button: 'right', position: { x: 10, y: 10 } });
  await page.getByRole('menuitem', { name: 'Annotate', exact: true }).click();
  const note = page.getByRole('textbox', { name: 'Annotation', exact: true });
  await note.fill('Cancelled note');
  await note.press('Escape');
  await expect(composer).toHaveText('Existing draft');
  await expect(composer.locator('.inline-chip')).toHaveCount(0);

  passage = await selectPassage(page);
  await passage.click({ button: 'right', position: { x: 10, y: 10 } });
  await page.getByRole('menuitem', { name: 'Annotate', exact: true }).click();
  await note.fill('Saved note');
  await note.press('ControlOrMeta+Enter');
  await expect(composer.locator('.inline-chip')).toHaveText('Saved note');
  await composer.press('ControlOrMeta+z');
  await expect(composer).toHaveText('Existing draft');
  await expect(composer.locator('.inline-chip')).toHaveCount(0);
  await composer.press('ControlOrMeta+Shift+z');
  await expect(composer.locator('.inline-chip')).toHaveText('Saved note');
  await composer.press('End');
  await composer.press('Backspace');
  await composer.press('Backspace');
  await expect(composer.locator('.inline-chip')).toHaveCount(0);
  await expect(page.locator('.chat-attachment-chip').filter({ hasText: 'Saved note' })).toHaveCount(
    0
  );
  await expect(composer).toContainText('Existing draft');
});

test('fits the annotation editor within a narrow chat viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 600 });
  const composer = await prepare(page);
  const passage = await selectPassage(page);
  await passage.click({ button: 'right', position: { x: 10, y: 10 } });
  await page.getByRole('menuitem', { name: 'Annotate', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Annotate selected text' });
  await dialog
    .getByRole('textbox', { name: 'Annotation', exact: true })
    .fill("I don't agree with this part. Please check the assumption.");
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(8);
  expect(box!.y).toBeGreaterThanOrEqual(8);
  expect(box!.x + box!.width).toBeLessThanOrEqual(352);
  expect(box!.y + box!.height).toBeLessThanOrEqual(592);
  await page.screenshot({ path: testInfo.outputPath('annotation-editor.png') });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(composer.locator('.inline-chip')).toContainText("I don't agree with this part.");
  await composer.locator('.inline-chip').hover();
  await expect(page.getByRole('tooltip').locator('.chat-annotation-tooltip-note')).toHaveText(
    "I don't agree with this part. Please check the assumption."
  );
  await page.screenshot({ path: testInfo.outputPath('annotation-chip.png') });
});

test('shows bracketed comment text in the queue and restores the annotation chip for editing', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=todo-queue');
  await waitForHarnessStartup(page);
  const composer = page.getByRole('textbox', { name: 'Message composer' });
  await composer.fill('Test message with an annotation');
  const passage = await selectPassage(page, 'Captured');
  await passage.click({ button: 'right', position: { x: 10, y: 10 } });
  await page.getByRole('menuitem', { name: 'Annotate', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Annotate selected text' });
  await dialog.getByRole('textbox', { name: 'Annotation', exact: true }).fill('Test');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByLabel('Add to queue (Enter)').click();
  const queue = page.getByRole('list', { name: 'Queued messages' });
  await expect(queue.locator('.chat-queue-label .ui-icon')).toHaveCount(0);
  await expect(queue.getByLabel('1 attachment', { exact: true })).toHaveCount(1);
  await expect(queue.locator('.chat-queue-label')).toHaveText(
    'Test message with an annotation [Test]'
  );
  await expect(queue).not.toContainText('@annotation-');
  await queue.getByRole('listitem').hover();
  await queue.getByRole('button', { name: 'Edit queued message', exact: true }).click();
  await expect(composer.locator('.inline-chip')).toHaveText('Test');
  const marker = await composer.locator('.inline-chip').getAttribute('data-chip-marker');
  if (!marker) throw new Error('Missing annotation marker in the restored draft');
  await page.getByRole('button', { name: 'Cancel queued message edit', exact: true }).click();
  await expect(queue.locator('.chat-queue-label')).toHaveText(
    'Test message with an annotation [Test]'
  );
  await page.evaluate((filename) => {
    // SAFETY: These synthetic server events belong only to the isolated browser harness.
    const harness = (
      window as Window & { __varroE2E?: { replayServerEvent(event: ServerEvent): void } }
    ).__varroE2E;
    if (!harness) throw new Error('Missing E2E harness');
    const info: UserMessage = {
      id: 'pending-annotation-e2e',
      sessionID: 'session-todo-queue',
      role: 'user',
      pendingDelivery: 'steer',
      delivery: 'steer',
      agent: 'build',
      model: { providerID: 'openai', modelID: 'test-model' },
      time: { created: Date.now() },
    };
    harness.replayServerEvent({ type: 'message.updated', properties: { info } });
    harness.replayServerEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'pending-text',
          sessionID: info.sessionID,
          messageID: info.id,
          type: 'text',
          text: `Test message with an annotation @${filename}`,
        },
      },
    });
    harness.replayServerEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'pending-file',
          sessionID: info.sessionID,
          messageID: info.id,
          type: 'file',
          mime: 'text/plain',
          filename,
          url: 'varro-content:/part/pending-file',
          annotation: {
            selectedText: 'Original passage',
            note: 'Test',
            sourceSessionId: 'session-todo-queue',
          },
        },
      },
    });
  }, marker.slice(1));
  const pending = page.getByRole('list', { name: 'Steered messages' });
  await expect(pending.locator('.chat-queue-label')).toHaveText(
    'Test message with an annotation [Test]'
  );
  await expect(pending.locator('.chat-queue-label .ui-icon')).toHaveCount(0);
  await expect(pending).not.toContainText('@annotation-');
});

for (const theme of ['dark', 'light']) {
  test(`${theme} annotation popup has an integrated editor and distinct save states`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 500, height: 600 });
    await prepare(page, theme);
    const passage = await selectPassage(page);
    await passage.click({ button: 'right', position: { x: 10, y: 10 } });
    await page.getByRole('menuitem', { name: 'Annotate', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Annotate selected text' });
    const note = dialog.getByRole('textbox', { name: 'Annotation', exact: true });
    const save = dialog.getByRole('button', { name: 'Save', exact: true });
    await expect(note).toBeFocused();
    expect(await page.evaluate(() => CSS.highlights.has('varro-chat-annotation-selection'))).toBe(
      true
    );
    const highlightBackground = await passage.evaluate(
      (element) =>
        getComputedStyle(element, '::highlight(varro-chat-annotation-selection)').backgroundColor
    );
    expect(highlightBackground).not.toBe('');
    expect(highlightBackground).not.toBe('rgba(0, 0, 0, 0)');
    await expect(page.locator('style[data-chat-annotation-highlight]')).toHaveCount(1);
    const sourceBox = await passage.boundingBox();
    const popupBox = await dialog.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(popupBox).not.toBeNull();
    expect(popupBox!.y).toBeGreaterThanOrEqual(sourceBox!.y + sourceBox!.height);
    const hint = dialog.locator('.chat-annotation-hint');
    await expect(hint).toHaveText('Esc to cancel');
    await expect(hint).toHaveCSS('align-items', 'center');
    const hintAlignment = await hint.evaluate((element) => {
      const keyBox = element.querySelector('kbd')!.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(element.lastChild!);
      const textBox = text.getBoundingClientRect();
      const hintBox = element.getBoundingClientRect();
      return {
        keyCenter: keyBox.top + keyBox.height / 2,
        textCenter: textBox.top + textBox.height / 2,
        hintCenter: hintBox.top + hintBox.height / 2,
        gap: textBox.left - keyBox.right,
      };
    });
    expect(Math.abs(hintAlignment.keyCenter - hintAlignment.hintCenter)).toBeLessThanOrEqual(1);
    expect(Math.abs(hintAlignment.textCenter - hintAlignment.keyCenter)).toBeLessThanOrEqual(1);
    expect(hintAlignment.gap).toBeCloseTo(4, 0);
    await expect(note).toHaveCSS('border-top-width', '0px');
    await expect(note).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(dialog).toHaveCSS('border-radius', '10px');
    await expect(save).toBeDisabled();
    const disabledBackground = await save.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    );
    await page.screenshot({
      path: testInfo.outputPath('annotation-empty.png'),
      animations: 'disabled',
    });
    await note.fill('Please double-check this assumption.');
    await expect(save).toBeEnabled();
    await expect(save).not.toHaveCSS('background-color', disabledBackground);
    await page.screenshot({
      path: testInfo.outputPath('annotation-filled.png'),
      animations: 'disabled',
    });
    await note.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => CSS.highlights.has('varro-chat-annotation-selection'))).toBe(
      false
    );
    await expect(page.locator('style[data-chat-annotation-highlight]')).toHaveCount(0);
  });
}
