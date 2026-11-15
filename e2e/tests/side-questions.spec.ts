import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { ExtensionMessage, WebviewMessage } from '../../src/shared/protocol';

type SideQuestionHarnessWindow = {
  __sendToExtension?: (message: WebviewMessage) => void;
  sideQuestionRequests?: Array<Extract<WebviewMessage, { type: 'api/request' }>['payload']>;
  sideQuestionTraffic?: WebviewMessage[];
};

async function prepare(page: Page, scenario = 'restored-session') {
  await page.goto(`/e2e/harness/index.html?scenario=${scenario}`);
  await expect(page.locator('.rich-composer')).toBeVisible();
  await page.evaluate(() => {
    // SAFETY: The isolated harness owns this bridge and the intercepted synthetic requests.
    const host = window as SideQuestionHarnessWindow;
    const send = host.__sendToExtension;
    if (!send) throw new Error('Harness bridge missing');
    const requests: NonNullable<SideQuestionHarnessWindow['sideQuestionRequests']> = [];
    host.sideQuestionRequests = requests;
    const traffic: WebviewMessage[] = [];
    host.sideQuestionTraffic = traffic;
    host.__sendToExtension = (message) => {
      traffic.push(message);
      if (message.type === 'api/request' && message.payload.path.includes('/side-question')) {
        requests.push(message.payload);
        return;
      }
      send(message);
    };
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'server/status',
          payload: { state: 'running', url: 'mock://opencode', apiVersion: 2 },
        } satisfies ExtensionMessage,
      })
    );
  });
}

async function answer(page: Page) {
  await page.evaluate(() => {
    // SAFETY: Requests are captured from the isolated harness bridge above.
    const request = (window as SideQuestionHarnessWindow).sideQuestionRequests?.at(-1);
    if (!request) throw new Error('No side question request');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'api/response',
          payload: {
            id: request.id,
            data: { text: '**The default was missing.**\n\nNo files were changed.' },
          },
        } satisfies ExtensionMessage,
      })
    );
  });
}

async function pasteSideImage(input: Locator, text = '') {
  return input.evaluate((element, pastedText) => {
    // SAFETY: This synthetic clipboard belongs only to the isolated browser harness.
    const clipboard = new DataTransfer();
    clipboard.items.add(new File(['test image'], 'pasted.png', { type: 'image/png' }));
    if (pastedText) clipboard.setData('text/plain', pastedText);
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, text);
}

async function logoWavePixels(canvas: Locator) {
  return canvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error('Expected a logo canvas');
    const context = element.getContext('2d');
    if (!context) throw new Error('Logo wave context missing');
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let colored = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index]! > 0) colored++;
    }
    return colored;
  });
}

async function expectCompactComposer(dialog: Locator) {
  await expect(dialog.locator('.chat-input-toolbars')).toHaveCount(0);
  const layout = await dialog.locator('.chat-input-container').evaluate((frame) => {
    const editor = frame.querySelector('.rich-composer');
    const button = frame.querySelector('.side-question-composer-actions button');
    if (!editor || !button) throw new Error('Composer controls missing');
    const f = frame.getBoundingClientRect();
    const e = editor.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    return {
      height: f.height,
      editorHeight: e.height,
      buttonHeight: b.height,
      editorRight: e.right,
      buttonLeft: b.left,
      centerOffset: Math.abs((b.top + b.bottom) / 2 - (f.top + f.bottom) / 2),
    };
  });
  expect(layout.height).toBeLessThanOrEqual(
    Math.max(layout.editorHeight, layout.buttonHeight) + 18
  );
  expect(layout.centerOffset).toBeLessThanOrEqual(1);
  expect(layout.buttonLeft).toBeGreaterThanOrEqual(layout.editorRight);
}

async function fillMultilineDraft(input: Locator, text: string) {
  const [first, ...lines] = text.split('\n');
  await input.fill(first ?? '');
  for (const line of lines) {
    await input.press('Shift+Enter');
    await expectCenteredCaret(input);
    await input.pressSequentially(line);
  }
}

async function expectCenteredCaret(input: Locator) {
  await expect
    .poll(() =>
      input.evaluate((element) => {
        const selection = window.getSelection();
        if (!selection?.rangeCount || !selection.isCollapsed) return Number.POSITIVE_INFINITY;
        const range = selection.getRangeAt(0);
        if (!element.contains(range.startContainer)) return Number.POSITIVE_INFINITY;
        const caret = range.getBoundingClientRect();
        if (!caret.height) return Number.POSITIVE_INFINITY;
        const box = element.getBoundingClientRect();
        return Math.abs((caret.top + caret.bottom - box.top - box.bottom) / 2);
      })
    )
    .toBeLessThanOrEqual(1);
}

