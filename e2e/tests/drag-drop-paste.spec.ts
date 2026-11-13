/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns -- Playwright callbacks inspect browser clipboard and request payloads whose values cross an untyped browser boundary. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Assertions bridge controlled clipboard, drag, and harness request fixtures to the shapes under test. */
import { mkdir, writeFile } from 'node:fs/promises';
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

test('does not show the drop overlay while dragging a chat link out of the webview', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');
  await expect(page.locator('.rich-composer').first()).toBeVisible();

  await page.evaluate(() => {
    const source = document.createElement('a');
    source.id = 'outgoing-chat-link';
    source.href = 'https://example.com/chat-link';
    source.textContent = 'Drag chat link';
    source.style.cssText = 'position:fixed;top:20px;left:20px;z-index:9999';
    document.body.append(source);

    const outside = document.createElement('iframe');
    outside.id = 'outside-chat';
    outside.style.cssText =
      'position:fixed;top:80px;left:20px;width:200px;height:100px;z-index:9999';
    document.body.append(outside);
    const target = outside.contentDocument!.body;
    target.textContent = 'Drop outside chat';
    target.addEventListener('dragover', (event) => event.preventDefault());
    target.addEventListener('drop', (event) => {
      event.preventDefault();
      target.textContent = event.dataTransfer!.getData('text/uri-list');
    });
    // Observe transient overlays as well as the final state after the drag.
    document.body.dataset.dropOverlayShown = 'false';
    new MutationObserver((records) => {
      for (const record of records) {
        if (
          Array.from(record.addedNodes).some(
            (node) => node instanceof Element && node.matches('.chat-drop-overlay')
          )
        ) {
          document.body.dataset.dropOverlayShown = 'true';
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  const source = await page.locator('#outgoing-chat-link').boundingBox();
  const target = await page.locator('#outside-chat').boundingBox();
  if (!source || !target) throw new Error('Expected outgoing drag source and target');
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 + 15, source.y + source.height / 2, {
    steps: 5,
  });
  await expect(page.locator('.chat-drop-overlay')).toHaveCount(0);
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  await page.mouse.up();

  await expect(page.frameLocator('#outside-chat').locator('body')).toHaveText(
    'https://example.com/chat-link'
  );
  await expect(page.locator('body')).toHaveAttribute('data-drop-overlay-shown', 'false');
  await expect(page.locator('.chat-drop-overlay')).toHaveCount(0);
});

for (const { name, value, resource, icon } of [
  {
    name: 'README.md',
    value: '/workspace/varro/README.md',
    resource: 'file:///workspace/varro/README.md',
    icon: false,
  },
  {
    name: 'README.md',
    value: '/workspace/varro/README.md',
    resource: 'file:///workspace/varro/README.md',
    icon: true,
  },
  { name: 'release notes', value: 'https://example.com/varro/releases', resource: '', icon: false },
]) {
  test(`drags ${name}${icon ? ' icon' : ''} into an external text target as its value`, async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=message-rendering');
    const link = page.getByRole('link', { name, exact: true });
    await expect(link).toBeVisible();
    await link.scrollIntoViewIfNeeded();

    await page.evaluate(() => {
      // Observe the payload after MarkdownRenderer's delegated dragstart handler.
      document.addEventListener(
        'dragstart',
        (event) => {
          document.body.dataset.dragUri = event.dataTransfer!.getData('text/uri-list');
        },
        { once: true }
      );
      const outside = document.createElement('iframe');
      outside.id = 'external-text-target';
      outside.style.cssText =
        'position:fixed;top:20px;right:20px;width:240px;height:100px;z-index:9999';
      document.body.append(outside);
      const target = outside.contentDocument!.createElement('textarea');
      target.id = 'drop-value';
      target.style.cssText = 'width:200px;height:60px';
      target.addEventListener('drop', (event) => {
        target.dataset.resource = event.dataTransfer!.getData('ResourceURLs');
        target.dataset.uri = event.dataTransfer!.getData('text/uri-list');
      });
      outside.contentDocument!.body.append(target);
    });

    const target = page.frameLocator('#external-text-target').locator('#drop-value');
    const sourceBox = await (icon ? link.locator('.file-path-icon') : link).boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) throw new Error('Expected link drag source and text target');
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      sourceBox.x + sourceBox.width / 2 + 15,
      sourceBox.y + sourceBox.height / 2,
      {
        steps: 5,
      }
    );
    await expect(page.locator('body')).toHaveAttribute('data-drag-uri', resource || value);
    await expect(page.locator('.chat-drop-overlay')).toHaveCount(0);
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
      steps: 10,
    });
    await page.mouse.up();

    await expect(target).toHaveValue(value);
    // Chromium sanitizes file:// URI-list entries from an HTTP page across frames.
    // Plain text and VS Code's resource list must still reach the native drop target intact.
    await expect(target).toHaveAttribute('data-uri', resource ? 'about:blank#blocked' : value);
    await expect(target).toHaveAttribute(
      'data-resource',
      resource ? JSON.stringify([resource]) : ''
    );
    await expect(page.locator('.chat-drop-overlay')).toHaveCount(0);
  });
}

