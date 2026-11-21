import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { UserMessage } from '../../src/shared/opencode-types';
import { waitForHarnessStartup } from './helpers';

async function mountAnnotations(page: Page, variant: 'inline' | 'standalone' | 'with-text') {
  await page.goto('/e2e/harness/index.html?scenario=todo-queue');
  await waitForHarnessStartup(page);
  await page.evaluate((messageVariant) => {
    // SAFETY: Synthetic events affect only the isolated E2E harness.
    const harness = (
      window as Window & { __varroE2E?: { replayServerEvent(event: ServerEvent): void } }
    ).__varroE2E;
    if (!harness) throw new Error('Missing E2E harness');
    const info: UserMessage = {
      id: 'annotation-layout-user',
      sessionID: 'session-todo-queue',
      role: 'user',
      agent: 'build',
      model: { providerID: 'openai', modelID: 'test-model' },
      time: { created: Date.now() },
    };
    harness.replayServerEvent({ type: 'message.updated', properties: { info } });
    if (messageVariant !== 'standalone') {
      harness.replayServerEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'annotation-layout-text',
            sessionID: info.sessionID,
            messageID: info.id,
            type: 'text',
            text: `${messageVariant === 'with-text' ? 'Please review ' : ''}@annotation-12345678.txt @annotation-87654321.txt`,
          },
        },
      });
    }
    for (const [index, filename] of [
      'annotation-12345678.txt',
      'annotation-87654321.txt',
    ].entries()) {
      harness.replayServerEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: `annotation-layout-file-${index}`,
            sessionID: info.sessionID,
            messageID: info.id,
            type: 'file',
            mime: 'text/plain',
            filename,
            url: `varro-content:/part/annotation-layout-file-${index}`,
            annotation: {
              selectedText: 'Selected passage',
              note:
                index === 0 ? 'Проверь фронт, сейчас такое ограничение мешает работе' : 'Test 234',
            },
          },
        },
      });
    }
  }, variant);
}

for (const width of [360, 1042]) {
  for (const variant of ['inline', 'standalone', 'with-text'] as const) {
    test(`truncates and aligns ${variant} annotations at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await mountAnnotations(page, variant);
      const card = page.locator('[data-msg-id="annotation-layout-user"] .user-message-card');
      const chips = card.locator(
        '.inline-chip, .message-attachment-visible .message-attachment-chip'
      );
      const overflows = variant === 'standalone' && width === 360;
      await expect(chips).toHaveCount(overflows ? 1 : 2);
      const label = chips.first().locator('.chip-label');
      await expect(label).toHaveCSS('text-overflow', 'ellipsis');
      expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        true
      );
      const boxes = await chips.evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          const labelBox = element.querySelector('.chip-label')!.getBoundingClientRect();
          return {
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
            labelRight: labelBox.right,
          };
        })
      );
      for (const box of boxes) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(width);
        expect(box.labelRight).toBeLessThanOrEqual(box.right);
      }
      const first = boxes[0]!;
      const last = boxes.at(-1)!;
      if (boxes.length > 1) {
        expect(last.top >= first.bottom || last.left >= first.right).toBe(true);
      }
      if (variant !== 'with-text') {
        const cardBox = await card.boundingBox();
        const right = overflows
          ? await card
              .locator('.message-attachment-overflow-trigger')
              .evaluate((element) => element.getBoundingClientRect().right)
          : last.right;
        expect(Math.abs(right - (cardBox!.x + cardBox!.width))).toBeLessThanOrEqual(2);
      } else {
        await expect(card.locator('.user-message-text')).toHaveCSS('text-align', 'start');
      }
      await chips.first().hover();
      await expect(page.getByRole('tooltip').locator('.chat-annotation-tooltip-note')).toHaveText(
        'Проверь фронт, сейчас такое ограничение мешает работе'
      );
    });
  }
}

for (const resizeTarget of ['viewport', 'container'] as const) {
  for (const initialWidth of [360, 1042]) {
    test(`recalculates standalone annotation capacity after resizing ${resizeTarget} from ${initialWidth}px`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({
        width: resizeTarget === 'viewport' ? initialWidth : 1042,
        height: 800,
      });
      await mountAnnotations(page, 'standalone');
      const card = page.locator('[data-msg-id="annotation-layout-user"] .user-message-card');
      const resize = async (width: number) => {
        if (resizeTarget === 'viewport') {
          await page.setViewportSize({ width, height: 800 });
        } else {
          // Resize only the fixture's parent, without a window resize or remount.
          await card.evaluate((element, nextWidth) => {
            const parent = element.closest<HTMLElement>('.chat-turn-user');
            if (!parent) throw new Error('Missing user turn');
            parent.style.width = `${nextWidth}px`;
          }, width);
        }
      };
      await resize(initialWidth);
      const rail = card.locator('.message-file-attachments');
      const chips = rail.locator('.message-attachment-visible .message-attachment-chip');
      const overflow = rail.locator('.message-attachment-overflow-trigger');
      await expect(chips).toHaveCount(initialWidth === 360 ? 1 : 2);
      const originalRail = await rail.elementHandle();
      const originalChip = await chips.first().elementHandle();

      for (const width of [360, 720, 1042, 360, 1042]) {
        await resize(width);
        await expect(chips).toHaveCount(width === 360 ? 1 : 2);
        await expect(overflow).toHaveCount(width === 360 ? 1 : 0);
        expect(await rail.evaluate((element, original) => element === original, originalRail)).toBe(
          true
        );
        expect(
          await chips.first().evaluate((element, original) => element === original, originalChip)
        ).toBe(true);
        const bounds = await rail.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return {
            left: box.left,
            right: box.right,
            chipRight: Math.max(
              ...Array.from(
                element.querySelectorAll('.message-attachment-visible .message-attachment-chip'),
                (chip) => chip.getBoundingClientRect().right
              )
            ),
          };
        });
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(bounds.chipRight).toBeLessThanOrEqual(bounds.right);
        if (width === 360) {
          await overflow.click();
          await expect(page.getByRole('dialog', { name: 'Remaining attachments' })).toBeVisible();
        } else {
          await expect(page.getByRole('dialog', { name: 'Remaining attachments' })).toHaveCount(0);
        }
      }
      expect(errors).toEqual([]);
    });
  }
}
