import { expect, test } from '@playwright/test';
import type { WebviewMessage } from '../../src/shared/protocol';
import type { MessageEntry, Session } from '../../src/webview/types';
import { installPlaybackCapture, postWebviewMessage } from './helpers';

for (const width of [480, 1280]) {
  test(`reserves the empty inline editor size while reconciling an edit at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const session: Session = {
      id: 'session-edit-loading',
      projectID: 'test',
      directory: '/workspace',
      title: 'Edit loading',
      version: '1',
      time: { created: 1, updated: 1 },
    };
    const initialMessages: MessageEntry[] = Array.from({ length: 25 }, (_, index) => ({
      info: {
        id: `prompt-${index}`,
        sessionID: session.id,
        role: 'user',
        time: { created: index + 1 },
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-4.1' },
      },
      parts: [
        {
          id: `text-${index}`,
          sessionID: session.id,
          messageID: `prompt-${index}`,
          type: 'text',
          text: `Follow-up prompt ${index}`,
        },
      ],
    }));
    await installPlaybackCapture(page, { session, initialMessages });
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    await page.evaluate(() => {
      // SAFETY: These hooks belong to the isolated E2E transport, not a production session.
      const harness = window as {
        __sendToExtension?: (message: WebviewMessage) => void | Promise<void>;
        releaseEditDeletion?: () => void;
      };
      const send = harness.__sendToExtension;
      const gate = new Promise<void>((resolve) => {
        harness.releaseEditDeletion = resolve;
      });
      harness.__sendToExtension = async (message) => {
        if (message.type === 'api/request' && message.payload.method === 'DELETE') await gate;
        await send?.(message);
      };
    });
    await page.locator('[data-msg-id="prompt-0"] .user-message-card').click();
    const inline = page.locator('.inline-edit-composer-slot');
    const editor = inline.locator('.rich-composer');
    await editor.fill('');
    const emptyBounds = await inline.locator('.interactive-input-part').boundingBox();
    const bannerBounds = await inline.locator('.composer-edit-banner').boundingBox();
    expect(emptyBounds).not.toBeNull();
    expect(bannerBounds).not.toBeNull();
    await editor.fill('An edited prompt\nwith several lines\nthat collapse after sending.');
    await editor.press('Enter');

    const loading = inline.getByRole('status', { name: 'Updating conversation' });
    await expect(loading).toBeVisible();
    const title = loading.getByText('Updating conversation', { exact: true });
    await expect(title).toBeVisible();
    await expect(loading.locator('.chat-messages-loading-dot')).toHaveCount(3);
    await expect(inline.locator('.composer-edit-banner')).toBeHidden();
    await expect(editor).toBeHidden();
    const bounds = await loading.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeCloseTo(emptyBounds!.width, 0);
    // The inline input has 2px top padding outside the banner and input block.
    expect(bounds!.height).toBeCloseTo(emptyBounds!.height - 2, 0);
    expect(bounds!.height).toBeGreaterThan(bannerBounds!.height);
    const titleBounds = await title.boundingBox();
    expect(titleBounds).not.toBeNull();
    expect(titleBounds!.x - bounds!.x).toBeCloseTo(13, 0);
    expect(titleBounds!.y - bounds!.y).toBeCloseTo(9, 0);
    const centered = await loading.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const dots = [...element.querySelectorAll('.chat-messages-loading-dot')].map((dot) =>
        dot.getBoundingClientRect()
      );
      return {
        x: (dots[0]!.left + dots.at(-1)!.right) / 2 - (box.left + box.width / 2),
        y: dots[0]!.top + dots[0]!.height / 2 - (box.top + box.height / 2),
      };
    });
    expect(Math.abs(centered.x)).toBeLessThan(1);
    expect(Math.abs(centered.y)).toBeLessThan(1);
    await page.evaluate(() => {
      // SAFETY: Release only this test's delayed history deletion.
      (window as typeof window & { releaseEditDeletion?: () => void }).releaseEditDeletion?.();
    });
    await expect(page.locator('.composer-edit-loading')).toHaveCount(0);
    await expect(page.locator('.inline-edit-composer-slot')).toHaveCount(0);
    await expect(
      page.locator('.user-message-card').filter({ hasText: 'An edited prompt' })
    ).toBeVisible();
  });
}

test('keeps inline edit controls clear of the preceding sticky prompt', async ({ page }) => {
  await page.setViewportSize({ width: 486, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');
  const list = page.locator('.interactive-list');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
  await list.hover();
  await page.mouse.wheel(0, -1500);
  const sticky = page.locator('[data-sticky-msg-id]');
  // A fixed delta can stop with the next prompt inside the sticky collision zone, which
  // correctly hides the preview. Nudge upward until a prompt is pinned.
  await expect(async () => {
    if (!(await sticky.isVisible())) await page.mouse.wheel(0, -120);
    await expect(sticky).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
  const messageId = await sticky.getAttribute('data-sticky-msg-id');
  await sticky.click();
  const card = page.locator(`[data-msg-id="${messageId}"] .user-message-card`);
  await expect(card).toBeVisible();
  await page.waitForTimeout(500);
  const frames = page.evaluate(async () => {
    const samples: boolean[] = [];
    for (let frame = 0; frame < 45; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const cancel = document.querySelector('.composer-edit-banner-cancel');
      if (!cancel) continue;
      const rect = cancel.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      samples.push(hit === cancel || cancel.contains(hit));
    }
    return samples;
  });
  await card.click();
  const cancel = page.locator('.composer-edit-banner-cancel');
  await expect(cancel).toBeVisible();
  const samples = await frames;
  expect(samples.length).toBeGreaterThan(10);
  expect(samples.every(Boolean), JSON.stringify(samples)).toBe(true);
  await list.press('End');
  await page.waitForTimeout(200);
  const overlap = await cancel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { actionable: hit === element || element.contains(hit), hit: hit?.outerHTML };
  });
  expect(overlap.actionable, JSON.stringify(overlap)).toBe(true);
  await cancel.click();
  await expect(page.locator('.inline-edit-composer-slot')).toHaveCount(0);
});

test('keeps model and reasoning when clicking a prompt with an empty historical model', async ({
  page,
}) => {
  const session: Session = {
    id: 'session-edit-model',
    projectID: 'test',
    directory: '/workspace',
    title: 'Edit model',
    version: '1',
    time: { created: 1, updated: 1 },
  };
  const message: MessageEntry = {
    info: {
      id: 'prompt',
      sessionID: session.id,
      role: 'user',
      time: { created: 1 },
      agent: 'build',
      model: { providerID: '', modelID: '' },
    },
    parts: [
      {
        id: 'prompt-text',
        sessionID: session.id,
        messageID: 'prompt',
        type: 'text',
        text: 'Keep the selected model when editing this message.',
      },
    ],
  };
  await installPlaybackCapture(page, { session, initialMessages: [message] });
  await page.goto('/e2e/harness/index.html?scenario=session-playback');
  await page.locator('.model-picker-btn').click();
  await page.getByRole('button', { name: 'GPT-4.1', exact: true }).click();
  await page.getByLabel('Thinking level').click();
  await page.getByRole('button', { name: 'High', exact: true }).click();
  await expect(page.locator('.model-picker-btn')).toContainText('GPT-4.1');
  await expect(page.getByLabel('Thinking level')).toContainText('High');

  await page.locator('[data-msg-id="prompt"] .user-message-card').click();
  const inlineComposer = page.locator('.inline-edit-composer-slot');
  await expect(inlineComposer).toBeVisible();
  await expect(inlineComposer.locator('.model-picker-btn')).toContainText('GPT-4.1');
  await expect(inlineComposer.getByLabel('Thinking level')).toContainText('High');
  await page.locator('.composer-edit-banner-cancel').click();
  await expect(inlineComposer).toHaveCount(0);
  await expect(page.locator('.model-picker-btn')).toContainText('GPT-4.1');
  await expect(page.getByLabel('Thinking level')).toContainText('High');
});

for (const withImage of [false, true]) {
  test(`only highlights editable prompts on hover with image=${withImage}`, async ({ page }) => {
    const session: Session = {
      id: 'session-edit-hover',
      projectID: 'test',
      directory: '/workspace',
      title: 'Edit hover',
      version: '1',
      time: { created: 1, updated: 1 },
    };
    const message: MessageEntry = {
      info: {
        id: 'prompt',
        sessionID: session.id,
        role: 'user',
        time: { created: 1 },
        agent: 'build',
        model: { providerID: 'openai', modelID: 'test' },
      },
      parts: [
        {
          id: 'prompt-text',
          sessionID: session.id,
          messageID: 'prompt',
          type: 'text',
          text: 'Check the hover border.',
        },
      ],
    };
    if (withImage) {
      message.parts.push({
        id: 'prompt-image',
        sessionID: session.id,
        messageID: 'prompt',
        type: 'file',
        mime: 'image/png',
        url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      });
    }
    await installPlaybackCapture(page, { session, initialMessages: [message] });
    await page.goto('/e2e/harness/index.html?scenario=session-playback');

    const row = page.locator('[data-msg-id="prompt"]');
    const card = row.locator('.user-message-card');
    const bubble = withImage ? card.locator('.user-message-image-text-bubble') : card;
    await expect(card).toHaveClass(/user-message-card-editable/);
    const border = await bubble.evaluate((element) => getComputedStyle(element).borderColor);
    const shadow = await bubble.evaluate((element) => getComputedStyle(element).boxShadow);
    await bubble.hover();
    await expect(row).toHaveClass(/interactive-item-turn-hovered/);
    await expect(bubble).not.toHaveCSS('border-color', border);

    for (const sessionStatus of [
      { type: 'busy' } as const,
      { type: 'retry', attempt: 1, message: 'Retrying', next: Date.now() + 60_000 } as const,
    ]) {
      await page.evaluate(
        ({ sessionID, status }) => {
          window.postMessage(
            {
              type: 'server/event',
              payload: { type: 'session.status', properties: { sessionID, status } },
            },
            '*'
          );
        },
        { sessionID: session.id, status: sessionStatus }
      );
      await expect(card).not.toHaveClass(/user-message-card-editable/);
      await expect(bubble).toHaveCSS('border-color', border);
      await expect(bubble).toHaveCSS('box-shadow', shadow);
      await bubble.click();
      await expect(page.locator('.inline-edit-composer-slot')).toHaveCount(0);
    }

    await postWebviewMessage(page, {
      type: 'server/event',
      payload: {
        type: 'session.status',
        properties: { sessionID: session.id, status: { type: 'idle' } },
      },
    });
    await expect(card).toHaveClass(/user-message-card-editable/);
    await expect(bubble).not.toHaveCSS('border-color', border);
    await bubble.click();
    await expect(page.locator('.inline-edit-composer-slot')).toBeVisible();
    await expect(card).toHaveCount(0);
  });
}