for (const cancelledChatDrag of [false, true]) {
  test(`delivers a Shift move-only file drop, cancelled chat drag=${cancelledChatDrag}`, async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=blank');
    const composer = page.locator('.rich-composer').first();
    await expect(composer).toBeVisible();

    if (cancelledChatDrag) {
      await page.evaluate(() => {
        const source = document.createElement('a');
        source.id = 'cancelled-chat-drag';
        source.href = 'https://example.com/chat-link';
        source.textContent = 'Cancelled chat drag';
        source.style.cssText = 'position:fixed;top:120px;left:20px;z-index:9999';
        source.addEventListener('dragstart', (event) => {
          event.preventDefault();
          source.dataset.cancelled = 'true';
        });
        document.body.append(source);
      });
      const source = page.locator('#cancelled-chat-drag');
      await source.dragTo(composer);
      await expect(source).toHaveAttribute('data-cancelled', 'true');
      await source.evaluate((node) => node.remove());
    }

    await page.evaluate(() => {
      const harness = window as Window & {
        attachmentDrops?: unknown[];
      };
      harness.attachmentDrops = [];
      const send = harness.__sendToExtension;
      if (!send) throw new Error('Expected the E2E extension bridge');
      harness.__sendToExtension = (message) => {
        if ((message as { type?: string }).type === 'files/drop') {
          harness.attachmentDrops!.push(message);
        }
        return send(message);
      };
      // An iframe keeps the native source outside the chat document, as in VS Code's explorer.
      const outside = document.createElement('iframe');
      outside.id = 'outside-file-source';
      outside.style.cssText =
        'position:fixed;top:20px;left:20px;width:200px;height:80px;z-index:9999';
      document.body.append(outside);
      const sourceDocument = outside.contentDocument!;
      const source = sourceDocument.createElement('div');
      source.id = 'windows-file-drag';
      source.draggable = true;
      source.textContent = 'Drag Windows file';
      source.style.cssText =
        'position:fixed;top:20px;left:20px;width:180px;height:40px;z-index:9999';
      source.addEventListener('dragstart', (event) => {
        event.dataTransfer!.effectAllowed = 'move';
        event.dataTransfer!.setData('CodeFiles', JSON.stringify(['C:\\repo\\src\\example.ts']));
      });
      sourceDocument.body.append(source);
    });

    const source = await page
      .frameLocator('#outside-file-source')
      .locator('#windows-file-drag')
      .boundingBox();
    const target = await composer.boundingBox();
    if (!source || !target) throw new Error('Expected incoming file drag source and target');
    await page.keyboard.down('Shift');
    try {
      await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
      await page.mouse.down();
      await page.mouse.move(source.x + source.width / 2 + 15, source.y + source.height / 2, {
        steps: 5,
      });
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {
        steps: 10,
      });
      await page.mouse.up();
    } finally {
      await page.keyboard.up('Shift');
    }

    await expect
      .poll(() =>
        page.evaluate(() => (window as Window & { attachmentDrops?: unknown[] }).attachmentDrops)
      )
      .toEqual([{ type: 'files/drop', payload: { paths: ['C:\\repo\\src\\example.ts'] } }]);
    await expect(page.getByText('Drop to add to context')).toHaveCount(0);
  });
}

