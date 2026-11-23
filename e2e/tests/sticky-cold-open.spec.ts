import { expect, test } from '@playwright/test';
import type { MessageEntry } from '../../src/webview/types';
import { installPlaybackCapture } from './helpers';

const sessionId = 'sticky-cold-open';
const created = 1_780_000_000_000;
const originalPrompt = 'Review the test results and fix verified issues.';

function history(): MessageEntry[] {
  let parentID = 'prompt-0';
  return Array.from({ length: 451 }, (_, index): MessageEntry => {
    const id = `message-${index}`;
    const time = created + index * 10;
    if (index === 0 || index === 193 || index === 255) {
      parentID = id;
      return {
        info: {
          id,
          sessionID: sessionId,
          role: 'user',
          agent: 'build',
          model: { providerID: 'test', modelID: 'test' },
          time: { created: time },
          followupTitle:
            index === 0
              ? undefined
              : index === 193
                ? 'Investigate the stall'
                : 'Optimize cold load',
        },
        parts: [
          {
            id: `text-${id}`,
            messageID: id,
            sessionID: sessionId,
            type: 'text',
            text: index === 0 ? originalPrompt : `Follow-up instruction ${index}`,
          },
        ],
      };
    }
    return {
      info: {
        id,
        parentID,
        sessionID: sessionId,
        role: 'assistant',
        mode: 'build',
        agent: 'build',
        providerID: 'test',
        modelID: 'test',
        time: { created: time, completed: time + 1 },
        finish: index === 192 || index === 254 || index === 450 ? 'stop' : 'tool-calls',
        path: { cwd: '/workspace', root: '/workspace' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: `text-${id}`,
          messageID: id,
          sessionID: sessionId,
          type: 'text',
          text: `Completed verification step ${index}. The result remains visible in this long response.`,
        },
      ],
    };
  });
}

for (const width of [480, 1280]) {
  test(`cold open finds the sticky prompt across follow-up pages without scrolling at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    await installPlaybackCapture(page, {
      session: {
        id: sessionId,
        projectID: 'test',
        directory: '/workspace',
        title: 'Cold-open sticky prompt',
        version: '1',
        time: { created, updated: created },
      },
      initialMessages: history(),
    });
    await page.goto('/e2e/harness/index.html?scenario=session-playback&windowed=1');
    await expect(page.locator('[data-msg-id="message-450"]')).toBeVisible();
    const sticky = page.locator('[data-sticky-msg-id="message-0"]');
    await expect(sticky).toBeVisible();
    await expect(sticky).toContainText(originalPrompt);
    await expect(page.locator('[data-msg-id="message-0"]')).toHaveCount(0);
    await expect(page.locator('.message-history-banner')).toBeVisible();

    const messageRequests = await page.evaluate((id) => {
      // SAFETY: The isolated harness exposes its request log for pagination assertions.
      const harness = (
        window as typeof window & {
          __varroE2E: { requests: Array<{ method: string; path: string }> };
        }
      ).__varroE2E;
      return harness.requests.filter((request) => {
        const url = new URL(request.path, 'http://localhost');
        return request.method === 'GET' && url.pathname === `/session/${id}/message`;
      });
    }, sessionId);
    expect(messageRequests).toHaveLength(3);
    expect(messageRequests.filter((request) => request.path.includes('before='))).toHaveLength(2);
  });
}
