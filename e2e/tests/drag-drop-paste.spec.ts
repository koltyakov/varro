/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns -- Playwright callbacks inspect browser clipboard and request payloads whose values cross an untyped browser boundary. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Assertions bridge controlled clipboard, drag, and harness request fixtures to the shapes under test. */
import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('shows the drop overlay when a drag enters and hides on dragleave', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();

  await page.evaluate(() => {
    const event = new DragEvent('dragenter', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { dropEffect: 'none' } });
    document.dispatchEvent(event);
  });

  await expect(page.getByText('Drop to add to context')).toBeVisible();

  await page.evaluate(() => {
    const event = new DragEvent('dragleave', { bubbles: true, cancelable: true });
    document.dispatchEvent(event);
  });

  await expect(page.getByText('Drop to add to context')).toHaveCount(0);
});

test('displays files received from files/dropped in the attachment strip', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();

  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'files/dropped',
        payload: [
          { path: '/workspace/varro/src/index.ts', relativePath: 'src/index.ts', type: 'file' },
          { path: '/workspace/varro/src/lib', relativePath: 'src/lib', type: 'directory' },
        ],
      },
      '*'
    );
  });

  await expect(page.locator('.chat-attachment-chip').filter({ hasText: 'index.ts' })).toBeVisible();
  await expect(page.locator('.chat-attachment-chip').filter({ hasText: 'lib' })).toBeVisible();
});

test('removes only the host-removed file from the attachment strip', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();

  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'files/dropped',
        payload: [
          { path: '/workspace/varro/src/a.ts', relativePath: 'src/a.ts', type: 'file' },
          { path: '/workspace/varro/src/b.ts', relativePath: 'src/b.ts', type: 'file' },
        ],
      },
      '*'
    );
  });

  await expect(page.locator('.chat-attachment-chip')).toHaveCount(2);

  await page.evaluate(() => {
    window.postMessage(
      { type: 'files/removed', payload: { path: '/workspace/varro/src/a.ts' } },
      '*'
    );
  });

  await expect(page.locator('.chat-attachment-chip')).toHaveCount(1);
  await expect(page.locator('.chat-attachment-chip').filter({ hasText: 'b.ts' })).toBeVisible();
  await expect(page.locator('.chat-attachment-chip').filter({ hasText: 'a.ts' })).toHaveCount(0);
});

test('includes dropped file references in the prompt body', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();

  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'files/dropped',
        payload: [
          { path: '/workspace/varro/src/utils.ts', relativePath: 'src/utils.ts', type: 'file' },
        ],
      },
      '*'
    );
  });

  await expect(page.locator('.chat-attachment-chip').filter({ hasText: 'utils.ts' })).toBeVisible();

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Check the utilities');
  await page.keyboard.press('Enter');

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { requests: Array<{ method: string; path: string; body?: unknown }> };
          }
        ).__varroE2E;
        const promptReq = value?.requests.find(
          (req) => req.method === 'POST' && req.path.includes('prompt_async')
        );
        if (!promptReq?.body || typeof promptReq.body !== 'object') return null;
        const body = promptReq.body as { parts?: Array<{ type: string; text?: string }> };
        if (!body.parts) return null;
        return body.parts.some(
          (part) =>
            part.type === 'text' && typeof part.text === 'string' && part.text.includes('utils.ts')
        );
      })
    )
    .toBe(true);
});

