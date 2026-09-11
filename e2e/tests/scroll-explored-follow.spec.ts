import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { AssistantMessage, MessageEntry, Session } from '../../src/webview/types';
import { getScrollMetrics, waitForAnimationFrames } from './helpers';

for (const shortHistory of [false, true]) {
  for (const followAction of ['none', 'down', 'up', 'up-before'] as const) {
    if (!shortHistory && followAction === 'up-before') continue;
    const followsOutput = followAction === 'down' || (shortHistory && followAction === 'none');
    for (const content of ['text', 'tool-then-text'] as const) {
      test(`${followsOutput ? 'follows' : 'pauses'} later ${content} after opening Explored with ${shortHistory ? 'short' : 'overflowing'} history and ${followAction} wheel input`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 497, height: 900 });
        const created = 1_780_000_000_000;
        const session: Session = {
          id: 'session-explored-follow',
          projectID: 'project-test',
          directory: '/workspace',
          title: 'Expanded activity follow',
          version: '1.0.0',
          time: { created, updated: created },
        };
        const user: MessageEntry = {
          info: {
            id: 'explored-user',
            sessionID: session.id,
            role: 'user',
            time: { created },
            agent: 'build',
            model: { providerID: 'openai', modelID: 'gpt-5' },
          },
          parts: [
            {
              id: 'explored-prompt',
              sessionID: session.id,
              messageID: 'explored-user',
              type: 'text',
              text: 'Inspect the source and report your findings.',
            },
          ],
        };
        const info: AssistantMessage = {
          id: 'explored-assistant',
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
              id: 'explored-intro',
              sessionID: session.id,
              messageID: info.id,
              type: 'text',
              text: Array.from(
                { length: shortHistory ? 1 : 16 },
                (_, index) =>
                  `Inspection paragraph ${index}. Read the source files, then follow the new output after returning to the bottom of the transcript.`
              ).join('\n\n'),
            },
            ...Array.from({ length: 3 }, (_, index) => ({
              id: `explored-read-${index}`,
              sessionID: session.id,
              messageID: info.id,
              callID: `explored-read-call-${index}`,
              type: 'tool' as const,
              tool: 'read',
              state: {
                status: 'completed' as const,
                input: { filePath: `/workspace/source-${index}.ts` },
                title: 'Read source',
                output: 'Source contents',
                metadata: {},
                time: { start: created + 110, end: created + 120 },
              },
            })),
          ],
        };
        await page.addInitScript(
          (fixture) => {
            // SAFETY: The isolated E2E page reads this fixture before mounting.
            (
              window as typeof window & { varroPlaybackCapture: typeof fixture }
            ).varroPlaybackCapture = fixture;
          },
          { session, initialMessages: [user, assistant] }
        );
        await page.goto('/e2e/harness/index.html?scenario=session-playback');
        const list = page.locator('.interactive-list');
        const summary = page.locator('.assistant-activity-summary').last();
        await expect(summary).toHaveAttribute('aria-expanded', 'false');
        await expect
          .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
          .toBeLessThan(2);
        await page.evaluate((assistantInfo) => {
          // SAFETY: This page owns the isolated E2E event transport.
          const harness = (
            window as typeof window & {
              __varroE2E: { replayServerEvent: (event: ServerEvent) => void };
            }
          ).__varroE2E;
          harness.replayServerEvent({
            type: 'message.updated',
            properties: { info: assistantInfo },
          });
          harness.replayServerEvent({
            type: 'session.status',
            properties: { sessionID: assistantInfo.sessionID, status: { type: 'busy' } },
          });
        }, info);
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
        await waitForAnimationFrames(page, 4);
        if (followAction === 'up-before') {
          const box = (await list.boundingBox())!;
          await page.mouse.move(box.x + 5, box.y + box.height / 2);
          await page.mouse.wheel(0, -80);
          await waitForAnimationFrames(page, 4);
        }
        const summaryTop = await summary.evaluate((element) => element.getBoundingClientRect().top);
        await summary.click();
        await expect(summary).toHaveAttribute('aria-expanded', 'true');
        const expansionTops = await summary.evaluate(async (element) => {
          const tops: number[] = [];
          for (let frame = 0; frame < 12; frame++) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            tops.push(element.getBoundingClientRect().top);
          }
          return tops;
        });
        expect(
          expansionTops.every((top) => Math.abs(top - summaryTop) <= 1.5),
          JSON.stringify({ summaryTop, expansionTops })
        ).toBe(true);
        const expandedMetrics = await getScrollMetrics(page, '.interactive-list');
        if (shortHistory) expect(expandedMetrics.distanceFromBottom).toBeLessThan(2);
        else expect(expandedMetrics.distanceFromBottom).toBeGreaterThan(50);

        if (followAction === 'down' || followAction === 'up') {
          const box = (await list.boundingBox())!;
          await page.mouse.move(box.x + 5, box.y + box.height / 2);
          await page.mouse.wheel(0, followAction === 'down' ? 2000 : -80);
          await waitForAnimationFrames(page, 8);
          if (followAction === 'down') {
            await expect
              .poll(() =>
                getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom)
              )
              .toBeLessThan(2);
          }
        }

        const samples = await list.evaluate(async (element, contentKind) => {
          // SAFETY: This page owns the isolated E2E event transport.
          const harness = (
            window as typeof window & {
              __varroE2E: { replayServerEvent: (event: ServerEvent) => void };
            }
          ).__varroE2E;
          const marker = element.querySelector<HTMLElement>('.assistant-activity-summary')!;
          const frameSamples = [
            { top: marker.getBoundingClientRect().top, scrollTop: element.scrollTop },
          ];
          const target = {
            sessionID: 'session-explored-follow',
            messageID: 'explored-assistant',
            partID: 'explored-response',
          };
          const sampleFrame = () => {
            const currentMarker = marker.isConnected
              ? marker
              : element.querySelector<HTMLElement>(
                  `.assistant-activity-summary[data-activity-summary-group-key="${CSS.escape(marker.dataset.activitySummaryGroupKey!)}"]`
                );
            if (!currentMarker) throw new Error('The expanded activity summary disappeared');
            frameSamples.push({
              top: currentMarker.getBoundingClientRect().top,
              scrollTop: element.scrollTop,
            });
          };
          if (contentKind === 'tool-then-text') {
            const startedAt = Date.now();
            const tool = {
              id: 'explored-later-read',
              sessionID: target.sessionID,
              messageID: target.messageID,
              callID: 'explored-later-read-call',
              type: 'tool' as const,
              tool: 'read',
            };
            harness.replayServerEvent({
              type: 'message.part.updated',
              properties: {
                part: {
                  ...tool,
                  state: {
                    status: 'running' as const,
                    input: { filePath: '/workspace/later.ts' },
                    title: 'Read later source',
                    time: { start: startedAt },
                  },
                },
              },
            });
            let activeTrayShown = false;
            for (let frame = 0; frame < 195; frame++) {
              if (frame === 150) {
                harness.replayServerEvent({
                  type: 'message.part.updated',
                  properties: {
                    part: {
                      ...tool,
                      state: {
                        status: 'completed' as const,
                        input: { filePath: '/workspace/later.ts' },
                        title: 'Read later source',
                        output: 'Later source contents',
                        metadata: {},
                        time: { start: startedAt, end: Date.now() },
                      },
                    },
                  },
                });
              }
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              activeTrayShown ||= !!element.querySelector(
                '[data-activity-part-id="explored-later-read"]'
              );
              sampleFrame();
            }
            if (!activeTrayShown) throw new Error('The later tool never entered the active tray');
            if (element.querySelector('[data-activity-part-id="explored-later-read"]')) {
              throw new Error('The later tool never finished its exit');
            }
          }
          harness.replayServerEvent({
            type: 'message.part.updated',
            properties: {
              part: { id: target.partID, ...target, type: 'text', text: '' },
            },
          });
          for (let frame = 0; frame < 100; frame++) {
            if (frame < 80 && frame % 4 === 0) {
              harness.replayServerEvent({
                type: 'message.part.delta',
                properties: {
                  ...target,
                  field: 'text',
                  delta: `\n\nFinding ${frame / 4 + 1}. New response text keeps growing below the expanded source reads and must remain visible when following.`,
                },
              });
            }
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            sampleFrame();
          }
          return frameSamples;
        }, content);
        await expect(page.locator('.rendered-markdown').last()).toContainText('Finding 20.');
        await expect(summary).toHaveAttribute('aria-expanded', 'true');
        if (followsOutput) {
          expect(
            samples.every(
              (sample, index) => index === 0 || sample.top <= samples[index - 1]!.top + 1.5
            ),
            JSON.stringify(samples)
          ).toBe(true);
          await expect
            .poll(() =>
              getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom)
            )
            .toBeLessThan(2);
          await expect(page.getByText(/^Finding 20\./)).toBeInViewport();
        } else {
          expect(
            samples.every((sample) => Math.abs(sample.top - samples[0]!.top) <= 1.5),
            JSON.stringify(samples)
          ).toBe(true);
          expect(
            (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom
          ).toBeGreaterThan(200);
        }

        if (shortHistory && followAction === 'none' && content === 'text') {
          const collapseTops = await summary.evaluate(async (element) => {
            if (!(element instanceof HTMLElement)) throw new Error('Explored summary is not HTML');
            const tops = [element.getBoundingClientRect().top];
            element.click();
            tops.push(element.getBoundingClientRect().top);
            for (let frame = 0; frame < 12; frame += 1) {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              tops.push(element.getBoundingClientRect().top);
            }
            return tops;
          });
          await expect(summary).toHaveAttribute('aria-expanded', 'false');
          const deltas = collapseTops.slice(1).map((top, index) => top - collapseTops[index]!);
          const movedUp = deltas.some((delta) => delta < -0.5);
          const movedDown = deltas.some((delta) => delta > 0.5);
          expect(movedUp && movedDown, JSON.stringify({ collapseTops, deltas })).toBe(false);
        }
      });
    }
  }
}
