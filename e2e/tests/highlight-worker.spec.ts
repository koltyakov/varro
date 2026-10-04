import { expect, test } from '@playwright/test';
import { appendDeltaToRapidStreaming } from './scroll-helpers';

const ROW = '[data-msg-id="message-rapid-assistant-streaming"]';

test('highlights in a worker without replacing code controls or interrupting streaming', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/highlight-worker.ts?worker_file*', async (route) => {
    await gate;
    await route.continue();
  });
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  const markdown = page.locator(`${ROW} .rendered-markdown`);
  await expect(markdown).toHaveText('Starting...');
  await appendDeltaToRapidStreaming(
    page,
    '\n\n```ts\nconst workerValue = 42;\n```\n\nReadable tail.'
  );
  const code = markdown.locator('pre code');
  await expect(code).toHaveText('const workerValue = 42;');
  await expect(code.locator('.hljs-keyword')).toHaveCount(0);
  const identity = await markdown.evaluateHandle((root) => ({
    wrapper: root.querySelector('.interactive-result-code-block'),
    code: root.querySelector('pre code'),
    copy: root.querySelector('button[data-copy]'),
    height: root.querySelector('pre code')!.getBoundingClientRect().height,
  }));
  await appendDeltaToRapidStreaming(page, ' More text while highlighting waits.');
  await expect(markdown).toContainText('More text while highlighting waits.');
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.pressSequentially('Typing while code highlighting waits');
  await expect(composer).toHaveText('Typing while code highlighting waits');
  release();
  await expect(code.locator('.hljs-keyword')).toHaveText('const');
  expect(workers).toHaveLength(1);
  expect(
    await identity.evaluate((previous) => ({
      connected:
        !!previous.wrapper?.isConnected &&
        !!previous.code?.isConnected &&
        !!previous.copy?.isConnected,
      height: previous.code!.getBoundingClientRect().height,
      before: previous.height,
    }))
  ).toEqual({
    connected: true,
    height: await code.evaluate((e) => e.getBoundingClientRect().height),
    before: await code.evaluate((e) => e.getBoundingClientRect().height),
  });
});

test('keeps open and oversized fences readable and highlights closed aliases', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  const markdown = page.locator(`${ROW} .rendered-markdown`);
  await expect(markdown).toHaveText('Starting...');
  await appendDeltaToRapidStreaming(page, '\n\n```tsx\nconst node = <div>😀</div>;');
  await expect(markdown.locator('code')).toHaveText('const node = <div>😀</div>;');
  await expect(markdown.locator('.hljs-keyword')).toHaveCount(0);
  await appendDeltaToRapidStreaming(page, '\n```\n\nDone.');
  await expect(markdown.locator('.hljs-keyword')).toHaveText('const');
  const longLine = 'a'.repeat(1001) + '<&';
  await appendDeltaToRapidStreaming(page, `\n\n\`\`\`ts\n${longLine}\n\`\`\`\n\nEnd.`);
  await expect(markdown.locator('code').last()).toHaveText(longLine);
  await expect(markdown.locator('code').last().locator('span')).toHaveCount(0);
});

test('continues streaming when the highlighting worker cannot load', async ({ page }) => {
  await page.route('**/highlight-worker.ts?worker_file*', (route) => route.abort());
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  const markdown = page.locator(`${ROW} .rendered-markdown`);
  await expect(markdown).toHaveText('Starting...');
  await appendDeltaToRapidStreaming(page, '\n\n```ts\nconst value = 1;\n```\n\nStill readable.');
  await expect(markdown).toContainText('Still readable.');
  await expect(markdown.locator('code')).toHaveText('const value = 1;');
  await appendDeltaToRapidStreaming(page, ' Continuing after failure.');
  await expect(markdown).toContainText('Continuing after failure.');
  await expect(markdown.locator('.hljs-keyword')).toHaveCount(0);
});

test('highlights a near-limit block without losing its code text', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  const markdown = page.locator(`${ROW} .rendered-markdown`);
  await expect(markdown).toHaveText('Starting...');
  const source = Array.from(
    { length: 650 },
    (_, index) => `export const entry${index} = ${index};`
  ).join('\n');
  expect(source.length).toBeGreaterThan(18_000);
  expect(source.length).toBeLessThan(20_000);
  await appendDeltaToRapidStreaming(page, `\n\n\`\`\`ts\n${source}\n\`\`\`\n\nFinished.`);
  const code = markdown.locator('code');
  await expect(code).toHaveText(source);
  await expect(code.locator('.hljs-keyword')).toHaveCount(1300);
  expect(await code.textContent()).toBe(source);
});