test('pastes an image, sends it as a file part, and clears the chip', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
  await page.getByText('GPT-4.1', { exact: true }).click();
  await expect(page.getByLabel('OpenAI / GPT-4.1')).toBeVisible();

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.evaluate((node) => {
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'clipboard.png', {
      type: 'image/png',
    });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', { value: dataTransfer });
    node.dispatchEvent(event);
  });

  await expect(page.locator('.chat-attachment-chip').filter({ hasText: 'Image' })).toBeVisible();

  await composer.fill('Describe this pasted image');
  await page.keyboard.press('Enter');

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { requests: Array<{ method: string; path: string; body?: unknown }> };
          }
        ).__varroE2E;
        const promptReq = value?.requests.find(
          (req) => req.method === 'POST' && req.path.includes('prompt_async')
        );
        if (!promptReq?.body || typeof promptReq.body !== 'object') return false;
        const body = promptReq.body as {
          parts?: Array<{ type: string; filename?: string; mime?: string; url?: string }>;
        };
        return !!body.parts?.some(
          (part) =>
            part.type === 'file' &&
            part.filename === 'Image 1' &&
            part.mime === 'image/png' &&
            typeof part.url === 'string' &&
            part.url.startsWith('data:image/png;base64,')
        );
      })
    )
    .toBe(true);
  await expect(page.locator('.chat-attachment-chip').filter({ hasText: 'Image' })).toHaveCount(0);
});

test('keeps a line-start pasted image from creating a trailing line', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const composer = page.locator('.rich-composer').first();
  await composer.fill('something');
  await composer.press('Shift+Enter');
  const pasteImage = (name: string, text = '') =>
    composer.evaluate(
      (node, { filename, plainText }) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(
          new File([new TextEncoder().encode(filename)], filename, { type: 'image/png' })
        );
        if (plainText) dataTransfer.setData('text/plain', plainText);
        const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
        Object.defineProperty(event, 'clipboardData', { value: dataTransfer });
        node.dispatchEvent(event);
      },
      { filename: name, plainText: text }
    );

  await pasteImage('first.png', '\n');
  await expect(composer.locator('[data-chip-type="image"]')).toHaveCount(1);

  const linePositions = await composer.evaluate((editor) => {
    const chips = editor.querySelectorAll<HTMLElement>('[data-chip-type="image"]');
    const pastedChip = chips.item(chips.length - 1);
    const selection = window.getSelection();
    const caretRect = selection?.rangeCount
      ? selection.getRangeAt(0).getBoundingClientRect()
      : null;
    return {
      chipTop: pastedChip.getBoundingClientRect().top,
      caretTop: caretRect?.top ?? null,
      brCount: editor.querySelectorAll('br').length,
      trailingText: pastedChip.nextSibling?.textContent,
    };
  });
  expect(linePositions.brCount).toBe(1);
  expect(linePositions.caretTop).not.toBeNull();
  expect(Math.abs(linePositions.caretTop! - linePositions.chipTop)).toBeLessThan(8);
  expect(linePositions.trailingText).toBe('\u200B');

  await composer.locator('[data-chip-type="image"]').evaluate((chip) => {
    const range = document.createRange();
    range.selectNode(chip);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await composer.press('Backspace');
  await expect(composer.locator('[data-chip-type="image"]')).toHaveCount(0);

  await expect
    .poll(() => composer.evaluate((editor) => editor.querySelectorAll('br').length))
    .toBe(1);
});

test('crosses an image chip with one horizontal arrow press', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const composer = page.locator('.rich-composer').first();
  await composer.fill('before ');
  await composer.evaluate((editor) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['image'], 'image.png', { type: 'image/png' }));
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', { value: dataTransfer });
    editor.dispatchEvent(event);
  });

  const chip = composer.locator('[data-chip-type="image"]');
  await expect(chip).toHaveCount(1);
  await chip.evaluate((element) => {
    const trailingSpacer = element.nextSibling;
    if (!trailingSpacer) throw new Error('Expected trailing chip spacer');
    const range = document.createRange();
    range.setStart(trailingSpacer, trailingSpacer.textContent?.length ?? 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });

  await composer.press('ArrowLeft');
  await expect
    .poll(() =>
      chip.evaluate((element) => {
        const selection = window.getSelection();
        return selection?.focusNode === element.previousSibling;
      })
    )
    .toBe(true);

  await composer.press('ArrowRight');
  await expect
    .poll(() =>
      chip.evaluate((element) => {
        const selection = window.getSelection();
        const editor = element.parentNode;
        const trailingSpacer = element.nextSibling;
        return (
          selection?.focusNode === editor &&
          selection.focusOffset ===
            Array.from(editor?.childNodes ?? []).indexOf(trailingSpacer!) + 1
        );
      })
    )
    .toBe(true);
});

