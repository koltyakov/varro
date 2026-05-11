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
            part.filename === 'Image' &&
            part.mime === 'image/png' &&
            typeof part.url === 'string' &&
            part.url.startsWith('data:image/png;base64,')
        );
      })
    )
    .toBe(true);
  await expect(page.locator('.chat-attachment-chip').filter({ hasText: 'Image' })).toHaveCount(0);
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
