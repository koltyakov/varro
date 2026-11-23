import { expect, test } from '@playwright/test';
import { projectV2Message } from '../../src/extension/opencode-v2-projection';
import { formatSkillAttachment } from '../../src/shared/skill-reference';
import type { MessageEntry, Session } from '../../src/webview/types';
import { fixture } from '../../src/webview/test-fixtures';
import { installPlaybackCapture, waitForHarnessStartup } from './helpers';

for (const width of [360, 1100]) {
  test(`skill prompts keep their bubbles beside generated activity at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    const created = Date.now();
    const session: Session = {
      id: 'ses_skill_prompts',
      projectID: 'project-test',
      directory: '/workspace',
      title: 'Skill prompt visibility',
      version: '2',
      time: { created, updated: created },
    };
    const initialMessages: MessageEntry[] = [];
    const prompts = [
      { id: 'plain', text: 'Review this code with $[review]', visible: 'Review this code with' },
      {
        id: 'leading',
        text: '$[review] $[unslop]\nCheck the error handling',
        visible: 'Check the error handling',
      },
      {
        id: 'legacy',
        text: [
          '$[review] $[unslop]\nExplain these changes',
          formatSkillAttachment('review'),
          formatSkillAttachment('unslop'),
        ].join('\n'),
        visible: 'Explain these changes',
      },
    ];
    for (const [index, prompt] of prompts.entries()) {
      initialMessages.push(
        fixture<MessageEntry>(
          projectV2Message(
            {
              id: `msg_${prompt.id}`,
              type: 'user',
              text: prompt.text,
              skills:
                prompt.id === 'legacy'
                  ? undefined
                  : ['review', 'unslop'].map((id) => ({
                      id,
                      name: id,
                      text: 'Private expanded skill instructions',
                    })),
              time: { created: created + index * 100 },
            },
            session.id
          )
        ),
        fixture<MessageEntry>(
          projectV2Message(
            {
              id: `msg_${prompt.id}_activation`,
              type: 'skill',
              skill: 'review',
              name: 'Review',
              text: 'Private expanded skill instructions',
              time: { created: created + index * 100 + 1 },
            },
            session.id,
            session.directory,
            `msg_${prompt.id}`
          )
        )
      );
    }
    await installPlaybackCapture(page, { session, initialMessages, goal: null });
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    await waitForHarnessStartup(page);
    await expect(page.locator('.user-message-card')).toHaveCount(prompts.length);
    for (const prompt of prompts) {
      const row = page.locator(`[data-msg-id="msg_${prompt.id}"]`);
      const bubble = row.locator('.user-message-card');
      await bubble.scrollIntoViewIfNeeded();
      await expect(bubble).toBeVisible();
      await expect(bubble).toContainText(prompt.visible);
      await expect(row.getByTitle('Skill: review', { exact: true })).toHaveCount(1);
      await expect(row.getByTitle('Skill: unslop', { exact: true })).toHaveCount(1);
      const activation = page.locator(`[data-msg-id="msg_${prompt.id}_activation"]`);
      await activation.locator('.assistant-activity-summary').click();
      await expect(activation.locator('.chat-tool-invocation-part')).toBeVisible();
      await bubble.scrollIntoViewIfNeeded();
      await expect(bubble).toBeVisible();
      await expect(bubble).toContainText(prompt.visible);
    }
    await expect(page.locator('.user-message-card')).toHaveCount(prompts.length);
    await expect(
      page.getByText('Private expanded skill instructions', { exact: true })
    ).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('skill-prompt-bubbles.png') });
    await page.reload();
    await waitForHarnessStartup(page);
    await expect(page.locator('.user-message-card')).toHaveCount(prompts.length);
    for (const prompt of prompts) {
      const bubble = page.locator(`[data-msg-id="msg_${prompt.id}"] .user-message-card`);
      await bubble.scrollIntoViewIfNeeded();
      await expect(bubble).toBeVisible();
      await expect(bubble).toContainText(prompt.visible);
    }
  });
}
