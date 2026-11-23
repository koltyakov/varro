import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { MessageEntry, TextPart } from '../../src/webview/types';
import type { ServerEvent } from '../../src/shared/protocol';
import { scrollToBottom, waitForAnimationFrames } from './helpers';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

async function setMode(page: Page, remoteImages: 'off' | 'ask' | 'on') {
  await page.evaluate(
    (mode) =>
      window.postMessage(
        {
          type: 'config/update',
          payload: {
            remoteImages: mode,
            desktopSessionPaneSide: 'right',
            defaultPermissionMode: 'default',
            chatFontSize: 13,
            chatEditorFontSize: 12,
            chatFontFamily: 'default',
          },
        },
        window.location.origin
      ),
    remoteImages
  );
}

async function installImage(page: Page, messageId = 'message-large-assistant-239', count = 1) {
  await page.evaluate(
    ({ id, imageCount }) => {
      // SAFETY: This page is the isolated E2E harness, which installs these fixture methods.
      const harness = (
        window as Window & {
          __varroE2E?: {
            getSessionMessages?: (id: string) => MessageEntry[];
            replayServerEvent?: (event: ServerEvent) => void;
          };
        }
      ).__varroE2E;
      const message = harness
        ?.getSessionMessages?.('session-large-transcript')
        .find((entry) => entry.info.id === id);
      if (!message || !harness?.replayServerEvent)
        throw new Error('Transcript fixture unavailable');
      const previous = message.parts.find((part) => part.type === 'text');
      const part: TextPart = {
        id: previous?.id ?? 'remote-image-text',
        sessionID: message.info.sessionID,
        messageID: message.info.id,
        type: 'text',
        text:
          Array.from(
            { length: imageCount },
            (_, index) =>
              `![Example chart${imageCount > 1 ? ` ${index + 1}` : ''}](https://images.example/${id}-${index}.png)`
          ).join('\n\n') + '\n\nAfter image.',
      };
      harness.replayServerEvent({ type: 'message.part.updated', properties: { part } });
    },
    { id: messageId, imageCount: count }
  );
}

async function requestCount(page: Page) {
  // SAFETY: The isolated harness records every simulated host request in this array.
  return page.evaluate(
    () =>
      (
        window as Window & {
          __varroE2E?: {
            requests: Array<{ path: string }>;
          };
        }
      ).__varroE2E?.requests.filter((request) => request.path === '/varro/remote-image').length ?? 0
  );
}

