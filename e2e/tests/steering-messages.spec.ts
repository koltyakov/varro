import { expect, test } from '@playwright/test';
import type { AssistantMessage, MessageEntry, UserMessage } from '../../src/webview/types';
import { waitForAnimationFrames } from './helpers';

for (const theme of ['dark', 'light']) {
  test(`resume steering uses a compact themed control (${theme})`, async ({ page }) => {
    const sessionID = 'pending-steering';
    const message: MessageEntry<UserMessage> = {
      info: {
        id: 'pending-steer',
        sessionID,
        role: 'user',
        pendingDelivery: 'steer',
        time: { created: 1 },
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-5' },
      },
      parts: [
        {
          id: 'pending-steer-text',
          messageID: 'pending-steer',
          sessionID,
          type: 'text',
          text: 'Change direction',
        },
      ],
    };
    await page.addInitScript(
      (fixture) => {
        // SAFETY: The isolated E2E harness consumes this fixture before mounting.
        (window as typeof window & { varroPlaybackCapture: typeof fixture }).varroPlaybackCapture =
          fixture;
      },
      {
        session: {
          id: sessionID,
          projectID: 'test',
          directory: '/workspace',
          title: 'Pending steering',
          version: '1',
          time: { created: 1, updated: 1 },
        },
        initialMessages: [message],
      }
    );
    await page.goto(`/e2e/harness/index.html?scenario=session-playback&theme=${theme}`);
    const resume = page.getByRole('button', { name: 'Resume steering', exact: true });
    await expect(resume).toBeVisible();
    await expect(page.getByRole('list', { name: 'Steered messages' })).toHaveText(
      'Change direction'
    );
    for (const width of [1100, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await waitForAnimationFrames(page, 8);
      await expect(resume).toHaveCSS('display', 'inline-flex');
      await expect(resume).toHaveCSS('height', '24px');
      await expect(resume).toHaveCSS('border-top-width', '0px');
      await expect(resume).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const geometry = await resume.evaluate((element) => {
        const button = element.getBoundingClientRect();
        const container = element.parentElement!.getBoundingClientRect();
        return {
          fits: button.left >= container.left && button.right <= container.right,
          labelFits: element.scrollWidth <= element.clientWidth,
        };
      });
      expect(geometry).toEqual({ fits: true, labelFits: true });
    }
    await page.keyboard.press('Tab');
    await resume.focus();
    await expect(resume).toBeFocused();
    expect(await resume.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
  });

  for (const withImage of [false, true]) {
    test(`steering is gray and read-only, queued follow-ups stay editable (${theme}, image=${withImage})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1100, height: 1000 });
      const sessionID = 'steering-colors';
      const prompt = (id: string, created: number): MessageEntry<UserMessage> => ({
        info: {
          id,
          sessionID,
          role: 'user',
          time: { created },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-5' },
        },
        parts: [
          {
            id: `${id}-text`,
            messageID: id,
            sessionID,
            type: 'text',
            text: 'Check the duration and scrolling.',
          },
        ],
      });
      const assistant: AssistantMessage = {
        id: 'activity',
        sessionID,
        role: 'assistant',
        parentID: 'prompt',
        time: { created: 2, completed: 3 },
        finish: 'tool_calls',
        providerID: 'openai',
        modelID: 'gpt-5',
        mode: 'build',
        agent: 'build',
        path: { cwd: '/workspace', root: '/workspace' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      };
      const steer = prompt('steer', 5);
      if (withImage)
        steer.parts.push({
          id: 'steer-image',
          messageID: 'steer',
          sessionID,
          type: 'file',
          mime: 'image/svg+xml',
          url: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNjAiIGhlaWdodD0iODAiPjxyZWN0IHdpZHRoPSIxNjAiIGhlaWdodD0iODAiIGZpbGw9IiM4ODgiLz48L3N2Zz4=',
        });
      const messages: MessageEntry[] = [
        prompt('prompt', 1),
        {
          info: assistant,
          parts: [
            {
              id: 'activity-text',
              messageID: 'activity',
              sessionID,
              type: 'text',
              text: 'Checking the timer.',
            },
          ],
        },
        prompt('steer-first', 4),
        steer,
        {
          info: {
            ...assistant,
            id: 'answer',
            parentID: 'steer',
            finish: 'stop',
            time: { created: 6, completed: 7 },
          },
          parts: [
            {
              id: 'answer-text',
              messageID: 'answer',
              sessionID,
              type: 'text',
              text: Array.from(
                { length: 35 },
                (_, index) => `Verified timer case ${index + 1}.`
              ).join('\n\n'),
            },
          ],
        },
        prompt('queued-follow-up', 8),
      ];
      await page.addInitScript(
        (fixture) => {
          // SAFETY: The isolated E2E harness consumes this fixture before mounting.
          (
            window as typeof window & { varroPlaybackCapture: typeof fixture }
          ).varroPlaybackCapture = fixture;
        },
        {
          session: {
            id: sessionID,
            projectID: 'test',
            directory: '/workspace',
            title: 'Steering colors',
            version: '1',
            time: { created: 1, updated: 7 },
          },
          initialMessages: messages,
        }
      );
      await page.goto(`/e2e/harness/index.html?scenario=session-playback&theme=${theme}`);
      const list = page.locator('.interactive-list');
      const ordinary = page.locator('[data-msg-id="prompt"] .user-message-card');
      const steering = page.locator('[data-msg-id="steer"] .user-message-card');
      await expect(steering).toHaveClass(/user-message-steering/);
      await list.evaluate((element) => {
        element.scrollTop = 0;
      });
      await waitForAnimationFrames(page, 30);
      const navigation = page.getByRole('navigation', { name: 'Conversation turns' });
      await expect(navigation).toBeVisible();
      await expect(navigation.locator('.turn-navigation-marker')).toHaveCount(2);
      await expect(navigation.locator('.turn-navigation-marker').first()).toHaveAttribute(
        'aria-label',
        'Go to turn 1: Check the duration and scrolling.'
      );
      await page.keyboard.down('Alt');
      await expect(ordinary.locator('.prompt-number-badge')).toHaveText('1');
      await expect(page.locator('[data-msg-id="steer-first"] .prompt-number-badge')).toHaveText(
        '1.1'
      );
      await expect(steering.locator('.prompt-number-badge')).toHaveText('1.2');
      await expect(
        page.locator('[data-msg-id="queued-follow-up"] .prompt-number-badge')
      ).toHaveText('2');
      await page.keyboard.up('Alt');
      await expect(steering.locator('.prompt-number-badge')).toHaveCount(0);
      const bubble = withImage ? steering.locator('.user-message-image-text-bubble') : steering;
      const ordinaryColor = await ordinary.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      );
      const steeringColor = await bubble.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      );
      expect(steeringColor).not.toBe(ordinaryColor);
      expect(steeringColor).not.toBe('rgba(0, 0, 0, 0)');
      await expect(steering).not.toHaveClass(/user-message-card-editable/);
      await bubble.click();
      await expect(page.locator('.inline-edit-composer-slot')).toHaveCount(0);

      // A color-only classification must not change bubble geometry.
      const geometry = await steering.evaluate((element) => {
        const before = element.getBoundingClientRect();
        element.classList.remove('user-message-steering');
        const after = element.getBoundingClientRect();
        element.classList.add('user-message-steering');
        return { width: after.width - before.width, height: after.height - before.height };
      });
      expect(geometry).toEqual({ width: 0, height: 0 });

      await list.evaluate((element) => {
        const card = element.querySelector('[data-msg-id="steer"] .user-message-card')!;
        element.scrollTop +=
          card.getBoundingClientRect().bottom - element.getBoundingClientRect().top + 12;
      });
      const sticky = page.locator('[data-sticky-msg-id="prompt"] .latest-user-message-sticky');
      await expect(sticky).not.toHaveClass(/user-message-steering/);
      await expect(sticky).toBeVisible();
      await expect(page.locator('[data-sticky-msg-id="steer-first"]')).toHaveCount(0);
      await expect(page.locator('[data-sticky-msg-id="steer"]')).toHaveCount(0);
      await page.keyboard.down('Alt');
      await expect(page.locator('[data-sticky-msg-id="prompt"] .prompt-number-badge')).toHaveText(
        '1'
      );
      await page.keyboard.up('Alt');
      expect(await sticky.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
        ordinaryColor
      );

      const queued = page.locator('[data-msg-id="queued-follow-up"] .user-message-card');
      await expect(queued).not.toHaveClass(/user-message-steering/);
      await expect(queued).toHaveClass(/user-message-card-editable/);
      await navigation.locator('.turn-navigation-marker').first().click();
      await expect(ordinary).toBeInViewport();
    });
  }
}