async function expectFixedLineComposer(dialog: Locator) {
  const input = dialog.getByLabel('Follow-up question');
  await input.fill('First line');
  await expectCenteredCaret(input);
  const singleHeight = await input.evaluate((element) => element.clientHeight);
  await fillMultilineDraft(input, 'First line\nSecond line');
  await expectCenteredCaret(input);
  const twoLineHeight = await input.evaluate((element) => element.clientHeight);
  expect(twoLineHeight).toBe(singleHeight);
  const peek = await input.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent?.includes('First line')) node = walker.nextNode();
    if (!node) throw new Error('First line missing');
    const range = document.createRange();
    range.selectNodeContents(node);
    const text = range.getBoundingClientRect();
    return {
      top: text.top,
      bottom: text.bottom,
      clipTop: element.getBoundingClientRect().top,
    };
  });
  expect(peek.top).toBeLessThan(peek.clipTop);
  expect(peek.bottom).toBeGreaterThan(peek.clipTop);
  await fillMultilineDraft(input, 'First line\nSecond line\nThird line');
  await expectCenteredCaret(input);
  await input.press('ArrowUp');
  await expectCenteredCaret(input);
  await input.press('ArrowUp');
  await expectCenteredCaret(input);
  await input.press('ArrowDown');
  await expectCenteredCaret(input);
  const capped = await input.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: element.clientHeight,
      scrollHeight: element.scrollHeight,
      limit:
        Number.parseFloat(style.lineHeight) +
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom),
      overflow: style.overflowY,
      scrollbar: style.scrollbarWidth,
      scrollbarDisplay: getComputedStyle(element, '::-webkit-scrollbar').display,
      mask: style.maskImage,
    };
  });
  expect(capped.height).toBe(twoLineHeight);
  expect(capped.height).toBeLessThanOrEqual(capped.limit + 1);
  expect(capped.scrollHeight).toBeGreaterThan(capped.height);
  expect(capped.overflow).toBe('auto');
  expect(capped.scrollbar).toBe('none');
  expect(capped.scrollbarDisplay).toBe('none');
  expect(capped.mask).toContain('linear-gradient');
  expect(capped.mask).toContain('12px');
  expect(capped.mask).toContain('rgba(0, 0, 0, 0)');
  await expect(dialog.locator('.chat-input-container')).toHaveCSS('mask-image', 'none');
  await expect(dialog.locator('.side-question-composer-actions button')).toHaveCSS(
    'mask-image',
    'none'
  );
  await expect
    .poll(() =>
      input.evaluate((element) => {
        if (!(element instanceof HTMLElement)) throw new Error('Expected an HTML composer');
        return element.innerText.replace(/\u200b/g, '');
      })
    )
    .toBe('First line\nSecond line\nThird line');
  await expectCompactComposer(dialog);
  await input.fill('A long wrapped draft '.repeat(40));
  await expectCenteredCaret(input);
  expect(await input.evaluate((element) => element.clientHeight)).toBe(twoLineHeight);
  await expectCompactComposer(dialog);
}

async function expectTwoLineQuestionBubble(question: Locator, requireOverflow = true) {
  const layout = await question
    .locator('.user-message-card > .rendered-markdown')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const card = element.closest('.user-message-card')!;
      const cardStyle = getComputedStyle(card);
      return {
        height: element.getBoundingClientRect().height,
        limit: Number.parseFloat(style.fontSize) * 1.6 * 2,
        maxHeight: Number.parseFloat(style.maxHeight),
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflow: style.overflowY,
        cardHeight: card.getBoundingClientRect().height,
        cardInset:
          Number.parseFloat(cardStyle.paddingTop) +
          Number.parseFloat(cardStyle.paddingBottom) +
          Number.parseFloat(cardStyle.borderTopWidth) +
          Number.parseFloat(cardStyle.borderBottomWidth),
      };
    });
  expect(layout.maxHeight).toBeCloseTo(layout.limit, 1);
  expect(layout.height).toBeLessThanOrEqual(layout.limit + 1);
  expect(layout.cardHeight).toBeLessThanOrEqual(layout.limit + layout.cardInset + 1);
  if (requireOverflow) expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  expect(layout.overflow).toBe('auto');
}

