/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Browser callbacks access only the controlled E2E bridge and protocol-shaped messages. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { WebviewMessage } from '../../src/shared/protocol';

async function enableCompletion(page: Page, failFirst = false) {
  await page.goto('/e2e/harness/index.html?scenario=blank');
  await expect(page.getByRole('textbox', { name: 'Message composer' }).first()).toBeVisible();
  await page.evaluate((shouldFail) => {
    const harness = window as {
      __sendToExtension?: (message: WebviewMessage) => void;
    };
    const send = harness.__sendToExtension;
    let requests = 0;
    harness.__sendToExtension = (message) => {
      if (
        message.type === 'api/request' &&
        new URL(message.payload.path, 'http://localhost').pathname === '/varro/prompt-completion'
      ) {
        requests += 1;
        document.documentElement.dataset.completionRequests = String(requests);
        const fail = shouldFail && requests === 1;
        setTimeout(
          () =>
            window.dispatchEvent(
              new MessageEvent('message', {
                data: {
                  type: 'api/response',
                  payload: {
                    id: message.payload.id,
                    ...(fail
                      ? {
                          error:
                            'Prompt completion API returned HTTP 403: Age confirmation required.',
                        }
                      : { data: { suffix: ' with tests' } }),
                  },
                },
              })
            ),
          shouldFail ? 500 : 0
        );
        return;
      }
      send?.(message);
    };
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'config/update',
          payload: {
            promptCompletionModel: 'test/fast',
            desktopSessionPaneSide: 'right',
            defaultPermissionMode: 'default',
            chatFontSize: 13,
            chatEditorFontSize: 12,
            chatFontFamily: 'default',
          },
        },
      })
    );
  }, failFirst);
}

test('uses the model-selection warning slot, keeps failures through typing and pending retries, and clears on success', async ({
  page,
}) => {
  await enableCompletion(page, true);
  const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
  const warning = page.locator('.toolbar-main .toolbar-left .prompt-completion-warning');
  await composer.fill('Add a feature');
  await composer.press('End');
  await expect(page.locator('html')).toHaveAttribute('data-completion-requests', '1');
  await expect(warning).toHaveCount(0);
  await expect(warning).toBeVisible();
  await expect(warning).toHaveClass(/model-selection-cost-warning/);
  await expect(warning.locator('.ui-icon')).toHaveCSS('width', '16px');
  await expect(page.locator('.toolbar-meta .prompt-completion-warning')).toHaveCount(0);
  await expect(warning).toHaveAttribute('tabindex', '0');
  await warning.focus();
  await expect(page.getByRole('tooltip')).toContainText('Age confirmation required');
  await expect(warning).toBeVisible();
  await expect(composer).toHaveText('Add a feature');
  await composer.focus();
  await page.keyboard.type('.');
  await page.waitForTimeout(1_000);
  await expect(warning).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-completion-requests', '1');
  await page.keyboard.type(' Then');
  await expect(warning).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-completion-requests', '2');
  await expect(warning).toBeVisible();
  await expect(composer).toHaveAttribute('data-prompt-suggestion', ' with tests');
  await expect(warning).toHaveCount(0);
  await expect(page.locator('.prompt-completion-loading, .prompt-completion-spinner')).toHaveCount(
    0
  );
});

test('tints the text caret only during a completion request and restores it after failure', async ({
  page,
}) => {
  await enableCompletion(page, true);
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
  await composer.fill('Add a feature');
  await composer.press('End');
  const normalColor = await composer.evaluate((element) => getComputedStyle(element).caretColor);
  await page.clock.runFor(599);
  await expect(composer).not.toHaveAttribute('data-prompt-completion-pending');
  await expect(composer).toHaveCSS('caret-color', normalColor);
  await page.clock.runFor(1);
  await expect(composer).toHaveAttribute('data-prompt-completion-pending', 'true');
  const pendingColor = await composer.evaluate((element) => getComputedStyle(element).caretColor);
  expect(pendingColor).not.toBe(normalColor);
  await page.clock.runFor(500);
  await expect(composer).not.toHaveAttribute('data-prompt-completion-pending');
  await expect(composer).toHaveCSS('caret-color', normalColor);
  await expect(page.locator('.prompt-completion-warning')).toBeVisible();
  await expect(composer).toHaveText('Add a feature');
});

