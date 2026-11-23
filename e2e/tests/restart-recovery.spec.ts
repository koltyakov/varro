import { expect, test } from '@playwright/test';
import type { MessageEntry, UserMessage } from '../../src/webview/types';
import { installPlaybackCapture } from './helpers';

for (const width of [400, 900]) {
  test(`restored lost-shell notice says cancelled, not finished, at ${width}px`, async ({
    page,
  }) => {
    const sessionID = 'restart-shell';
    const notice: MessageEntry<UserMessage> = {
      info: {
        id: 'msg_lost_shell',
        sessionID,
        role: 'user',
        time: { created: 1 },
        agent: 'build',
        model: { providerID: 'fixture', modelID: 'fixture' },
      },
      parts: [
        {
          id: 'msg_lost_shell:content:0',
          messageID: 'msg_lost_shell',
          sessionID,
          type: 'text',
          synthetic: true,
          text: '<shell id="sh_lost" state="cancelled" command="npm test">\nCommand cancelled because the server restarted\n</shell>',
        },
      ],
    };
    await installPlaybackCapture(page, {
      session: {
        id: sessionID,
        projectID: 'test',
        directory: '/workspace',
        title: 'Restart shell',
        version: '1',
        time: { created: 1, updated: 1 },
      },
      initialMessages: [notice],
    });
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    for (const reload of [false, true]) {
      if (reload) await page.reload();
      const row = page.locator('[data-msg-id="msg_lost_shell"]');
      await expect(row).toHaveCount(1);
      await expect(row.locator('.user-message-card')).toHaveCount(0);
      await row.locator('.assistant-activity-summary').click();
      const header = row.locator('.tool-invocation-header');
      await expect(header).toContainText('Background command cancelled: npm test');
      await expect(header).not.toContainText('finished');
      await header.click();
      await expect(row.locator('.tool-invocation-detail')).toContainText(
        'Command cancelled because the server restarted'
      );
      await expect(page.locator('[data-native-input-id], .inline-edit-composer-slot')).toHaveCount(
        0
      );
    }
  });
}