test('inserts one visible line break after a pasted image', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');
  await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
  await page.getByText('GPT-4.1', { exact: true }).click();

  const composer = page.locator('.rich-composer').first();
  await composer.fill('something');
  await composer.press('Shift+Enter');
  await composer.evaluate((node) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File([new TextEncoder().encode('image.png')], 'image.png', { type: 'image/png' })
    );
    dataTransfer.setData('text/plain', '\n');
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', { value: dataTransfer });
    node.dispatchEvent(event);
  });
  await expect(composer.locator('[data-chip-type="image"]')).toHaveCount(1);

  await composer.press('Shift+Enter');

  await expect
    .poll(() => composer.evaluate((editor) => editor.querySelectorAll('br').length))
    .toBe(2);
  await expect
    .poll(() =>
      composer.evaluate((editor) => {
        const chip = editor.querySelector<HTMLElement>('[data-chip-type="image"]');
        const placeholder = editor.querySelector<HTMLElement>('[data-caret-placeholder]');
        return chip && placeholder
          ? placeholder.getBoundingClientRect().top - chip.getBoundingClientRect().top
          : null;
      })
    )
    .toBeGreaterThan(8);
});

test('keeps the caret visible after repeated Shift+Enter line breaks', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const composer = page.locator('.rich-composer').first();
  await composer.fill('first line');
  for (let index = 0; index < 12; index++) {
    await composer.press('Shift+Enter');
  }

  const position = await composer.evaluate((editor) => {
    const placeholder = editor.querySelector<HTMLElement>('[data-caret-placeholder]');
    if (!placeholder) throw new Error('Expected trailing caret placeholder');
    const selection = window.getSelection();
    if (!selection?.rangeCount) throw new Error('Expected composer selection');
    const editorRect = editor.getBoundingClientRect();
    const placeholderRect = placeholder.getBoundingClientRect();
    const caretRect = selection.getRangeAt(0).getBoundingClientRect();
    return {
      caretTop: caretRect.top,
      caretHeight: caretRect.height,
      editorTop: editorRect.top,
      editorBottom: editorRect.bottom,
      placeholderTop: placeholderRect.top,
      scrollTop: editor.scrollTop,
    };
  });

  expect(position.scrollTop).toBeGreaterThan(0);
  expect(position.caretHeight).toBeGreaterThan(0);
  expect(Math.abs(position.caretTop - position.placeholderTop)).toBeLessThan(2);
  expect(position.caretTop).toBeGreaterThanOrEqual(position.editorTop);
  expect(position.caretTop).toBeLessThanOrEqual(position.editorBottom);

  for (let index = 0; index < 11; index++) {
    await composer.press('Backspace');
  }

  const reducedPosition = await composer.evaluate((editor) => {
    const placeholder = editor.querySelector<HTMLElement>('[data-caret-placeholder]');
    const selection = window.getSelection();
    if (!placeholder || !selection?.rangeCount) {
      throw new Error('Expected trailing blank-line selection');
    }
    return {
      breakCount: editor.querySelectorAll('br').length,
      caretTop: selection.getRangeAt(0).getBoundingClientRect().top,
      placeholderTop: placeholder.getBoundingClientRect().top,
    };
  });

  expect(reducedPosition.breakCount).toBe(1);
  expect(Math.abs(reducedPosition.caretTop - reducedPosition.placeholderTop)).toBeLessThan(2);
});

