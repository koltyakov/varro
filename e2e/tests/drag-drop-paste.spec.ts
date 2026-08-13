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

  await page.getByTitle('GitHub Copilot / GPT-5 mini').click();
  await page.getByText('GPT-4.1', { exact: true }).click();
  await expect(page.getByTitle('OpenAI / GPT-4.1')).toBeVisible();

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
  await page.getByTitle('GitHub Copilot / GPT-5 mini').click();
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
  await expect(initialRow.locator('.chat-image-preview-trigger')).toBeVisible();

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
  await expect(reloadedRow.locator('.chat-image-preview-trigger')).toBeVisible();

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
  await expect(editedRow.locator('.chat-image-preview-trigger')).toBeVisible();
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
  await expect(editedReloadedRow.locator('.chat-image-preview-trigger')).toBeVisible();
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