test('keeps the native caret pixel footprint identical when the pending color is applied', async ({
  page,
}, testInfo) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
  await composer.fill('Test');
  await composer.press('End');
  // Keep the native caret visible in both captures without changing its dimensions.
  await composer.evaluate((element) => element.style.setProperty('caret-animation', 'manual'));
  const hidden = await composer.screenshot({ caret: 'hide' });
  const normal = await composer.screenshot({
    caret: 'initial',
    path: testInfo.outputPath('caret-normal.png'),
  });
  await composer.evaluate((element) =>
    element.setAttribute('data-prompt-completion-pending', 'true')
  );
  const pending = await composer.screenshot({
    caret: 'initial',
    path: testInfo.outputPath('caret-pending.png'),
  });
  const footprints = await page.evaluate(
    async (images) => {
      const decoded = await Promise.all(
        images.map(async (encoded) => {
          const image = new Image();
          image.src = `data:image/png;base64,${encoded}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Canvas context unavailable');
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, image.width, image.height);
        })
      );
      const baseline = decoded[0]!;
      return decoded.slice(1).map((image) => {
        if (image.width !== baseline.width || image.height !== baseline.height)
          throw new Error('Composer dimensions changed');
        const pixels: number[] = [];
        for (let index = 0; index < image.data.length; index += 4) {
          if (
            [0, 1, 2, 3].some(
              (channel) => image.data[index + channel] !== baseline.data[index + channel]
            )
          )
            pixels.push(index / 4);
        }
        return pixels;
      });
    },
    [hidden.toString('base64'), normal.toString('base64'), pending.toString('base64')]
  );
  expect(footprints[0]!.length).toBeGreaterThan(0);
  expect(footprints[1]).toEqual(footprints[0]);
  await composer.evaluate((element) => element.removeAttribute('data-prompt-completion-pending'));
});

test('renders ghost text without changing the draft, accepts with Tab, and undoes in one step', async ({
  page,
}) => {
  await enableCompletion(page);
  const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
  await composer.fill('Add a feature');
  await composer.press('End');
  await expect(composer).toHaveAttribute('data-prompt-suggestion', ' with tests');
  await expect(composer).toHaveText('Add a feature');
  expect(await composer.evaluate((element) => getComputedStyle(element, '::after').content)).toBe(
    '" with tests"'
  );
  await expect(page.locator('.prompt-completion-hint')).toHaveCount(0);
  await composer.press('Tab');
  await expect(composer).toHaveText('Add a feature with tests');
  await expect(composer).toBeFocused();
  // Wait beyond the debounce to catch a new request triggered by acceptance itself.
  await page.waitForTimeout(1_000);
  await expect(composer).not.toHaveAttribute('data-prompt-suggestion');
  await expect(page.locator('html')).toHaveAttribute('data-completion-requests', '1');
  await composer.press('ControlOrMeta+z');
  await expect(composer).toHaveText('Add a feature');
  await composer.press('ControlOrMeta+Shift+z');
  await expect(composer).toHaveText('Add a feature with tests');
});

test('clears completion warnings when the input is emptied', async ({ page }) => {
  await enableCompletion(page, true);
  const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
  const warning = page.locator('.prompt-completion-warning');
  await composer.fill('Add a feature');
  await composer.press('End');
  await expect(warning).toBeVisible();
  await composer.fill('');
  await expect(warning).toHaveCount(0);
  await page.waitForTimeout(1_000);
  await expect(warning).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-completion-requests', '1');
});

test('clears completion warnings when the prompt is sent', async ({ page }) => {
  await enableCompletion(page, true);
  const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
  const warning = page.locator('.prompt-completion-warning');
  await composer.fill('Add a feature');
  await composer.press('End');
  await expect(warning).toBeVisible();
  await composer.press('Enter');
  await expect(page.locator('.chat-turn-assistant').last()).toContainText(
    'Mock assistant response for: Add a feature'
  );
  await expect(composer).toHaveText('');
  await expect(warning).toHaveCount(0);
});

test('waits for more typing after Tab acceptance and suppresses suggestions after a period', async ({
  page,
}) => {
  await enableCompletion(page);
  const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
  await composer.fill('Add a feature');
  await composer.press('End');
  await expect(composer).toHaveAttribute('data-prompt-suggestion', ' with tests');
  await composer.press('Tab');
  await expect(composer).toHaveText('Add a feature with tests');
  await composer.press('ArrowLeft');
  await composer.press('End');
  await page.waitForTimeout(1_000);
  await expect(composer).not.toHaveAttribute('data-prompt-suggestion');
  await expect(page.locator('html')).toHaveAttribute('data-completion-requests', '1');
  await page.keyboard.type(' for users');
  await expect(composer).toHaveAttribute('data-prompt-suggestion', ' with tests');
  await expect(page.locator('html')).toHaveAttribute('data-completion-requests', '2');
  await page.keyboard.type('. ');
  await page.waitForTimeout(1_000);
  await expect(composer).not.toHaveAttribute('data-prompt-suggestion');
  await expect(page.locator('html')).toHaveAttribute('data-completion-requests', '2');
  await page.keyboard.type('Then');
  await expect(composer).toHaveAttribute('data-prompt-suggestion', ' with tests');
  await expect(page.locator('html')).toHaveAttribute('data-completion-requests', '3');
});

test('dismisses with Escape and lets typing replace the suggestion without focus loss', async ({
  page,
}) => {
  await enableCompletion(page);
  const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
  await composer.fill('Add a feature');
  await composer.press('End');
  await expect(composer).toHaveAttribute('data-prompt-suggestion', ' with tests');
  await composer.press('Escape');
  await expect(composer).not.toHaveAttribute('data-prompt-suggestion');
  await expect(composer).toHaveText('Add a feature');
  await page.keyboard.type(' for users');
  await expect(composer).toHaveText('Add a feature for users');
  await expect(composer).toHaveAttribute('data-prompt-suggestion', ' with tests');
  await page.keyboard.type(' today');
  await expect(composer).toHaveText('Add a feature for users today');
  await expect(composer).not.toHaveAttribute('data-prompt-suggestion');
  await expect(composer).toBeFocused();
});

test('Enter sends only typed text and a selection or middle caret hides ghost text', async ({
  page,
}) => {
  await enableCompletion(page);
  const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
  await composer.fill('Add a feature');
  await composer.press('End');
  await expect(composer).toHaveAttribute('data-prompt-suggestion', ' with tests');
  await composer.press('ArrowLeft');
  await expect(composer).not.toHaveAttribute('data-prompt-suggestion');
  await composer.press('End');
  await expect(composer).toHaveAttribute('data-prompt-suggestion', ' with tests');
  await composer.press('ControlOrMeta+a');
  await expect(composer).not.toHaveAttribute('data-prompt-suggestion');
  await composer.press('End');
  await expect(composer).toHaveAttribute('data-prompt-suggestion', ' with tests');
  await composer.press('Enter');
  await expect(page.locator('.chat-turn-assistant').last()).toContainText(
    'Mock assistant response for: Add a feature'
  );
  await expect(page.locator('.chat-turn-assistant').last()).not.toContainText('with tests');
});