test('delivers a native external folder drop without Shift after crossing the chat', async ({
  page,
}, testInfo) => {
  const folder = testInfo.outputPath('external-folder');
  await mkdir(`${folder}/nested`, { recursive: true });
  await mkdir(`${folder}/empty`, { recursive: true });
  await writeFile(`${folder}/nested/note.txt`, 'hello');

  await page.addInitScript(() => {
    // Model VS Code's window-level forwarding, installed before extension code.
    const claimDrag = (event: DragEvent) => {
      if (event.type === 'dragenter' && event.defaultPrevented) return;
      if (event.shiftKey || !event.dataTransfer?.items.length) return;
      if (!Array.from(event.dataTransfer.items).every((item) => item.kind === 'file')) return;
      document.body.dataset.hostDragTakeovers = String(
        Number(document.body.dataset.hostDragTakeovers ?? '0') + 1
      );
    };
    window.addEventListener('dragenter', claimDrag);
    window.addEventListener('dragover', claimDrag);
  });
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const composer = page.locator('.rich-composer').first();
  await expect(composer).toBeVisible();
  await page.evaluate(() => {
    const harness = window as Window & { attachmentDrops?: unknown[] };
    harness.attachmentDrops = [];
    const send = harness.__sendToExtension;
    if (!send) throw new Error('Expected the E2E extension bridge');
    harness.__sendToExtension = (message) => {
      if ((message as { type?: string }).type === 'files/drop-content') {
        harness.attachmentDrops!.push(message);
      }
      return send(message);
    };
  });

  const target = await composer.boundingBox();
  if (!target) throw new Error('Expected incoming folder drop target');
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: [folder], dragOperationsMask: 1 };
  try {
    await cdp.send('Input.dispatchDragEvent', {
      type: 'dragEnter',
      x: 20,
      y: 20,
      data,
      modifiers: 0,
    });
    await cdp.send('Input.dispatchDragEvent', {
      type: 'dragOver',
      x: 20,
      y: 20,
      data,
      modifiers: 0,
    });
    await expect(page.getByText('Drop to add to context')).toBeVisible();
    const x = target.x + target.width / 2;
    const y = target.y + target.height / 2;
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data, modifiers: 0 });
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data, modifiers: 0 });
    await expect
      .poll(() =>
        page.evaluate(() => (window as Window & { attachmentDrops?: unknown[] }).attachmentDrops)
      )
      .toEqual([
        {
          type: 'files/drop-content',
          payload: {
            directory: { name: 'external-folder', directories: ['empty', 'nested'] },
            files: [{ name: 'nested/note.txt', content: 'aGVsbG8=', size: 5 }],
          },
        },
      ]);
    expect(await page.locator('body').getAttribute('data-host-drag-takeovers')).toBeNull();
    await expect(page.getByText('Drop to add to context')).toHaveCount(0);
  } finally {
    await cdp.detach();
  }
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
    // The success path needs a decodable image, not just a truncated PNG signature.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]!), (char) =>
      char.charCodeAt(0)
    );
    const file = new File([bytes], 'clipboard.png', {
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
  await expect(page.getByRole('button', { name: 'Send (Enter)', exact: true })).toBeEnabled();
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

test('shows the duplicate-image warning above the input and list fade', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 1040 });
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const composer = page.locator('.rich-composer').first();
  await composer.click();
  const pasteImage = () =>
    composer.evaluate((node) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]!), (char) =>
        char.charCodeAt(0)
      );
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
      node.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard })
      );
    });

  await pasteImage();
  const images = page.locator('.chat-attachment-chip').filter({ hasText: 'Image' });
  await expect(images).toHaveCount(1);
  const shell = page.locator('.chat-input-shell').first();
  const initialBounds = await shell.boundingBox();
  if (!initialBounds) throw new Error('Expected input bounds');

  await pasteImage();
  const warning = shell.locator('.session-action-feedback');
  await expect(warning).toContainText('This image is already attached');
  await expect(images).toHaveCount(1);
  await expect
    .poll(async () => {
      const inputBounds = await shell.boundingBox();
      const warningBounds = await warning.boundingBox();
      if (!inputBounds || !warningBounds) throw new Error('Expected input and warning bounds');
      return {
        gap: Math.round(inputBounds.y - warningBounds.y - warningBounds.height),
        centerOffset: Math.round(
          warningBounds.x + warningBounds.width / 2 - inputBounds.x - inputBounds.width / 2
        ),
        inputShift: Math.round(inputBounds.y - initialBounds.y),
      };
    })
    .toEqual({ gap: 24, centerOffset: 0, inputShift: 0 });

  const layers = await shell.evaluate((element) => {
    const fade = document.querySelector('.interactive-list-bottom-fade-wrap');
    if (!fade) throw new Error('Expected list fade');
    return {
      shell: Number(getComputedStyle(element).zIndex),
      fade: Number(getComputedStyle(fade).zIndex),
    };
  });
  expect(layers.shell).toBeGreaterThan(layers.fade);
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
  await expect(page.getByRole('button', { name: 'Send (Enter)', exact: true })).toBeEnabled();
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
  // Restoring the chip starts an asynchronous decode check; visibility alone is not send readiness.
  await expect(
    page
      .locator('.inline-edit-composer-slot')
      .getByRole('button', { name: 'Send (Enter)', exact: true })
  ).toBeEnabled();
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
          (request.method === 'POST' &&
            new URL(request.path, 'http://varro.test').pathname.endsWith('/prompt_async'))
      )
      .map((request) => `${request.method} ${request.path}`);
  });
  expect(editRequests).toEqual([
    `DELETE /session/${sessionId}/message/${initialAssistant!.info.id}?directory=%2Fworkspace%2Fvarro`,
    `DELETE /session/${sessionId}/message/${initialUser!.info.id}?directory=%2Fworkspace%2Fvarro`,
    `POST /session/${sessionId}/prompt_async?directory=%2Fworkspace%2Fvarro`,
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
