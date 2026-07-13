import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('searches workspace files via @ mention and adds file to context', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=file-search');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('@StickyHeader');

  await expect(page.getByText('StickyHeader.tsx', { exact: false })).toBeVisible();

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await expect(page.getByTitle(/StickyHeader\.tsx/)).toBeVisible();
});

test('message body includes attached file reference', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=file-search');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('@README');
  await expect(page.getByText('README.md', { exact: false })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await expect(page.getByTitle(/README\.md/)).toBeVisible();

  await page.keyboard.type(' Review the project');
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
            part.type === 'text' && typeof part.text === 'string' && part.text.includes('README.md')
        );
      })
    )
    .toBe(true);
});

test('removing a file chip clears it from context', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=file-search');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('@README');
  await expect(page.getByText('README.md', { exact: false })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await expect(page.getByTitle(/README\.md/)).toBeVisible();

  await composer.fill('');

  await expect(page.getByTitle(/README\.md/)).toHaveCount(0);
});

test('message uses workspace-relative path for file references', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=file-search');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('@session-filter');
  await expect(page.getByText('session-filter.ts', { exact: false })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await expect(page.getByTitle(/session-filter\.ts/)).toBeVisible();

  await page.keyboard.type(' Check the filter');
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
        const part = body.parts.find(
          (p) =>
            p.type === 'text' && typeof p.text === 'string' && p.text.includes('session-filter')
        );
        return part?.text || null;
      })
    )
    .toContain('src/lib/session-filter.ts');
});