for (const width of [390, 1100]) {
  test(`side questions preserve text context and use normal attachment chips at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await prepare(page, 'busy-stop-send');
    await page.evaluate(() => {
      // SAFETY: These context snapshots belong to the isolated harness.
      const messages: ExtensionMessage[] = [
        {
          type: 'context/update',
          payload: {
            workspacePath: '/workspace/varro',
            activeFile: {
              path: '/workspace/varro/src/chosen.ts',
              relativePath: 'src/chosen.ts',
              language: 'typescript',
            },
            selection: { startLine: 2, endLine: 3 },
            editorText: {
              kind: 'selection',
              path: '/workspace/varro/src/chosen.ts',
              relativePath: 'src/chosen.ts',
              language: 'typescript',
              range: { startLine: 2, endLine: 3 },
              text: 'const snapshotValue = 47;',
              truncated: false,
            },
            diagnostics: [],
          },
        },
        {
          type: 'files/dropped',
          payload: [
            { path: '/workspace/varro/src/extra.ts', relativePath: 'src/extra.ts', type: 'file' },
          ],
        },
      ];
      for (const data of messages) window.dispatchEvent(new MessageEvent('message', { data }));
    });
    const composer = page.locator('.rich-composer').first();
    await composer.fill('/btw Explain @src/extra.ts with the selected code');
    await composer.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Side question' });
    const question = dialog.locator('.side-question-question').first();
    await expect(question.locator('.message-attachment-chip').first()).toBeVisible();
    await expect(question).toContainText('chosen.ts');
    await expectTwoLineQuestionBubble(question, false);
    const body = await page.evaluate(() => {
      // SAFETY: Reads only the isolated harness's captured request.
      return (window as SideQuestionHarnessWindow).sideQuestionRequests?.at(-1)?.body;
    });
    expect(body).toMatchObject({ question: expect.stringContaining('const snapshotValue = 47;') });
    expect(body).toMatchObject({
      question: expect.stringContaining('[Attached file: src/extra.ts]'),
    });
    await page.screenshot({
      path: path.resolve(`tmp/_OC_v2/01_side-questions/context-attachments-${width}px.png`),
    });
    await answer(page);
    await dialog.getByLabel('Follow-up question').fill('Why that line?');
    await dialog.getByLabel('Follow-up question').press('Enter');
    expect(
      await page.evaluate(() => {
        // SAFETY: Reads only the isolated harness's captured request.
        return (window as SideQuestionHarnessWindow).sideQuestionRequests?.at(-1)?.body;
      })
    ).toMatchObject({
      question: 'Why that line?',
      history: [
        {
          question: expect.stringContaining('const snapshotValue = 47;'),
          answer: expect.any(String),
        },
      ],
    });
    await dialog.getByRole('button', { name: 'Close side question' }).click();
    await expect(
      page.getByRole('button', { name: 'Add to queue (Enter)', exact: true })
    ).toBeVisible();
    await expect(page.locator('.chat-attachments-container')).toContainText('extra.ts');
    const writes = await page.evaluate(() => {
      // SAFETY: Reads only the isolated harness's captured traffic.
      return (window as SideQuestionHarnessWindow).sideQuestionTraffic
        ?.filter((message) => message.type === 'api/request' && message.payload.method !== 'GET')
        .map((message) => (message.type === 'api/request' ? message.payload.path : ''));
    });
    expect(writes).toHaveLength(2);
    expect(writes!.every((requestPath) => requestPath.includes('/side-question'))).toBe(true);
  });

  test(`incompatible inline content disables side questions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await prepare(page, 'busy-stop-send');
    const composer = page.locator('.rich-composer').first();
    for (const prompt of [
      '@build Explain',
      '$[docs] Explain',
      '/test example',
      'session:ses_other Explain',
    ]) {
      await composer.fill(`/btw ${prompt}`);
      await expect(page.getByRole('button', { name: 'Send (Enter)', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      const displayedDraft = await composer.textContent();
      await composer.press('Enter');
      await expect(page.getByRole('dialog', { name: 'Side question' })).toHaveCount(0);
      expect(await composer.textContent()).toBe(displayedDraft);
    }
    await composer.fill('$[docs] Explain');
    await page.getByRole('button', { name: 'More send options' }).click();
    const action = page
      .locator('.busy-menu')
      .getByRole('button', { name: 'Side question', exact: true });
    await expect(action).toBeDisabled();
    await expect(action).toHaveAttribute('title', 'Side questions cannot use skills');
    await page.screenshot({
      path: path.resolve(`tmp/_OC_v2/01_side-questions/incompatible-side-question-${width}px.png`),
    });
    expect(
      await page.evaluate(() => {
        // SAFETY: Reads only the isolated harness's captured side requests.
        return (window as SideQuestionHarnessWindow).sideQuestionRequests;
      })
    ).toHaveLength(0);
  });

  for (const placement of ['strip', 'inline'] as const) {
    test(`/btw excludes ${placement} images and retains them for a regular send at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await prepare(page);
      await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
      await page.getByText('GPT-4.1', { exact: true }).click();
      await expect(page.getByLabel('OpenAI / GPT-4.1')).toBeVisible();
      const originalUrl = await page.evaluate(() => {
        // SAFETY: This image snapshot belongs only to the isolated harness.
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const url = canvas.toDataURL('image/png');
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'composer/images-sync',
              payload: {
                images: [
                  {
                    id: 'side-image',
                    filename: 'Image 1',
                    mime: 'image/png',
                    size: atob(url.split(',')[1]!).length,
                    url,
                  },
                ],
              },
            } satisfies ExtensionMessage,
          })
        );
        return url;
      });
      const composer = page.locator('.rich-composer').first();
      const prompt = placement === 'inline' ? 'Explain [Image 1]' : 'Explain';
      const image = page.locator(
        placement === 'inline' ? '[data-chip-type="image"]' : '.chat-attachment-chip'
      );
      await composer.fill(prompt);
      await expect(image).toBeVisible();
      await expect(image).not.toHaveClass(/disabled/);
      await composer.fill(`/btw ${prompt}`);
      await expect(image).toHaveClass(/disabled/);
      await expect(image.locator('.inline-chip-label, .chip-label')).toHaveCSS(
        'text-decoration-line',
        'line-through'
      );
      await image.hover();
      await expect(image).toHaveAttribute(
        'title',
        'Images are not included in side questions. Kept attached for your next regular message.'
      );
      await expect(page.getByRole('button', { name: 'Send (Enter)', exact: true })).toBeEnabled();
      await page.screenshot({
        path: path.resolve(
          `tmp/_OC_v2/01_side-questions/excluded-${placement}-image-${width}px.png`
        ),
      });
      await composer.fill(prompt);
      await expect(image).not.toHaveClass(/disabled/);
      await composer.fill(`/btw ${prompt}`);
      const messages = await page.locator('.user-message-card').count();
      await composer.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Side question' });
      await expect(dialog.getByRole('status')).toBeVisible();
      expect(
        await page.evaluate(() => {
          // SAFETY: Reads only the isolated harness's captured side requests.
          return (window as SideQuestionHarnessWindow).sideQuestionRequests?.map(
            (request) => request.body
          );
        })
      ).toEqual([{ question: 'Explain' }]);
      await answer(page);
      await expect(dialog.locator('.side-question-answer')).toHaveCount(1);
      await dialog.getByRole('button', { name: 'Close side question' }).click();
      await expect(composer).toHaveText('');
      await expect(page.locator('.user-message-card')).toHaveCount(messages);
      const retainedImage = page.locator('.chat-attachment-chip');
      await expect(retainedImage).toContainText('Image 1');
      await expect(retainedImage).not.toHaveClass(/disabled/);
      await retainedImage.hover();
      await expect(page.locator('.chat-attachment-image-preview img')).toHaveAttribute(
        'src',
        originalUrl
      );
      await composer.fill('Now inspect the image');
      await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(() => {
            // SAFETY: Reads only the isolated harness's captured prompt request.
            return (window as SideQuestionHarnessWindow).sideQuestionTraffic?.find(
              (message) =>
                message.type === 'api/request' && message.payload.path.includes('/prompt_async')
            );
          })
        )
        .toMatchObject({
          type: 'api/request',
          payload: {
            method: 'POST',
            body: {
              parts: expect.arrayContaining([
                { type: 'file', filename: 'Image 1', mime: 'image/png', url: originalUrl },
              ]),
            },
          },
        });
      await expect(retainedImage).toHaveCount(0);
    });
  }

  test(`only side-question bubbles are capped at two lines at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await prepare(page);
    const mainBubble = page.locator('.interactive-list .user-message-text-scroll').first();
    const mainMaxHeight = await mainBubble.evaluate(
      (element) => getComputedStyle(element).maxHeight
    );
    expect(mainMaxHeight).toContain('280px');
    const composer = page.locator('.rich-composer').first();
    await composer.fill('/btw');
    await composer.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Side question' });
    const input = dialog.getByRole('textbox');
    const multiline = 'First line\nSecond line\nThird line\nLast line';
    await fillMultilineDraft(input, multiline);
    await input.press('Enter');
    const question = dialog.locator('.side-question-question').first();
    await expect(question).toContainText('Last line');
    for (const fontSize of ['13px', '18px']) {
      await dialog.evaluate(
        (element, size) => element.style.setProperty('--varro-chat-font-size', size),
        fontSize
      );
      await expectTwoLineQuestionBubble(question);
      expect(await mainBubble.evaluate((element) => getComputedStyle(element).maxHeight)).toBe(
        mainMaxHeight
      );
    }
    await dialog.evaluate((element) => element.style.removeProperty('--varro-chat-font-size'));
    await page.screenshot({
      path: path.resolve(`tmp/_OC_v2/01_side-questions/two-line-bubble-pending-${width}px.png`),
    });
    const textScroll = question.locator('.user-message-card > .rendered-markdown');
    await textScroll.hover();
    await page.mouse.wheel(0, 80);
    await expect.poll(() => textScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await answer(page);
    await expect(dialog.getByLabel('Follow-up question')).toBeFocused();
    await expectTwoLineQuestionBubble(question);
    const wrapped =
      'Explain how to preserve the original task while asking a side question. '.repeat(20);
    await input.fill(wrapped);
    await input.press('Enter');
    await expectTwoLineQuestionBubble(dialog.locator('.side-question-question').last());
    expect(
      await page.evaluate(() => {
        // SAFETY: Reads only the isolated harness's captured side request.
        return (window as SideQuestionHarnessWindow).sideQuestionRequests?.at(-1)?.body;
      })
    ).toEqual({
      question: wrapped.trim(),
      history: [
        { question: multiline, answer: '**The default was missing.**\n\nNo files were changed.' },
      ],
    });
    await answer(page);
    await expect(dialog.getByLabel('Follow-up question')).toBeFocused();
    await fillMultilineDraft(
      input,
      'Explain this code:\n```ts\nconst first = 1;\nconst second = 2;\nconst third = 3;\n```'
    );
    await input.press('Enter');
    await expectTwoLineQuestionBubble(dialog.locator('.side-question-question').last());
    await page.screenshot({
      path: path.resolve(`tmp/_OC_v2/01_side-questions/two-line-bubble-thread-${width}px.png`),
    });
    await dialog.getByRole('button', { name: 'Close side question' }).click();
    expect(await mainBubble.evaluate((element) => getComputedStyle(element).maxHeight)).toBe(
      mainMaxHeight
    );
  });

  test(`pasting a side image shows the existing text-only warning at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await prepare(page, 'busy-stop-send');
    const composer = page.locator('.rich-composer').first();
    await composer.fill('/btw');
    await composer.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Side question' });
    const input = dialog.getByRole('textbox');
    await input.fill('Keep this draft');
    expect(await pasteSideImage(input)).toBe(true);
    const warning = dialog.locator('.session-action-feedback.is-warning.is-input-anchored');
    await expect(warning).toBeVisible();
    await expect(warning).toHaveCSS('opacity', '1');
    await expect(warning.locator('.session-action-feedback-message')).toHaveText(
      'Text-only side questions'
    );
    await expect(warning.locator('.session-action-feedback-message')).toHaveAttribute(
      'aria-label',
      'Side questions support text only'
    );
    await expect(input).toHaveText('Keep this draft');
    await expect(input).toBeFocused();
    await expect(input.locator('img, .inline-chip, .session-action-feedback')).toHaveCount(0);
    const warningBounds = (await warning.boundingBox())!;
    const dialogBounds = (await dialog.boundingBox())!;
    const titleBounds = (await dialog.locator('h2').boundingBox())!;
    expect(warningBounds.y).toBeGreaterThanOrEqual(dialogBounds.y);
    expect(warningBounds.y).toBeGreaterThanOrEqual(titleBounds.y + titleBounds.height);
    const caretTop = await input.evaluate(
      () => window.getSelection()!.getRangeAt(0).getBoundingClientRect().top
    );
    expect(warningBounds.y + warningBounds.height).toBeLessThanOrEqual(caretTop);
    expect(warningBounds.x).toBeGreaterThanOrEqual(dialogBounds.x);
    expect(warningBounds.x + warningBounds.width).toBeLessThanOrEqual(
      dialogBounds.x + dialogBounds.width
    );
    await page.screenshot({
      path: path.resolve(`tmp/_OC_v2/01_side-questions/image-paste-warning-${width}px.png`),
    });
    expect(
      await page.evaluate(() => {
        // SAFETY: Reads only the isolated harness's captured side requests.
        return (window as SideQuestionHarnessWindow).sideQuestionRequests;
      })
    ).toHaveLength(0);
    await input.fill('');
    expect(await pasteSideImage(input, 'Keep only this text')).toBe(true);
    await expect(input).toHaveText('Keep only this text');
    await input.press('Enter');
    expect(
      await page.evaluate(() => {
        // SAFETY: Reads only the isolated harness's captured side request.
        return (window as SideQuestionHarnessWindow).sideQuestionRequests?.at(-1)?.body;
      })
    ).toEqual({ question: 'Keep only this text' });
    await answer(page);
    await expect(dialog.getByLabel('Follow-up question')).toBeFocused();
    expect(await pasteSideImage(dialog.getByRole('textbox'))).toBe(true);
    await expect(warning).toBeVisible();
    await dialog.getByRole('button', { name: 'Close side question' }).click();
    await expect(page.locator('.session-action-feedback.is-warning')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
    const writes = await page.evaluate(() => {
      // SAFETY: Reads only the isolated harness's captured API traffic.
      return (window as SideQuestionHarnessWindow).sideQuestionTraffic
        ?.filter((message) => message.type === 'api/request' && message.payload.method !== 'GET')
        .map((message) => (message.type === 'api/request' ? message.payload.path : ''));
    });
    expect(writes).toHaveLength(1);
    expect(writes![0]).toContain('/side-question');
  });

  test(`busy send menu asks the plain draft as a side question at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await prepare(page, 'busy-stop-send');
    const composer = page.locator('.rich-composer').first();
    const messages = await page.locator('.user-message-card').count();
    await composer.fill('Why did that fail?');
    await page.getByRole('button', { name: 'More send options' }).click();
    const menu = page.locator('.busy-menu');
    await expect(menu.locator('.busy-menu-label')).toHaveText([
      'Queue',
      'Steer',
      'Side question',
      'Stop and Send',
    ]);
    const action = menu.getByRole('button', { name: 'Side question', exact: true });
    await expect(action.locator('.ui-icon')).toBeVisible();
    await page.screenshot({
      path: path.resolve(`tmp/_OC_v2/01_side-questions/send-menu-side-question-${width}px.png`),
    });
    await action.focus();
    await action.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Side question' });
    await expect(dialog.getByRole('status')).toBeVisible();
    await expect(menu).toHaveCount(0);
    expect(
      await page.evaluate(() => {
        // SAFETY: Reads only the isolated harness's captured side request.
        return (window as SideQuestionHarnessWindow).sideQuestionRequests?.at(-1)?.body;
      })
    ).toEqual({ question: 'Why did that fail?' });
    await answer(page);
    await expect(dialog.locator('.side-question-answer')).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Close side question' }).click();
    await expect(composer).toHaveText('');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect(page.locator('.user-message-card')).toHaveCount(messages);
    await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
    const writes = await page.evaluate(() => {
      // SAFETY: Reads only the isolated harness's captured traffic.
      return (window as SideQuestionHarnessWindow).sideQuestionTraffic
        ?.filter((message) => message.type === 'api/request' && message.payload.method !== 'GET')
        .map((message) => (message.type === 'api/request' ? message.payload.path : ''));
    });
    expect(writes).toHaveLength(1);
    expect(writes![0]).toContain('/side-question');
  });

  test(`/btw during active work shows only Send and leaves the main task running at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await prepare(page, 'busy-stop-send');
    const composer = page.locator('.rich-composer').first();
    const messages = await page.locator('.user-message-card').count();
    await composer.fill('An ordinary follow-up');
    await page.getByRole('button', { name: 'More send options' }).click();
    await expect(page.locator('.busy-menu')).toBeVisible();
    await composer.fill('/btw How is it going?');
    await expect(page.locator('.busy-menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'More send options' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add to queue (Enter)' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send (Enter)', exact: true })).toBeEnabled();
    await page.screenshot({
      path: path.resolve(`tmp/_OC_v2/01_side-questions/timed-ui-busy-send-${width}px.png`),
    });
    await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Side question' });
    await expect(dialog.getByRole('status')).toBeVisible();
    await answer(page);
    await expect(dialog.locator('.side-question-answer')).toHaveCount(1);
    await page.screenshot({
      path: path.resolve(`tmp/_OC_v2/01_side-questions/timed-ui-busy-answer-${width}px.png`),
    });
    await dialog.getByRole('button', { name: 'Close side question' }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect(page.locator('.user-message-card')).toHaveCount(messages);
    await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
    const writes = await page.evaluate(() => {
      // SAFETY: Reads only the isolated harness's captured API traffic.
      return (window as SideQuestionHarnessWindow).sideQuestionTraffic
        ?.filter((message) => message.type === 'api/request' && message.payload.method !== 'GET')
        .map((message) => (message.type === 'api/request' ? message.payload.path : ''));
    });
    expect(writes).toHaveLength(1);
    expect(writes![0]).toContain('/side-question');
  });

  test(`side-question menu preserves draft, history, focus, and scroll at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await prepare(page);
    const composer = page.locator('.rich-composer').first();
    await composer.fill('Keep this unsent draft');
    const messages = await page.locator('.user-message-card').count();
    const list = page.locator('.interactive-list').first();
    const scrollTop = await list.evaluate((element) => element.scrollTop);
    const title = page.locator('.chat-header-session-title:visible');
    await title.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Ask a side question…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Side question' });
    await expect(dialog).toBeVisible();
    const header = await dialog.locator('.side-question-header').evaluate((element) => {
      const close = element.querySelector('button')!;
      const style = getComputedStyle(close);
      return {
        height: element.getBoundingClientRect().height,
        closeWidth: close.getBoundingClientRect().width,
        closeHeight: close.getBoundingClientRect().height,
        closeRadius: style.borderRadius,
        closeRightInset:
          element.getBoundingClientRect().right - close.getBoundingClientRect().right,
      };
    });
    expect(header.height).toBeLessThanOrEqual(38);
    expect(header.closeWidth).toBe(24);
    expect(header.closeHeight).toBe(24);
    expect(header.closeRadius).not.toBe('0px');
    expect(header.closeRightInset).toBe(6);
    await expect(dialog.getByLabel('Question', { exact: true })).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Send (Enter)', exact: true })).toBeDisabled();
    const welcome = dialog.locator('.side-question-empty-state');
    await expect(welcome).toBeVisible();
    await expect(welcome).toContainText('Ask anything about this session.');
    await expect(welcome.locator('p')).toHaveCount(1);
    await expect(welcome.locator('p')).toHaveCSS('opacity', '0.8');
    await expect(welcome.locator('p')).toHaveCSS('white-space', 'nowrap');
    const logo = welcome.locator('img.chat-empty-logo');
    await expect(logo).toBeVisible();
    await expect
      .poll(() =>
        logo.evaluate((image) => {
          if (!(image instanceof HTMLImageElement)) throw new Error('Expected a logo image');
          return image.naturalWidth;
        })
      )
      .toBeGreaterThan(0);
    expect((await welcome.boundingBox())!.height).toBeGreaterThanOrEqual(192);
    let welcomeHeight = (await dialog.boundingBox())!.height;
    const alignment = await welcome.evaluate((element) => {
      const area = element.getBoundingClientRect();
      const image = element.querySelector('img')!.getBoundingClientRect();
      const caption = element.querySelector('p')!.getBoundingClientRect();
      return {
        centerOffset: Math.abs((image.top + image.bottom - area.top - area.bottom) / 2),
        gap: caption.top - image.bottom,
      };
    });
    expect(alignment.centerOffset).toBeLessThanOrEqual(1);
    expect(alignment.gap).toBeGreaterThanOrEqual(12);
    expect(alignment.gap).toBeLessThanOrEqual(20);
    await page.screenshot({
      path: path.resolve(`tmp/_OC_v2/01_side-questions/welcome-animated-empty-${width}px.png`),
    });
    const waves = welcome.locator('.chat-empty-logo-waves');
    expect(await logoWavePixels(waves)).toBe(0);
    await logo.hover({ position: { x: 16, y: 16 } });
    await expect.poll(() => logoWavePixels(waves)).toBeGreaterThan(0);
    await page.screenshot({
      path: path.resolve(`tmp/_OC_v2/01_side-questions/welcome-logo-wave-${width}px.png`),
    });
    await dialog.getByLabel('Question', { exact: true }).hover();
    await expect.poll(() => logoWavePixels(waves)).toBe(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await logo.hover();
    await expect(waves).toHaveCSS('display', 'none');
    expect(await logoWavePixels(waves)).toBe(0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await dialog.evaluate((element) => element.style.setProperty('--varro-chat-font-size', '18px'));
    welcomeHeight = (await dialog.boundingBox())!.height;
    await dialog.getByLabel('Question', { exact: true }).fill('Why did that fail?');
    await expect(welcome).toBeVisible();
    await expectCompactComposer(dialog);
    await dialog.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
    await expect(welcome).toHaveCount(0);
    await dialog.evaluate((element) => element.style.removeProperty('--varro-chat-font-size'));
    await expect(dialog.getByRole('status')).toContainText('Thinking');
    await expect(dialog.locator('.shimmer-progress .chat-animated-ellipsis')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(dialog.locator('.side-question-composer')).toHaveCount(0);
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Close side question' })).toBeFocused();
    expect((await dialog.boundingBox())!.height).toBeGreaterThanOrEqual(welcomeHeight);
    await expect
      .poll(() =>
        dialog
          .locator('.chat-animated-ellipsis')
          .evaluate((element) => getComputedStyle(element, '::after').content)
      )
      .toMatch(/\./);
    await page.screenshot({
      path: path.resolve(`tmp/_OC_v2/01_side-questions/timed-ui-thinking-${width}px.png`),
    });
    await answer(page);
    await expect(dialog.locator('strong')).toHaveText('The default was missing.');
    await expect(welcome).toHaveCount(0);
    expect((await dialog.boundingBox())!.height).toBeGreaterThanOrEqual(welcomeHeight);
    await page.screenshot({
      path: path.resolve(`tmp/_OC_v2/01_side-questions/welcome-minimum-answer-${width}px.png`),
    });
    await expect(dialog.locator('.side-question-question .user-message-card')).toContainText(
      'Why did that fail?'
    );
    await expect(dialog.locator('.side-question-role, textarea')).toHaveCount(0);
    await expect(dialog.locator('.chat-input-container .rich-composer')).toBeVisible();
    await expectCompactComposer(dialog);
    const bubble = await dialog.locator('.user-message-card').evaluate((card) => {
      const text = card.querySelector('.user-message-text');
      if (!text) throw new Error('Question text missing');
      return {
        margin: getComputedStyle(text).marginBottom,
        bottomGap: card.getBoundingClientRect().bottom - text.getBoundingClientRect().bottom,
      };
    });
    expect(bubble.margin).toBe('0px');
    expect(bubble.bottomGap).toBeLessThanOrEqual(14);
    const footer = await dialog.locator('.side-question-answer').evaluate((response) => {
      const markdown = response.querySelector('.rendered-markdown');
      const row = response.querySelector('.side-question-answer-actions');
      const copy = row?.querySelector('button');
      if (!markdown || !row || !copy) throw new Error('Answer footer missing');
      const r = row.getBoundingClientRect();
      const b = copy.getBoundingClientRect();
      const lastBlock =
        markdown.querySelector('[data-markdown-segment="tail"] > :last-child') ??
        markdown.querySelector('[data-markdown-segment="stable"] > :last-child');
      if (!lastBlock) throw new Error('Answer text missing');
      const content = row.querySelector('.assistant-dialog-summary-content')!;
      const time = row.querySelector('.side-question-response-time')!.getBoundingClientRect();
      return {
        top: r.top,
        answerBottom: markdown.getBoundingClientRect().bottom,
        textGap: r.top - lastBlock.getBoundingClientRect().bottom,
        rightGap: r.right - b.right,
        timeCenterOffset: Math.abs((time.left + time.right) / 2 - (r.left + r.right) / 2),
        before: getComputedStyle(content, '::before').height,
        after: getComputedStyle(content, '::after').height,
      };
    });
    expect(footer.top).toBeGreaterThanOrEqual(footer.answerBottom);
    expect(footer.textGap).toBeLessThanOrEqual(6);
    expect(footer.rightGap).toBe(5);
    expect(footer.timeCenterOffset).toBeLessThanOrEqual(1);
    await expect(dialog.locator('.side-question-response-time')).toHaveText(/^\d+(?:ms|s)$/);
    expect(footer.before).toBe('1px');
    expect(footer.after).toBe('1px');
    await expect(dialog.getByLabel('Follow-up question')).toBeFocused();
    const copy = dialog.getByRole('button', { name: 'Copy answer', exact: true });
    await dialog.locator('.side-question-header').hover();
    await expect(copy).toHaveCSS('opacity', '0');
    await expect(copy).toHaveCSS('pointer-events', 'none');
    await page.screenshot({
      path: path.resolve(`tmp/_OC_v2/01_side-questions/timed-ui-answer-idle-${width}px.png`),
    });
    await dialog.locator('.side-question-answer').hover();
    await expect(copy).toHaveCSS('opacity', '1');
    await expect(copy).toHaveCSS('pointer-events', 'auto');
    await page.screenshot({
      path: path.resolve(`tmp/_OC_v2/01_side-questions/timed-ui-answer-active-${width}px.png`),
    });
    await dialog.locator('.side-question-header').hover();
    await expect(copy).toHaveCSS('opacity', '0');
    await copy.focus();
    await expect(copy).toHaveCSS('opacity', '1');
    await expect(copy).toBeFocused();
    await dialog.getByLabel('Follow-up question').fill('Can you explain the previous answer?');
    await dialog.getByLabel('Follow-up question').press('Enter');
    await expect(dialog.getByRole('status')).toBeVisible();
    await expectCompactComposer(dialog);
    await expect(dialog.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await answer(page);
    await expect(dialog.locator('.side-question-turn')).toHaveCount(2);
    await page.screenshot({
      path: path.resolve(`tmp/_OC_v2/01_side-questions/timed-ui-thread-${width}px.png`),
    });
    expect(
      await page.evaluate(() => {
        // SAFETY: The isolated harness owns these captured requests.
        return (window as SideQuestionHarnessWindow).sideQuestionRequests?.at(-1)?.body;
      })
    ).toEqual({
      question: 'Can you explain the previous answer?',
      history: [
        {
          question: 'Why did that fail?',
          answer: '**The default was missing.**\n\nNo files were changed.',
        },
      ],
    });
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await expectFixedLineComposer(dialog);
    await dialog.evaluate((element) => element.style.setProperty('--varro-chat-font-size', '18px'));
    await expectFixedLineComposer(dialog);
    await dialog.evaluate((element) => element.style.removeProperty('--varro-chat-font-size'));
    await fillMultilineDraft(
      dialog.getByLabel('Follow-up question'),
      'First line\nSecond line\nThird line'
    );
    await expectCenteredCaret(dialog.getByLabel('Follow-up question'));
    await page.screenshot({
      path: path.resolve(`tmp/_OC_v2/01_side-questions/faded-ui-last-line-${width}px.png`),
    });
    await dialog.getByLabel('Follow-up question').press('ArrowUp');
    await expectCenteredCaret(dialog.getByLabel('Follow-up question'));
    await page.screenshot({
      path: path.resolve(`tmp/_OC_v2/01_side-questions/faded-ui-middle-line-${width}px.png`),
    });
    const input = dialog.getByLabel('Follow-up question');
    const inputScrollTop = await input.evaluate((element) => element.scrollTop);
    await input.hover();
    await page.mouse.wheel(0, 12);
    await expect
      .poll(() => input.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(inputScrollTop);
    await input.press('ArrowDown');
    await expectCenteredCaret(input);
    await dialog.getByLabel('Follow-up question').press('Enter');
    expect(
      await page.evaluate(() => {
        // SAFETY: Reads only the isolated harness's captured request.
        return (window as SideQuestionHarnessWindow).sideQuestionRequests?.at(-1)?.body;
      })
    ).toMatchObject({ question: 'First line\nSecond line\nThird line' });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(title).toBeFocused();
    await expect(composer).toHaveText('Keep this unsent draft');
    await expect(page.locator('.user-message-card')).toHaveCount(messages);
    expect(await list.evaluate((element) => element.scrollTop)).toBe(scrollTop);
  });

  test(`/btw opens an ephemeral answer and closing ignores late completion at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await prepare(page);
    const composer = page.locator('.rich-composer').first();
    const messages = await page.locator('.user-message-card').count();
    await composer.fill('/btw Why did that fail?');
    await composer.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Side question' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('status')).toBeVisible();
    await expect(composer).toHaveText('');
    await dialog.getByRole('button', { name: 'Close side question', exact: true }).click();
    await answer(page);
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.user-message-card')).toHaveCount(messages);
    await expect(composer).toBeFocused();
  });

  test(`shared side composer supports multiline, undo, and request-local Stop at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await prepare(page);
    const composer = page.locator('.rich-composer').first();
    await composer.fill('/btw');
    await composer.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Side question' });
    const input = dialog.getByRole('textbox');
    await input.fill('Explain retries.');
    await input.press('Shift+Enter');
    await input.pressSequentially('Use one sentence.');
    await expect
      .poll(() =>
        input.evaluate((element) => {
          if (!(element instanceof HTMLElement)) throw new Error('Expected an HTML composer');
          return element.innerText.replace(/\u200b/g, '');
        })
      )
      .toBe('Explain retries.\nUse one sentence.');
    await input.press('Enter');
    expect(
      await page.evaluate(() => {
        // SAFETY: Only reads the isolated harness's captured side request.
        return (window as SideQuestionHarnessWindow).sideQuestionRequests?.at(-1)?.body;
      })
    ).toEqual({ question: 'Explain retries.\nUse one sentence.' });
    await expect(dialog.getByRole('status')).toBeVisible();
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    await answer(page);
    await expect(dialog.getByLabel('Follow-up question')).toBeFocused();
    await input.fill('One more question');
    await input.press('Enter');
    await expect(dialog.getByRole('status')).toBeVisible();
    await expectCompactComposer(dialog);
    await input.fill('First edit');
    await input.fill('Second replacement');
    await input.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await expect(input).toHaveText('First edit');
    await input.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
    await expect(input).toHaveText('Second replacement');
    await dialog.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveCount(0);
    await expect(input).toHaveText('Second replacement');
    await answer(page);
    await expect(dialog.locator('.side-question-answer')).toHaveCount(1);
    await expect(composer).toHaveText('');
    await expect(page.locator('.chat-queue-item')).toHaveCount(0);
  });
}