for (const width of [360, 960]) {
  test(`loads remote images only after consent and retains row geometry at ${width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    const remoteRequests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.url().startsWith('https://images.example/')) remoteRequests.push(request.url());
    });
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await installImage(page);
    const row = page.locator('[data-msg-id="message-large-assistant-239"]');
    await expect(row).toContainText('Example chart');
    await expect(row.getByRole('button', { name: 'Load image', exact: true })).toBeVisible();
    await setMode(page, 'off');
    await expect(row.getByRole('button', { name: 'Load image', exact: true })).toHaveCount(0);
    expect(await requestCount(page)).toBe(0);

    await setMode(page, 'ask');
    const load = row.getByRole('button', { name: 'Load image', exact: true });
    await expect(load).toBeVisible();
    await waitForAnimationFrames(page, 20);
    expect(await requestCount(page)).toBe(0);
    const frame = row.locator('[data-remote-image]');
    const before = await frame.boundingBox();
    expect(before?.width).toBeGreaterThan(150);
    expect(before?.height).toBeGreaterThan(80);
    const beforeRow = await row.boundingBox();
    await expect(frame.locator('.remote-markdown-image-placeholder')).toHaveCSS(
      'background-image',
      /radial-gradient/
    );
    await expect(frame.locator('.remote-markdown-image-placeholder')).toHaveCSS(
      'animation-name',
      'none'
    );
    const all = row.getByRole('button', { name: 'Load all', exact: true });
    await expect(all).toBeVisible();
    // Read relative geometry together so a pending transcript scroll cannot mix frame positions.
    const layout = await frame.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const loadBounds = element
        .querySelector('.remote-markdown-image-load')
        ?.getBoundingClientRect();
      const allBounds = element
        .querySelector('.remote-markdown-image-load-all')
        ?.getBoundingClientRect();
      const heading = element
        .querySelector('.remote-markdown-image-heading')
        ?.getBoundingClientRect();
      const actions = element
        .querySelector('.remote-markdown-image-actions')
        ?.getBoundingClientRect();
      const urlRow = element
        .querySelector('.remote-markdown-image-url-row')
        ?.getBoundingClientRect();
      if (!loadBounds || !allBounds || !heading || !actions || !urlRow)
        throw new Error('Image controls missing');
      return {
        buttonHeight: loadBounds.height,
        buttonWidthDifference: Math.abs(loadBounds.width - allBounds.width),
        buttonRowDifference: Math.abs(loadBounds.y - allBounds.y),
        buttonGap: allBounds.x - loadBounds.right,
        actionsInset: bounds.width - actions.width,
        headingTop: heading.top - bounds.top,
        headingLeft: heading.left - bounds.left,
        actionsBottom: bounds.bottom - loadBounds.bottom,
        urlCenterOffset: Math.abs(urlRow.y + urlRow.height / 2 - (bounds.y + bounds.height / 2)),
      };
    });
    expect(layout.buttonHeight).toBeLessThanOrEqual(26);
    expect(layout.buttonWidthDifference).toBeLessThan(1);
    expect(layout.buttonRowDifference).toBe(0);
    expect(layout.buttonGap).toBeGreaterThan(0);
    expect(layout.actionsInset).toBeLessThan(30);
    expect(layout.headingTop).toBeLessThan(20);
    expect(layout.headingLeft).toBeLessThan(20);
    expect(layout.actionsBottom).toBeLessThan(20);
    expect(layout.urlCenterOffset).toBeLessThan(10);
    const link = frame.locator('.remote-markdown-image-url');
    const url = await link.getAttribute('href');
    await expect(link).toHaveText(url!);
    await frame.getByRole('button', { name: 'Copy image URL', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    await link.click();
    // SAFETY: The isolated E2E harness records requests to open external URLs without navigating.
    expect(
      await page.evaluate(
        () =>
          (window as Window & { __varroE2E?: { externalUrls: string[] } }).__varroE2E?.externalUrls
      )
    ).toEqual([url]);
    expect(await requestCount(page)).toBe(0);
    await page.screenshot({ path: test.info().outputPath('remote-image-placeholder.png') });
    await load.click();
    const samples = await page.evaluate(async () => {
      const sourceRow = document.querySelector<HTMLElement>(
        '[data-msg-id="message-large-assistant-239"]'
      );
      const image = sourceRow?.querySelector<HTMLElement>('[data-remote-image]');
      if (!sourceRow || !image) throw new Error('Image row missing');
      const heights: number[] = [];
      for (let index = 0; index < 35; index += 1) {
        heights.push(sourceRow.getBoundingClientRect().height);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return heights;
    });
    await expect(frame.locator('img')).toBeVisible();
    const after = await frame.boundingBox();
    expect(after?.width).toBe(before?.width);
    expect(after?.height).toBe(before?.height);
    expect(Math.max(...samples) - Math.min(...samples)).toBeLessThanOrEqual(1);
    expect(await row.boundingBox().then((box) => box?.height)).toBe(beforeRow?.height);
    expect(await requestCount(page)).toBe(1);
    expect(remoteRequests).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('remote-image-loaded.png') });

    await frame.getByRole('button', { name: 'Open image preview: Example chart' }).click();
    await expect(page.locator('.chat-image-preview-img')).toBeVisible();
    await page.getByRole('button', { name: 'Close image preview', exact: true }).click();
    expect(await requestCount(page)).toBe(1);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -10000, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(row).toHaveCount(0);
    await scrollToBottom(list);
    await expect(row.locator('[data-remote-image] img')).toBeVisible();
    expect(await requestCount(page)).toBe(1);

    await setMode(page, 'off');
    await expect(row.locator('[data-remote-image] img')).toHaveCount(0);
    await setMode(page, 'ask');
    await expect(row.getByRole('button', { name: 'Load image', exact: true })).toBeVisible();
    expect(await requestCount(page)).toBe(1);
    expect(errors).toEqual([]);
  });
}

for (const theme of ['light', 'high-contrast'] as const) {
  test(`keeps the ${theme} placeholder background local and static`, async ({ page }) => {
    await page.setViewportSize({ width: 486, height: 800 });
    await page.goto(`/e2e/harness/index.html?scenario=large-transcript&theme=${theme}`);
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await installImage(page);
    const placeholder = page.locator(
      '[data-msg-id="message-large-assistant-239"] .remote-markdown-image-placeholder'
    );
    await expect(
      placeholder.getByRole('button', { name: 'Load image', exact: true })
    ).toBeVisible();
    await expect(placeholder).toHaveCSS(
      'background-image',
      theme === 'light' ? /radial-gradient/ : 'none'
    );
    await expect(placeholder).toHaveCSS('animation-name', 'none');
    expect(await requestCount(page)).toBe(0);
    await placeholder.screenshot({ path: test.info().outputPath('remote-image-placeholder.png') });
  });
}

test('loads all images only in the selected response', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');
  const list = page.locator('.interactive-list');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
  await installImage(page, 'message-large-assistant-238');
  await installImage(page, 'message-large-assistant-239', 4);
  const row = page.locator('[data-msg-id="message-large-assistant-239"]');
  await expect(row.locator('[data-remote-image]')).toHaveCount(4);
  expect(await requestCount(page)).toBe(0);
  await list.evaluate((element) =>
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true }))
  );
  await row.getByRole('button', { name: 'Load all', exact: true }).first().click();
  await expect(row.locator('[data-remote-image] img')).toHaveCount(4);
  expect(await requestCount(page)).toBe(4);
  await expect(
    page.locator('[data-msg-id="message-large-assistant-238"] [data-remote-image] img')
  ).toHaveCount(0);
});

test('on mode loads nearby images automatically and ask stops queued automatic work', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
  await installImage(page, 'message-large-assistant-239', 8);
  const row = page.locator('[data-msg-id="message-large-assistant-239"]');
  await expect(row.locator('[data-remote-image]')).toHaveCount(8);
  await waitForAnimationFrames(page, 16);
  expect(await requestCount(page)).toBe(0);
  const before = await row.boundingBox();
  await setMode(page, 'on');
  await expect.poll(() => requestCount(page)).toBeGreaterThan(0);
  await expect(row.locator('[data-remote-image] img').first()).toBeAttached();
  expect(await requestCount(page)).toBeLessThan(8);
  await setMode(page, 'ask');
  const count = await requestCount(page);
  await waitForAnimationFrames(page, 30);
  expect(await requestCount(page)).toBe(count);
  expect(await row.boundingBox().then((box) => box?.height)).toBe(before?.height);
});

test('preserves the detached anchor when changing the mode of an offscreen image row', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');
  const list = page.locator('.interactive-list');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
  await installImage(page, 'message-large-assistant-100');
  await setMode(page, 'ask');
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -10000, bubbles: true }));
    element.scrollTop = element.scrollHeight * (100 / 240);
    element.dispatchEvent(new Event('scroll'));
  });
  const imageRow = page.locator('[data-msg-id="message-large-assistant-100"]');
  await imageRow.scrollIntoViewIfNeeded();
  await expect(imageRow.getByRole('button', { name: 'Load image', exact: true })).toBeVisible();
  await waitForAnimationFrames(page, 16);
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight - 400;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(imageRow).toHaveCount(0);
  await waitForAnimationFrames(page, 16);
  const anchor = await list.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
    });
    if (!row?.dataset.msgId) throw new Error('Detached anchor missing');
    return { id: row.dataset.msgId, top: row.getBoundingClientRect().top };
  });
  const anchorRow = page.locator(`[data-msg-id="${anchor.id}"]`);
  for (const mode of ['off', 'ask'] as const) {
    await setMode(page, mode);
    await waitForAnimationFrames(page, 16);
    const top = await anchorRow.evaluate((element) => element.getBoundingClientRect().top);
    expect(Math.abs(top - anchor.top)).toBeLessThanOrEqual(2);
    await expect(imageRow).toHaveCount(0);
    expect(await requestCount(page)).toBe(0);
  }
});
