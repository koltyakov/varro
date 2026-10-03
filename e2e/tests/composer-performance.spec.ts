import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry, Session } from '../../src/webview/types';

const SESSION_ID = 'session-typing-load';

for (const count of [20, 10_000]) {
  test(`keeps typing responsive with ${count} loaded messages, idle and streaming`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 650, height: 900 });
    const now = Date.now() - count * 1_000;
    const session: Session = {
      id: SESSION_ID,
      projectID: 'project-varro',
      directory: '/workspace/varro',
      title: 'Typing load',
      version: '1',
      time: { created: now, updated: Date.now() },
    };
    const messages: MessageEntry[] = Array.from({ length: count }, (_, index) => {
      const id = `typing-${index}`;
      const user = index % 2 === 0;
      return {
        info: user
          ? {
              id,
              sessionID: SESSION_ID,
              role: 'user',
              time: { created: now + index * 1_000 },
              agent: 'build',
              model: { providerID: 'openai', modelID: 'gpt-5-mini' },
            }
          : {
              id,
              sessionID: SESSION_ID,
              role: 'assistant',
              parentID: `typing-${index - 1}`,
              time: { created: now + index * 1_000, completed: now + index * 1_000 + 500 },
              providerID: 'openai',
              modelID: 'gpt-5-mini',
              mode: 'build',
              agent: 'build',
              finish: 'stop',
              path: { cwd: session.directory, root: session.directory },
              cost: 0,
              tokens: { input: 1_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
            },
        parts: [
          {
            id: `typing-text-${index}`,
            sessionID: SESSION_ID,
            messageID: id,
            type: 'text',
            text: user
              ? `Review module ${index}.`
              : `## Review ${index}\n\n${'Keep the existing behavior and presentation. '.repeat(20)}\n\n\`\`\`ts\nexport const value = ${index};\n\`\`\``,
          },
        ],
      };
    });
    await page.addInitScript(
      (capture) => {
        // SAFETY: The session-playback harness reads this controlled fixture before mounting.
        (window as typeof window & { varroPlaybackCapture: unknown }).varroPlaybackCapture =
          capture;
      },
      { session, initialMessages: messages, events: [] }
    );
    await page.goto(`/e2e/harness/index.html?scenario=session-playback&messagePageSize=${count}`);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const path = '/src/webview/lib/state.ts';
          // SAFETY: This read-only import is served by the isolated Vite E2E harness.
          const { state } = (await import(path)) as {
            state: { messages: unknown[]; messagesLoading: boolean };
          };
          return state.messagesLoading ? 0 : state.messages.length;
        })
      )
      .toBe(count);
    const editor = page.locator('[role="textbox"][aria-multiline="true"]').first();
    await expect(editor).toBeVisible();
    await page.waitForTimeout(500);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const measurements = [];

    for (const streaming of [false, true]) {
      await editor.fill('');
      if (streaming) {
        const original = messages.at(-1)!;
        await page.evaluate(
          ({ info, partID }) => {
            // SAFETY: The playback harness installs this transport in the isolated page.
            const harness = (
              window as typeof window & {
                __varroE2E: { replayServerEvent: (event: ServerEvent) => void };
              }
            ).__varroE2E;
            harness.replayServerEvent({ type: 'message.updated', properties: { info } });
            harness.replayServerEvent({
              type: 'session.status',
              properties: { sessionID: info.sessionID, status: { type: 'busy' } },
            });
            const timer = setInterval(
              () =>
                harness.replayServerEvent({
                  type: 'message.part.delta',
                  properties: {
                    sessionID: info.sessionID,
                    messageID: info.id,
                    partID,
                    field: 'text',
                    delta: ' More text arrives.',
                  },
                }),
              32
            );
            window.addEventListener('typing-test-stop', () => clearInterval(timer), { once: true });
          },
          {
            info: { ...original.info, time: { created: Date.now() }, finish: undefined },
            partID: original.parts[0]!.id,
          }
        );
      }
      const recorder = await editor.evaluateHandle((element) => {
        const samples: number[] = [];
        const input = () => {
          const start = performance.now();
          requestAnimationFrame(() => samples.push(performance.now() - start));
        };
        element.addEventListener('input', input, true);
        return { samples, stop: () => element.removeEventListener('input', input, true) };
      });
      const text = 'Typing stays responsive as this conversation grows. '.repeat(2);
      await editor.pressSequentially(text, { delay: 12 });
      await expect(editor).toHaveText(text);
      await page.waitForTimeout(100);
      const samples = await recorder.evaluate((recorder) => {
        recorder.stop();
        return recorder.samples;
      });
      await recorder.dispose();
      await page.evaluate(() => window.dispatchEvent(new Event('typing-test-stop')));
      expect(samples).toHaveLength(text.length);
      samples.sort((left, right) => left - right);
      const p95 = samples[Math.floor(samples.length * 0.95)]!;
      measurements.push({ count, streaming, p95, max: samples.at(-1), samples });
      // Catch history-sized stalls, allowing normal frame scheduling and shared-CI jitter.
      expect(p95).toBeLessThan(50);
      await editor.press('ControlOrMeta+z');
      await expect(editor).not.toHaveText(text);
      await editor.press('ControlOrMeta+Shift+z');
      await expect(editor).toHaveText(text);
    }
    expect(errors).toEqual([]);
    await testInfo.attach('typing-latency.json', {
      body: JSON.stringify(measurements),
      contentType: 'application/json',
    });
  });
}
