import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { AssistantMessage, MessageEntry, Session } from '../../src/webview/types';

for (const measured of [false, true]) {
  for (const split of [false, true]) {
    test(`background completion preserves painted content: ${split ? 'split' : 'batched'} notice, ${measured ? 'measured' : 'short'}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 486, height: 794 });
      const created = Date.now() - 10_000;
      const session: Session = {
        id: 'session-background-scroll',
        projectID: 'project-test',
        directory: '/workspace',
        title: 'Background scroll',
        version: '1.0.0',
        time: { created, updated: created },
      };
      const assistant: AssistantMessage = {
        id: 'background-answer',
        sessionID: session.id,
        role: 'assistant',
        parentID: 'background-prompt',
        time: { created, completed: created + 1000 },
        finish: 'stop',
        providerID: 'openai',
        modelID: 'gpt-5',
        mode: 'build',
        agent: 'build',
        path: { cwd: '/workspace', root: '/workspace' },
        cost: 0,
        tokens: { input: 42, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
      };
      const initialMessages: MessageEntry[] = [
        {
          info: {
            id: assistant.parentID,
            sessionID: session.id,
            role: 'user',
            time: { created },
            agent: 'build',
            model: { providerID: 'openai', modelID: 'gpt-5' },
          },
          parts: [
            {
              id: 'prompt-text',
              messageID: assistant.parentID,
              sessionID: session.id,
              type: 'text',
              text: 'Run the checks.',
            },
          ],
        },
        {
          info: assistant,
          parts: [
            {
              id: 'answer-text',
              messageID: assistant.id,
              sessionID: session.id,
              type: 'text',
              text: Array.from(
                { length: 22 },
                (_, index) =>
                  `Check ${index + 1} completed. The background checks are still running.`
              ).join('\n\n'),
            },
          ],
        },
      ];
      if (measured) {
        const history = Array.from({ length: 25 }, (_, index): MessageEntry[] => {
          const promptID = `history-prompt-${index}`;
          const answerID = `history-answer-${index}`;
          return [
            {
              info: {
                ...initialMessages[0]!.info,
                id: promptID,
                time: { created: created - (25 - index) * 3000 },
              },
              parts: [
                {
                  id: `${promptID}-text`,
                  messageID: promptID,
                  sessionID: session.id,
                  type: 'text',
                  text: `Check earlier result ${index}.`,
                },
              ],
            },
            {
              info: {
                ...assistant,
                id: answerID,
                parentID: promptID,
                time: {
                  created: created - (25 - index) * 3000 + 1000,
                  completed: created - (25 - index) * 3000 + 2000,
                },
              },
              parts: [
                {
                  id: `${answerID}-text`,
                  messageID: answerID,
                  sessionID: session.id,
                  type: 'text',
                  text: `Earlier result ${index} passed.`,
                },
              ],
            },
          ];
        }).flat();
        initialMessages.unshift(...history);
      }
      await page.addInitScript(
        (fixture) => {
          // SAFETY: The playback harness reads this typed fixture before mounting.
          (
            window as typeof window & { varroPlaybackCapture: typeof fixture }
          ).varroPlaybackCapture = fixture;
        },
        { session, initialMessages }
      );
      await page.goto('/e2e/harness/index.html?scenario=session-playback');
      await page.evaluate((sessionID) => {
        // SAFETY: This isolated page installs the production-event replay transport.
        const harness = (
          window as Window & { __varroE2E?: { replayServerEvent(event: ServerEvent): void } }
        ).__varroE2E;
        if (!harness) throw new Error('Missing playback harness');
        harness.replayServerEvent({
          type: 'session.status',
          properties: { sessionID, status: { type: 'busy', background: true } },
        });
      }, session.id);
      await expect(page.locator('.background-process')).toBeVisible();
      await expect
        .poll(() =>
          page
            .locator('.interactive-list')
            .evaluate((list) => list.scrollHeight - list.clientHeight - list.scrollTop)
        )
        .toBeLessThanOrEqual(1);
      await page.waitForTimeout(400);
      const result = await page.evaluate(
        async ({ sessionID, assistant: resumedFrom, split: splitNotice }) => {
          // SAFETY: This isolated page installs the production-event replay transport.
          const harness = (
            window as Window & { __varroE2E?: { replayServerEvent(event: ServerEvent): void } }
          ).__varroE2E;
          const list = document.querySelector<HTMLElement>('.interactive-list');
          const marker = list?.querySelector<HTMLElement>(
            '[data-msg-id="background-answer"] .rendered-markdown p:last-child'
          );
          if (!harness || !list || !marker) throw new Error('Missing painted background marker');
          const sample = () => ({
            top: marker.getBoundingClientRect().top,
            scrollTop: list.scrollTop,
            background: !!list.querySelector('.background-process'),
            loading: list.querySelector('.interactive-loading-row')?.getBoundingClientRect().height,
            worked: list.querySelectorAll('.assistant-dialog-summary').length,
          });
          const samples = [sample()];
          harness.replayServerEvent({
            type: 'message.updated',
            properties: {
              info: {
                id: 'background-notice',
                sessionID,
                role: 'user',
                time: { created: Date.now() },
                agent: 'build',
                model: { providerID: 'openai', modelID: 'gpt-5' },
              },
            },
          });
          if (splitNotice) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            samples.push(sample());
          }
          harness.replayServerEvent({
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'notice-text',
                messageID: 'background-notice',
                sessionID,
                type: 'text',
                synthetic: true,
                text: '<shell id="background-shell" state="completed" command="npm test">\nAll checks passed.\n</shell>',
              },
            },
          });
          harness.replayServerEvent({
            type: 'session.status',
            properties: { sessionID, status: { type: 'busy' } },
          });
          harness.replayServerEvent({
            type: 'message.updated',
            properties: {
              info: {
                ...resumedFrom,
                id: 'resumed-answer',
                finish: undefined,
                time: { created: Date.now() },
              },
            },
          });
          const deadline = performance.now() + 1200;
          while (performance.now() < deadline) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            samples.push(sample());
          }
          return { samples, connected: marker.isConnected };
        },
        { sessionID: session.id, assistant, split }
      );
      await test.info().attach('background-handoff-frames', {
        body: JSON.stringify(result),
        contentType: 'application/json',
      });
      expect(result.connected).toBe(true);
      expect(result.samples.at(-1)?.background).toBe(false);
      expect(result.samples.at(-1)?.loading).toBe(24);
      expect(result.samples.every((sample) => sample.worked <= result.samples[0]!.worked)).toBe(
        true
      );
      expect(
        result.samples
          .slice(1)
          .filter((sample, index) => sample.top > result.samples[index]!.top + 0.1)
      ).toEqual([]);
    });
  }
}
