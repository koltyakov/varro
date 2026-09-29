import { expect, test } from '@playwright/test';
import type { MessageEntry, Session } from '../../src/webview/types';

for (const windowed of [false, true]) {
  test(`opens ${windowed ? 'paginated' : 'complete'} history at its settled bottom from the first painted frame`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 476, height: 1269 });
    const session: Session = {
      id: 'session-reload',
      projectID: 'project-test',
      directory: '/workspace',
      title: 'Completed tool history',
      version: '1.0.0',
      time: { created: 1, updated: 1000 },
    };
    const initialMessages: MessageEntry[] = [
      {
        info: {
          id: 'user',
          sessionID: session.id,
          role: 'user',
          time: { created: 1 },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-5' },
        },
        parts: [
          {
            id: 'prompt',
            messageID: 'user',
            sessionID: session.id,
            type: 'text',
            text: 'Fix all the issues found and re-test',
          },
        ],
      },
    ];
    for (let index = 0; index < 40; index += 1) {
      const id = `assistant-${index}`;
      initialMessages.push({
        info: {
          id,
          sessionID: session.id,
          role: 'assistant',
          parentID: 'user',
          time: { created: index * 10 + 2, completed: index * 10 + 9 },
          providerID: 'openai',
          modelID: 'gpt-5',
          mode: 'build',
          agent: 'build',
          path: { cwd: '/workspace', root: '/workspace' },
          cost: 0,
          tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: index === 39 ? 'stop' : 'tool-calls',
        },
        parts:
          index % 8 === 7
            ? [
                {
                  id: `${id}-text`,
                  messageID: id,
                  sessionID: session.id,
                  type: 'text',
                  text: Array.from(
                    { length: 4 },
                    () =>
                      'The permission fixes now pass the live reset check. Editor hide/reveal, queue transfer, streaming reload, and busy model/agent switching also passed after correcting the navigation sequence.'
                  ).join('\n\n'),
                },
              ]
            : [
                {
                  id: `${id}-tool`,
                  messageID: id,
                  sessionID: session.id,
                  type: 'tool',
                  callID: `${id}-call`,
                  tool: 'read',
                  state: {
                    status: 'completed',
                    input: { filePath: '/workspace/source.ts' },
                    output: 'Source',
                    title: 'Read source',
                    metadata: {},
                    time: { start: 1, end: 2 },
                  },
                },
              ],
      });
    }
    await page.addInitScript(
      (fixture) => {
        // SAFETY: The isolated E2E page reads this fixture before mounting.
        (window as typeof window & { varroPlaybackCapture: typeof fixture }).varroPlaybackCapture =
          fixture;
      },
      { session, initialMessages }
    );
    await page.addInitScript(() => {
      const samples: Array<{ top: number; bottom: number; distance: number; reserved: number }> =
        [];
      // SAFETY: This isolated page owns the frame samples read by the test below.
      (
        window as typeof window & { initialPositionSamples: typeof samples }
      ).initialPositionSamples = samples;
      const sample = () => {
        const list = document.querySelector<HTMLElement>('.interactive-list');
        const rows = list?.querySelectorAll<HTMLElement>('[data-msg-id]');
        const last = rows?.[rows.length - 1];
        if (list && last && getComputedStyle(list).visibility !== 'hidden') {
          samples.push({
            top: last.getBoundingClientRect().top,
            bottom: last.getBoundingClientRect().bottom,
            distance: list.scrollHeight - list.clientHeight - list.scrollTop,
            reserved:
              list.querySelector('.interactive-loading-row.is-reserved')?.getBoundingClientRect()
                .height ?? 0,
          });
        }
        if (samples.length < 60) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.goto(
      `/e2e/harness/index.html?scenario=session-playback${windowed ? '&windowed=1&messagePageSize=8' : ''}`
    );
    for (const reload of [false, true]) {
      if (reload) await page.reload();
      await expect
        .poll(() =>
          page.evaluate(() => {
            // SAFETY: Installed by this test's init script.
            return (window as typeof window & { initialPositionSamples: unknown[] })
              .initialPositionSamples.length;
          })
        )
        .toBe(60);
      const samples = await page.evaluate(() => {
        // SAFETY: Installed by this test's init script.
        return (
          window as typeof window & {
            initialPositionSamples: Array<{
              top: number;
              bottom: number;
              distance: number;
              reserved: number;
            }>;
          }
        ).initialPositionSamples;
      });
      expect(
        Math.max(...samples.map((sample) => sample.bottom)) -
          Math.min(...samples.map((sample) => sample.bottom)),
        JSON.stringify(samples)
      ).toBeLessThanOrEqual(1);
      expect(
        samples.every((sample) => sample.distance <= 1),
        JSON.stringify(samples)
      ).toBe(true);
    }
  });
}
