import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { AssistantMessage, MessageEntry, Session, ToolPart } from '../../src/webview/types';

for (const settleMs of [0, 600]) {
  for (const replacement of ['edit', 'text'] as const) {
    for (const shortHistory of [false, true]) {
      test(`activity exit anchoring yields to ${replacement} after ${settleMs} ms with ${shortHistory ? 'short' : 'overflowing'} history`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 497, height: 800 });
        const created = 1_780_000_000_000;
        const session: Session = {
          id: 'session-activity-handoff',
          projectID: 'project-test',
          directory: '/workspace',
          title: 'Activity to edit handoff',
          version: '1.0.0',
          time: { created, updated: created },
        };
        const user: MessageEntry = {
          info: {
            id: 'handoff-user',
            sessionID: session.id,
            role: 'user',
            time: { created },
            agent: 'build',
            model: { providerID: 'openai', modelID: 'gpt-5' },
          },
          parts: [
            {
              id: 'handoff-prompt',
              sessionID: session.id,
              messageID: 'handoff-user',
              type: 'text',
              text: 'Inspect the source and make the correction.',
            },
          ],
        };
        const info: AssistantMessage = {
          id: 'handoff-assistant',
          sessionID: session.id,
          role: 'assistant',
          parentID: user.info.id,
          time: { created: created + 100 },
          providerID: 'openai',
          modelID: 'gpt-5',
          mode: 'build',
          agent: 'build',
          path: { cwd: '/workspace', root: '/workspace' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        };
        const assistant: MessageEntry = {
          info,
          parts: [
            {
              id: 'handoff-text',
              sessionID: session.id,
              messageID: info.id,
              type: 'text',
              text: Array.from(
                { length: 12 },
                (_, i) =>
                  `Paragraph ${i}. The current transcript must stay in place while tools complete and the next step adds an inline file edit.`
              ).join('\n\n'),
            },
          ],
        };
        assistant.parts.push({
          id: 'handoff-completed-read',
          sessionID: session.id,
          messageID: info.id,
          callID: 'handoff-completed-call',
          type: 'tool',
          tool: 'read',
          state: {
            status: 'completed',
            input: { filePath: '/workspace/other.ts' },
            title: 'Read other source',
            output: 'contents',
            metadata: {},
            time: { start: created + 110, end: created + 120 },
          },
        });
        await page.addInitScript(
          (fixture) => {
            // SAFETY: The isolated E2E harness reads this fixture before mounting.
            (
              window as typeof window & { varroPlaybackCapture: typeof fixture }
            ).varroPlaybackCapture = fixture;
          },
          { session, initialMessages: [user, assistant] }
        );
        await page.goto('/e2e/harness/index.html?scenario=session-playback');
        await expect(page.locator('.interactive-list')).toBeVisible();
        await expect(page.locator('.rendered-markdown').last()).toContainText('Paragraph 11.');
        if (shortHistory) {
          const extraHeight = await page
            .locator('.interactive-list')
            .evaluate((list) =>
              Math.ceil(
                list.querySelector('.interactive-list-track')!.getBoundingClientRect().height +
                  40 -
                  list.clientHeight
              )
            );
          await page.setViewportSize({ width: 497, height: 800 + extraHeight });
        }
        await page.waitForTimeout(300);
        const tool: ToolPart = {
          id: 'handoff-read',
          sessionID: session.id,
          messageID: info.id,
          callID: 'handoff-read-call',
          tool: 'read',
          type: 'tool',
          state: {
            status: 'running',
            input: { filePath: '/workspace/source.ts' },
            title: 'Read source',
            time: { start: created + 200 },
          },
        };
        const deliver = async (events: ServerEvent[]) =>
          page.evaluate((batch) => {
            // SAFETY: This page owns the E2E event transport.
            const harness = (
              window as typeof window & {
                __varroE2E: { replayServerEvent: (event: ServerEvent) => void };
              }
            ).__varroE2E;
            for (const event of batch) harness.replayServerEvent(event);
          }, events);
        await deliver([
          {
            type: 'session.status',
            properties: { sessionID: session.id, status: { type: 'busy' } },
          },
          { type: 'message.part.updated', properties: { part: tool } },
        ]);
        await expect(page.locator('[data-activity-part-id="handoff-read"]')).toBeVisible();
        await page.waitForTimeout(2200);
        await deliver([
          {
            type: 'message.part.updated',
            properties: {
              part: {
                ...tool,
                state: {
                  status: 'completed' as const,
                  input: tool.state.input,
                  title: 'Read source',
                  output: 'source contents',
                  metadata: {},
                  time: { start: created + 200, end: created + 2400 },
                },
              },
            },
          },
        ]);
        await expect(page.locator('[data-activity-part-id="handoff-read"]')).toHaveCount(0);
        await expect(page.locator('.append-scroll-bottom-reserve')).toHaveCSS('height', /[1-9]/);
        if (settleMs) await page.waitForTimeout(settleMs);
        const nextInfo: AssistantMessage = {
          ...info,
          id: 'handoff-edit-message',
          time: { created: created + 3000 },
        };
        const edit: ToolPart = {
          id: 'handoff-edit',
          sessionID: session.id,
          messageID: nextInfo.id,
          callID: 'handoff-edit-call',
          type: 'tool',
          tool: 'edit',
          state: {
            status: 'completed',
            input: { filePath: '/workspace/source.ts', oldString: 'before', newString: 'after' },
            title: 'Edit source',
            output: 'Edit applied',
            metadata: {
              filediff: {
                file: '/workspace/source.ts',
                before: 'before\n',
                after: 'after\n',
                additions: 1,
                deletions: 1,
              },
            },
            time: { start: created + 3100, end: created + 3200 },
          },
        };
        const samples = await page.evaluate(
          async ({ nextInfo: messageInfo, edit: editPart, replacement: kind }) => {
            // SAFETY: This page owns the E2E event transport and transcript DOM.
            const harness = (
              window as typeof window & {
                __varroE2E: { replayServerEvent: (event: ServerEvent) => void };
              }
            ).__varroE2E;
            const list = document.querySelector<HTMLElement>('.interactive-list')!;
            const paragraphs = [...list.querySelectorAll<HTMLElement>('.rendered-markdown p')];
            const marker = paragraphs.findLast((p) => {
              const r = p.getBoundingClientRect();
              const v = list.getBoundingClientRect();
              return r.top > v.top && r.bottom < v.bottom;
            })!;
            if (!marker) throw new Error('Painted marker missing');
            const result = [{ top: marker.getBoundingClientRect().top, scrollTop: list.scrollTop }];
            for (let frame = 0; frame < 90; frame++) {
              const part = editPart;
              if (frame === 0) {
                harness.replayServerEvent({
                  type: 'message.updated',
                  properties: { info: messageInfo },
                });
                if (kind === 'text') {
                  harness.replayServerEvent({
                    type: 'message.part.updated',
                    properties: {
                      part: {
                        id: 'replacement-text',
                        sessionID: messageInfo.sessionID,
                        messageID: messageInfo.id,
                        type: 'text',
                        text: '',
                      },
                    },
                  });
                } else
                  harness.replayServerEvent({
                    type: 'message.part.updated',
                    properties: {
                      part: {
                        ...part,
                        state: { status: 'pending' as const, input: part.state.input, raw: '' },
                      },
                    },
                  });
              }
              if (frame === 1 && kind === 'text')
                harness.replayServerEvent({
                  type: 'message.part.delta',
                  properties: {
                    sessionID: messageInfo.sessionID,
                    messageID: messageInfo.id,
                    partID: 'replacement-text',
                    field: 'text',
                    delta: 'Next step output.',
                  },
                });
              if (frame === 1 && kind === 'edit')
                harness.replayServerEvent({
                  type: 'message.part.updated',
                  properties: {
                    part: {
                      ...part,
                      state: {
                        status: 'running' as const,
                        input: part.state.input,
                        time: { start: Date.now() },
                      },
                    },
                  },
                });
              if (frame === 3 && kind === 'edit')
                harness.replayServerEvent({ type: 'message.part.updated', properties: { part } });
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              result.push({ top: marker.getBoundingClientRect().top, scrollTop: list.scrollTop });
            }
            return result;
          },
          { nextInfo, edit, replacement }
        );
        if (replacement === 'edit')
          await expect(page.locator('.file-change-card-header').last()).toContainText('source.ts');
        else
          await expect(page.locator('.rendered-markdown').last()).toContainText(
            'Next step output.'
          );
        expect(
          samples.every(
            (sample, index) => index === 0 || sample.top - samples[index - 1]!.top <= 1.5
          ),
          JSON.stringify(samples)
        ).toBe(true);
      });
    }
  }
}
