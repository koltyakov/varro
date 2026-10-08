import { expect, test } from '@playwright/test';
import type { MessageEntry, Session } from '../../src/webview/types';

for (const separator of ['\n', ' ']) {
  test(`hides vision routing joined with ${JSON.stringify(separator)} while keeping the image and edit draft`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 380, height: 800 });
    const session: Session = {
      id: 'session-vision-routing',
      projectID: 'test',
      directory: '/workspace',
      title: 'Identifying image contents',
      version: '1',
      time: { created: 1, updated: 1 },
    };
    const prompt = "What's on the image?";
    const imagePath = '/var/folders/90/varro-drops/drop-1/Image_1';
    const message: MessageEntry = {
      info: {
        id: 'prompt-vision',
        sessionID: session.id,
        role: 'user',
        time: { created: 1 },
        agent: 'build',
        model: { providerID: 'z-ai', modelID: 'glm-5.1' },
      },
      parts: [
        {
          id: 'prompt-text',
          sessionID: session.id,
          messageID: 'prompt-vision',
          type: 'text',
          text: `${prompt}${separator}[Image for @vision: ${imagePath}]\nCall the vision subagent to inspect this image before responding. Include {file:${imagePath}} in its task prompt.`,
        },
        {
          id: 'prompt-image',
          sessionID: session.id,
          messageID: 'prompt-vision',
          type: 'file',
          mime: 'image/png',
          filename: 'Image 1',
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
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

    const card = page.locator('[data-msg-id="prompt-vision"] .user-message-card');
    await expect(card.locator('.user-message-text')).toHaveText(prompt);
    await expect(card.locator('.user-message-image-tile')).toHaveCount(1);
    await expect(card).not.toContainText('Call the vision subagent');
    await expect(card).not.toContainText(imagePath);
    await expect(card.locator('.agent-chip')).toHaveCount(0);
    await card.locator('.user-message-image-text-bubble').click();
    await expect(page.locator('.composer-edit-banner-cancel')).toBeVisible();
    await expect(page.locator('.inline-edit-composer-slot .rich-composer')).toHaveText(prompt);
    await expect(page.locator('.inline-edit-composer-slot .chat-attachment-chip')).toContainText(
      'Image 1'
    );
  });
}
