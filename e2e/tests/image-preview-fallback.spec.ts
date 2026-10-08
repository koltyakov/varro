import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

for (const decode of ['pending', 'failed', 'timeout'] as const) {
  test(`sends the original image when preview decoding is ${decode}`, async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=blank');
    await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
    await page.getByText('GPT-4.1', { exact: true }).click();
    await expect(page.getByLabel('OpenAI / GPT-4.1')).toBeVisible();
    if (decode === 'timeout') await page.clock.install();

    const originalUrl = await page.evaluate((outcome) => {
      // Only programmatic preview decoders are replaced. DOM image rendering stays native.
      Object.defineProperty(window, 'Image', {
        configurable: true,
        value: class extends EventTarget {
          set src(_value: string) {
            if (outcome === 'failed') queueMicrotask(() => this.dispatchEvent(new Event('error')));
          }
        },
      });
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const url = canvas.toDataURL('image/png');
      const size = atob(url.split(',')[1]!).length;
      window.postMessage(
        {
          type: 'composer/images-sync',
          payload: {
            images: [{ id: 'fallback-image', filename: 'Image 1', mime: 'image/png', url, size }],
          },
        },
        '*'
      );
      return url;
    }, decode);

    const chip = page.locator('.chat-attachment-chip').filter({ hasText: 'Image 1' });
    await expect(chip).toBeVisible();
    await expect(page.getByLabel('Send (Enter)', { exact: true })).toBeEnabled();
    if (decode === 'timeout') await page.clock.fastForward(10_001);
    if (decode !== 'pending') await expect(chip).toHaveAttribute('title', /Preview unavailable/);
    await expect(chip).not.toHaveClass(/disabled/);

    const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
    await composer.fill('Describe [Image 1]');
    await page.getByLabel('Send (Enter)', { exact: true }).click();
    await expect
      .poll(() =>
        getE2EState(page, () => {
          // SAFETY: The isolated harness records prompt request bodies with this controlled shape.
          const harness = (
            window as Window & {
              __varroE2E?: {
                requests: Array<{
                  method: string;
                  path: string;
                  body?: { parts?: Array<{ type: string; mime?: string; url?: string }> };
                }>;
              };
            }
          ).__varroE2E;
          return harness?.requests
            .find((request) => request.method === 'POST' && request.path.includes('prompt_async'))
            ?.body?.parts?.find((part) => part.type === 'file' && part.mime === 'image/png')?.url;
        })
      )
      .toBe(originalUrl);
    await expect(chip).toHaveCount(0);
  });
}
