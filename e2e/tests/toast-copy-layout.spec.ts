import { expect, test } from '@playwright/test';

for (const width of [280, 320]) {
  for (const retry of [false, true]) {
    test(`compact toast copy fits at ${width}px with retry=${retry}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/e2e/harness/index.html?scenario=blank');
      await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();

      const messages = [
        'Permission automation ownership changed',
        'Failed to respond to permission',
        'Failed to update permissions',
        'Wait for the permission mode update to finish before forking',
        'Select a model before compacting the session',
        'This conversation is unavailable on the connected OpenCode server.',
        'Init is only available for blank sessions',
        'Problems context is disabled in settings',
        'Problems already added to context',
        'PDFs must be valid and total 20 MiB or less',
        'PDFs must total 20 MiB or less',
        'Table attachment timed out. Try selecting it again.',
        'Wait for pending image pastes to finish',
        'Image attached; use a vision-capable model or vision subagent to send it',
        'This paste remains inline. Text attachments support 64 KB per paste and 256 KB per draft.',
      ];
      for (const message of messages) {
        await page.evaluate(
          async ({ message: nextMessage, retry: withRetry }) => {
            const path = '/src/webview/lib/state.ts';
            // SAFETY: Vite serves this state module from the isolated E2E harness.
            const { setError, setErrorRetry } = (await import(path)) as {
              setError(value: string): void;
              setErrorRetry(action: (() => void) | null): void;
            };
            setError(nextMessage);
            setErrorRetry(withRetry ? () => {} : null);
          },
          { message, retry }
        );

        const text = page.locator('.session-action-feedback-message');
        await expect(text).toHaveAttribute('title', message);
        const geometry = await text.evaluate((element) => ({
          client: element.clientWidth,
          scroll: element.scrollWidth,
        }));
        expect.soft(geometry.scroll, message).toBeLessThanOrEqual(geometry.client);
      }
    });
  }
}