test('paints sent portrait tiles at their final presentation without blinking', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');
  await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
  await page.getByText('GPT-4.1', { exact: true }).click();

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.evaluate((node) => {
    const dataTransfer = new DataTransfer();
    for (const [name, color] of [
      ['first.svg', '#2563eb'],
      ['second.svg', '#16a34a'],
    ] as const) {
      dataTransfer.items.add(
        new File(
          [
            `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="320"><rect width="180" height="320" fill="${color}"/></svg>`,
          ],
          name,
          { type: 'image/svg+xml' }
        )
      );
    }
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', { value: dataTransfer });
    node.dispatchEvent(event);
  });
  await expect(page.locator('.chat-attachment-chip').filter({ hasText: 'Image' })).toHaveCount(2);

  const prompt = 'Compare these portrait images';
  await composer.fill(prompt);
  await page.evaluate((promptText) => {
    const samples: string[] = [];
    Object.assign(window, { sentImagePresentationSamples: samples });
    new MutationObserver(() => {
      const card = [...document.querySelectorAll<HTMLElement>('.user-message-card')].findLast(
        (candidate) => candidate.textContent?.includes(promptText)
      );
      const image = card?.querySelector<HTMLElement>('.user-message-image-tile');
      if (image) samples.push(image.className);
    }).observe(document.body, { childList: true, subtree: true, attributes: true });
  }, prompt);

  await page.getByLabel('Send (Enter)').click();
  await expect(page.locator('.user-message-card').filter({ hasText: prompt })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { sentImagePresentationSamples?: string[] })
            .sentImagePresentationSamples?.length ?? 0
      )
    )
    .toBeGreaterThan(0);

  const samples = await page.evaluate(
    () =>
      (window as Window & { sentImagePresentationSamples?: string[] })
        .sentImagePresentationSamples ?? []
  );
  expect(samples[0]).toContain('user-message-image-tile');
  expect(samples.every((sample) => sample.includes('user-message-image-tile'))).toBe(true);
});

