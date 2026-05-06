import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('context bar shows file with selection line range after context/update', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready');
  await page.locator('[role="textbox"][aria-multiline="true"]').first().waitFor();

  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'context/update',
        payload: {
          workspacePath: '/workspace/varro',
          activeFile: {
            path: '/workspace/varro/src/webview/lib/state.ts',
            relativePath: 'src/webview/lib/state.ts',
            language: 'typescript',
          },
          selection: { startLine: 10, endLine: 15 },
          diagnostics: [],
        },
      },
      '*'
    );
  });

  await expect(page.locator('[title*="L10-15"]')).toBeVisible();
  await expect(page.getByText('state.ts')).toBeVisible();
});

test('prompt body includes selection reference from active editor', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready');
  await page.locator('[role="textbox"][aria-multiline="true"]').first().waitFor();

  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'context/update',
        payload: {
          workspacePath: '/workspace/varro',
          activeFile: {
            path: '/workspace/varro/src/shared/context-files.ts',
            relativePath: 'src/shared/context-files.ts',
            language: 'typescript',
          },
          selection: { startLine: 42, endLine: 58 },
          diagnostics: [],
        },
      },
      '*'
    );
  });

  await expect(page.locator('[title*="L42-58"]')).toBeVisible();

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('Explain this function');
  await page.keyboard.press('Enter');

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (window as Window & {
          __varroE2E?: { requests: Array<{ method: string; path: string; body?: unknown }> };
        }).__varroE2E;
        const promptReq = value?.requests.find(
          (req) => req.method === 'POST' && req.path.includes('prompt_async')
        );
        if (!promptReq?.body || typeof promptReq.body !== 'object') return null;
        const body = promptReq.body as { parts?: Array<{ type: string; text?: string }> };
        if (!body.parts) return null;
        return body.parts.some(
          (part) =>
            part.type === 'text' &&
            typeof part.text === 'string' &&
            part.text.includes('context-files.ts') &&
            part.text.includes('lines 42-58')
        );
      })
    )
    .toBe(true);
});

test('updating selection range updates the context bar display', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready');
  await page.locator('[role="textbox"][aria-multiline="true"]').first().waitFor();

  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'context/update',
        payload: {
          workspacePath: '/workspace/varro',
          activeFile: {
            path: '/workspace/varro/src/webview/lib/state.ts',
            relativePath: 'src/webview/lib/state.ts',
            language: 'typescript',
          },
          selection: { startLine: 5, endLine: 8 },
          diagnostics: [],
        },
      },
      '*'
    );
  });

  await expect(page.locator('[title*="L5-8"]')).toBeVisible();

  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'context/update',
        payload: {
          workspacePath: '/workspace/varro',
          activeFile: {
            path: '/workspace/varro/src/webview/lib/state.ts',
            relativePath: 'src/webview/lib/state.ts',
            language: 'typescript',
          },
          selection: { startLine: 100, endLine: 120 },
          diagnostics: [],
        },
      },
      '*'
    );
  });

  await expect(page.locator('[title*="L100-120"]')).toBeVisible();
  await expect(page.locator('[title*="L5-8"]')).toHaveCount(0);
});

test('clearing selection shows active file without line range', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready');
  await page.locator('[role="textbox"][aria-multiline="true"]').first().waitFor();

  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'context/update',
        payload: {
          workspacePath: '/workspace/varro',
          activeFile: {
            path: '/workspace/varro/src/webview/lib/state.ts',
            relativePath: 'src/webview/lib/state.ts',
            language: 'typescript',
          },
          selection: { startLine: 10, endLine: 15 },
          diagnostics: [],
        },
      },
      '*'
    );
  });

  await expect(page.locator('[title*="L10-15"]')).toBeVisible();

  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'context/update',
        payload: {
          workspacePath: '/workspace/varro',
          activeFile: {
            path: '/workspace/varro/src/webview/lib/state.ts',
            relativePath: 'src/webview/lib/state.ts',
            language: 'typescript',
          },
          selection: null,
          diagnostics: [],
        },
      },
      '*'
    );
  });

  await expect(page.getByText('state.ts')).toBeVisible();
  await expect(page.locator('[title*="L10-15"]')).toHaveCount(0);
});
