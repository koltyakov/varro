import { expect, test } from '@playwright/test';
import type { DictationRecordingState, WebviewMessage } from '../../src/shared/protocol';
import { waitForHarnessStartup } from './helpers';

interface DictationHarnessWindow extends Window {
  dictationActions?: string[];
  dictationState?: DictationRecordingState;
  __varroE2E?: { requests: Array<{ path: string }> };
}

for (const provider of ['handy', 'hex'] as const) {
  for (const width of [360, 900]) {
    test(`${provider} button precedes Attach and preserves composer focus at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/e2e/harness/index.html?scenario=blank');
      await waitForHarnessStartup(page);
      const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
      await expect(composer).toBeVisible();
      await expect(page.locator('.toolbar-dictation-button')).toHaveCount(0);

      await page.evaluate((chosenProvider) => {
        // SAFETY: The isolated E2E harness installs the typed bridge and request ledger.
        const harness = window as DictationHarnessWindow;
        const originalSend = harness.__sendToExtension;
        harness.dictationActions = [];
        harness.dictationState = 'idle';
        harness.__sendToExtension = (message) => {
          // SAFETY: The composer sends protocol messages through this isolated harness bridge.
          const request = message as WebviewMessage;
          if (request.type !== 'dictation/request') return originalSend?.(message);
          harness.dictationActions?.push(request.payload.action);
          if (request.payload.action === 'start') harness.dictationState = 'recording';
          else if (request.payload.action === 'stop') harness.dictationState = 'processing';
          else if (request.payload.action !== 'status') harness.dictationState = 'idle';
          window.dispatchEvent(
            new MessageEvent('message', {
              data: {
                type: 'dictation/result',
                payload: {
                  requestId: request.payload.requestId,
                  available: true,
                  running: true,
                  provider: chosenProvider,
                  state: harness.dictationState,
                },
              },
            })
          );
        };
        window.dispatchEvent(new Event('focus'));
      }, provider);

      const mic = page.locator('.toolbar-dictation-button');
      const attach = page.getByRole('button', { name: 'Attach files' });
      await expect(mic).toBeEnabled();
      await expect(mic).toHaveAttribute(
        'aria-label',
        `Start ${provider === 'hex' ? 'Hex' : 'Handy'} dictation`
      );
      const micBox = await mic.boundingBox();
      const attachBox = await attach.boundingBox();
      expect(micBox).not.toBeNull();
      expect(attachBox).not.toBeNull();
      expect(micBox!.x + micBox!.width).toBeLessThanOrEqual(attachBox!.x);
      expect(Math.abs(micBox!.y - attachBox!.y)).toBeLessThan(1);

      const send = page.getByRole('button', { name: 'Send (Enter)', exact: true });
      const sendBox = await send.boundingBox();
      expect(sendBox).not.toBeNull();
      expect(attachBox!.x - micBox!.x - micBox!.width).toBeCloseTo(3, 1);
      expect(sendBox!.x - attachBox!.x - attachBox!.width).toBeCloseTo(9, 1);
      for (const button of [mic, attach, send]) {
        const buttonBox = await button.boundingBox();
        const iconBox = await button.locator('.ui-icon, svg').boundingBox();
        expect(buttonBox).not.toBeNull();
        expect(iconBox).not.toBeNull();
        expect(iconBox!.width).toBe(15);
        expect(iconBox!.height).toBe(15);
        const opticalOffset = button === mic ? -0.5 : 0;
        expect(iconBox!.x + iconBox!.width / 2).toBeCloseTo(
          buttonBox!.x + buttonBox!.width / 2 + opticalOffset,
          2
        );
        expect(iconBox!.y + iconBox!.height / 2).toBeCloseTo(
          buttonBox!.y + buttonBox!.height / 2,
          2
        );
      }

      const idleCaretColor = await composer.evaluate(
        (element) => getComputedStyle(element).caretColor
      );
      const dictationStatus = page.locator('.composer-dictation-status');
      await expect(dictationStatus).toHaveCount(0);
      await page.evaluate(() => {
        // A theme may map chart-orange to red. It must not recolor the caret.
        document.documentElement.style.setProperty('--vscode-charts-orange', '#f14c4c');
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'files/dropped',
              payload: [
                { path: '/workspace/composer.css', relativePath: 'composer.css', type: 'file' },
              ],
            },
          })
        );
      });
      const attachment = page.locator('.chat-attachment-chip').filter({ hasText: 'composer.css' });
      await expect(attachment).toBeVisible();
      await composer.fill('Existing draft. ');
      await composer.press('ArrowLeft');
      const cursorOffset = await composer.evaluate(() => window.getSelection()?.anchorOffset);
      const frame = page.locator('.chat-input-container').first();
      await expect(composer).toBeFocused();
      // Focus animates the frame border. Capture its settled color, not an
      // intermediate oklab value that cannot be restored after dictation ends.
      await frame.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      const idleFrameBox = await frame.boundingBox();
      const idleComposerBox = await composer.boundingBox();
      const idleAttachmentBox = await attachment.boundingBox();
      const idleBorderColor = await frame.evaluate(
        (element) => getComputedStyle(element).borderTopColor
      );
      const idleBackground = await frame.evaluate(
        (element) => getComputedStyle(element).backgroundImage
      );
      await mic.click();
      await expect(mic).toHaveAttribute('aria-pressed', 'true');
      await expect(dictationStatus.locator('.sr-only')).toHaveText(
        'Dictation on. Click mic when done.'
      );
      await expect(dictationStatus.locator('[aria-hidden="true"]')).toHaveText('Rec');
      await expect(dictationStatus).toHaveAttribute('role', 'status');
      await expect(dictationStatus.locator('.sr-only')).toHaveCSS('position', 'absolute');
      await expect(dictationStatus).toHaveCSS('position', 'absolute');
      await expect(dictationStatus).toHaveCSS('pointer-events', 'none');
      expect(await frame.boundingBox()).toEqual(idleFrameBox);
      expect(await composer.boundingBox()).toEqual(idleComposerBox);
      expect(await attachment.boundingBox()).toEqual(idleAttachmentBox);
      const indicatorBox = await dictationStatus.boundingBox();
      expect(indicatorBox).not.toBeNull();
      const topInset = indicatorBox!.y - idleFrameBox!.y;
      const rightInset =
        idleFrameBox!.x + idleFrameBox!.width - indicatorBox!.x - indicatorBox!.width;
      expect(topInset).toBeCloseTo(rightInset, 2);
      await expect(dictationStatus).toHaveCSS('top', '6px');
      await expect(dictationStatus).toHaveCSS('right', '6px');
      await expect(composer).toHaveAttribute('aria-placeholder', 'Your words will appear here');
      const dictationColor = 'rgb(255, 165, 0)';
      const recordingColor = await dictationStatus.evaluate(
        (element) => getComputedStyle(element).color
      );
      expect(recordingColor).not.toBe(dictationColor);
      await expect(composer).toHaveCSS('caret-color', dictationColor);
      await expect(frame).toHaveCSS('border-top-color', 'rgb(241, 76, 76)');
      await expect(frame).not.toHaveCSS('background-image', idleBackground);
      expect(dictationColor).not.toBe(idleCaretColor);
      await expect(composer).toBeFocused();
      await expect(composer).toHaveText('Existing draft.');
      expect(await composer.evaluate(() => window.getSelection()?.anchorOffset)).toBe(cursorOffset);
      await mic.click();
      await expect(mic).toHaveAttribute('aria-pressed', 'false');
      await expect(mic).toBeEnabled();
      await expect(dictationStatus).toHaveCount(0);
      await expect(composer).toHaveCSS('caret-color', idleCaretColor);
      await expect(frame).toHaveCSS('border-top-color', idleBorderColor);
      await expect(frame).toHaveCSS('background-image', idleBackground);
      await expect(composer).toBeFocused();
      await page.keyboard.insertText('Dictated words');
      await expect(composer).toContainText('Dictated words');

      await mic.click();
      await mic.click({ button: 'right' });
      await expect(mic).toHaveAttribute('aria-pressed', 'false');
      await expect(dictationStatus).toHaveCount(0);
      await expect(composer).toHaveCSS('caret-color', idleCaretColor);
      const result = await page.evaluate(() => {
        // SAFETY: These ledgers belong to the isolated test page, not a live session.
        const harness = window as DictationHarnessWindow;
        return {
          actions: harness.dictationActions,
          sends: harness.__varroE2E?.requests.filter((request) =>
            request.path.includes('/prompt_async')
          ).length,
        };
      });
      expect(result.actions).toEqual(['status', 'start', 'stop', 'start', 'cancel']);
      expect(result.sends).toBe(0);
    });
  }
}