test('reloads and inline-edits an image prompt without losing its attachment', async ({ page }) => {
  const sessionId = 'session-reload-persistence';
  const initialText = 'Describe the persisted architecture diagram';
  const editedText = 'Describe the edited architecture diagram';
  type HarnessMessage = {
    info: {
      id: string;
      sessionID: string;
      role: 'user' | 'assistant';
      parentID?: string;
    };
    parts: Array<{
      id: string;
      sessionID: string;
      messageID: string;
      type: string;
      text?: string;
      mime?: string;
      url?: string;
    }>;
  };
  const readHarnessMessages = () =>
    page.evaluate((id) => {
      const harness = window as Window & {
        __varroE2E?: { getSessionMessages?: (sessionId: string) => unknown };
      };
      return harness.__varroE2E?.getSessionMessages?.(id) as HarnessMessage[] | undefined;
    }, sessionId);

  await page.goto('/e2e/harness/index.html?scenario=reload-persistence');
  await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
  await page.getByText('GPT-4.1', { exact: true }).click();

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.evaluate((node) => {
    const file = new File(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#2563eb"/></svg>',
      ],
      'architecture.svg',
      { type: 'image/svg+xml' }
    );
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', { value: dataTransfer });
    node.dispatchEvent(event);
  });
  await expect(page.locator('.chat-attachment-chip').filter({ hasText: 'Image' })).toBeVisible();
  await composer.fill(initialText);
  await page.keyboard.press('Enter');

  const initialRow = page.locator('.chat-turn-user').filter({ hasText: initialText });
  await expect(initialRow).toHaveCount(1);
  await expect(initialRow.getByRole('button', { name: /^Open image preview:/ })).toBeVisible();

  const initialMessages = await readHarnessMessages();
  expect(initialMessages).toHaveLength(2);
  const initialUser = initialMessages?.find((message) => message.info.role === 'user');
  const initialAssistant = initialMessages?.find((message) => message.info.role === 'assistant');
  expect(initialUser).toBeDefined();
  expect(initialAssistant?.info.parentID).toBe(initialUser?.info.id);
  expect(initialUser?.info.sessionID).toBe(sessionId);
  expect(
    initialUser?.parts.every(
      (part) =>
        part.id.length > 0 && part.sessionID === sessionId && part.messageID === initialUser.info.id
    )
  ).toBe(true);
  expect(initialUser?.parts.some((part) => part.type === 'text' && part.text === initialText)).toBe(
    true
  );
  const initialImage = initialUser?.parts.find(
    (part) => part.type === 'file' && part.mime === 'image/svg+xml'
  );
  expect(initialImage?.url).toMatch(/^data:image\/svg\+xml;base64,/);

  await page.reload();
  const reloadedRow = page.locator('.chat-turn-user').filter({ hasText: initialText });
  await expect(reloadedRow).toHaveCount(1);
  await expect(reloadedRow.getByRole('button', { name: /^Open image preview:/ })).toBeVisible();

  await reloadedRow.getByText(initialText, { exact: true }).click();
  const inlineComposer = page.locator(
    '.inline-edit-composer-slot [role="textbox"][aria-multiline="true"]'
  );
  await expect(inlineComposer).toBeVisible();
  await expect(
    page.locator('.inline-edit-composer-slot .chat-attachment-chip').filter({ hasText: 'Image' })
  ).toBeVisible();
  await inlineComposer.fill(editedText);
  await inlineComposer.press('Enter');

  const editedRow = page.locator('.chat-turn-user').filter({ hasText: editedText });
  await expect(editedRow).toHaveCount(1);
  await expect(editedRow.getByRole('button', { name: /^Open image preview:/ })).toBeVisible();
  await expect(page.locator('.chat-turn-user').filter({ hasText: initialText })).toHaveCount(0);

  const editRequests = await page.evaluate(() => {
    const harness = window as Window & {
      __varroE2E?: { requests: Array<{ method: string; path: string }> };
    };
    return (harness.__varroE2E?.requests ?? [])
      .filter(
        (request) =>
          (request.method === 'DELETE' && request.path.includes('/message/')) ||
          (request.method === 'POST' && request.path.endsWith('/prompt_async'))
      )
      .map((request) => `${request.method} ${request.path}`);
  });
  expect(editRequests).toEqual([
    `DELETE /session/${sessionId}/message/${initialAssistant!.info.id}`,
    `DELETE /session/${sessionId}/message/${initialUser!.info.id}`,
    `POST /session/${sessionId}/prompt_async`,
  ]);

  const editedMessages = await readHarnessMessages();
  expect(editedMessages).toHaveLength(2);
  const editedUser = editedMessages?.find((message) => message.info.role === 'user');
  expect(editedUser?.info.id).not.toBe(initialUser?.info.id);
  expect(
    editedUser?.parts.every(
      (part) =>
        part.id.length > 0 && part.sessionID === sessionId && part.messageID === editedUser.info.id
    )
  ).toBe(true);
  expect(editedUser?.parts.some((part) => part.type === 'text' && part.text === editedText)).toBe(
    true
  );
  expect(editedUser?.parts.find((part) => part.type === 'file')?.url).toBe(initialImage?.url);

  await page.reload();
  const editedReloadedRow = page.locator('.chat-turn-user').filter({ hasText: editedText });
  await expect(editedReloadedRow).toHaveCount(1);
  await expect(
    editedReloadedRow.getByRole('button', { name: /^Open image preview:/ })
  ).toBeVisible();
});

test('removes individual dropped files via the chip remove button', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();

  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'files/dropped',
        payload: [
          { path: '/workspace/varro/src/a.ts', relativePath: 'src/a.ts', type: 'file' },
          { path: '/workspace/varro/src/b.ts', relativePath: 'src/b.ts', type: 'file' },
        ],
      },
      '*'
    );
  });

  await expect(page.locator('.chat-attachment-chip')).toHaveCount(2);

  const chip = page.locator('.chat-attachment-chip').filter({ hasText: 'a.ts' });
  await chip.locator('.chip-remove').click();

  await expect(page.locator('.chat-attachment-chip')).toHaveCount(1);
  await expect(page.locator('.chat-attachment-chip').filter({ hasText: 'b.ts' })).toBeVisible();
});
