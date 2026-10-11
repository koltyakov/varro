import { expect, test } from '@playwright/test';
import type { MessageEntry, Session } from '../../src/webview/types';

test('keeps inline edit controls clear of the preceding sticky prompt', async ({ page }) => {
  await page.setViewportSize({ width: 486, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');
  const list = page.locator('.interactive-list');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
  await list.hover();
  await page.mouse.wheel(0, -1500);
  const sticky = page.locator('[data-sticky-msg-id]');
  await expect(sticky).toBeVisible();
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
  await page.addInitScript(
    (fixture) => {
      // SAFETY: The isolated playback harness reads this fixture before mounting.
      (window as typeof window & { varroPlaybackCapture: typeof fixture }).varroPlaybackCapture =
        fixture;
    },
    { session, initialMessages: [message] }
  );
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
    await page.addInitScript(
      (fixture) => {
        // SAFETY: The isolated playback harness reads this fixture before mounting.
        (window as typeof window & { varroPlaybackCapture: typeof fixture }).varroPlaybackCapture =
          fixture;
      },
      { session, initialMessages: [message] }
    );
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

    await page.evaluate((sessionID) => {
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'session.status',
            properties: { sessionID, status: { type: 'idle' } },
          },
        },
        '*'
      );
    }, session.id);
    await expect(card).toHaveClass(/user-message-card-editable/);
    await expect(bubble).not.toHaveCSS('border-color', border);
    await bubble.click();
    await expect(page.locator('.inline-edit-composer-slot')).toBeVisible();
    await expect(card).toHaveCount(0);
  });
}
