import { expect, test } from '@playwright/test';
import type { MessageEntry, Session } from '../../src/webview/types';
import { getScrollMetrics, waitForAnimationFrames } from './helpers';

for (const virtualized of [false, true]) {
  for (const detached of [false, true]) {
    test(`tool details keep their header fixed immediately with ${virtualized ? 'virtualized' : 'short'} history while ${detached ? 'detached' : 'following'}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 497, height: 900 });
      const created = 1_780_000_000_000;
      const session: Session = {
        id: 'session-tool-expansion',
        projectID: 'project-test',
        directory: '/workspace',
        title: 'Tool expansion anchor',
        version: '1.0.0',
        time: { created, updated: created },
      };
      const initialMessages: MessageEntry[] = Array.from(
        { length: virtualized ? 60 : 2 },
        (_message, index) => {
          const id = `expansion-message-${index}`;
          if (index % 2 === 0) {
            return {
              info: {
                id,
                sessionID: session.id,
                role: 'user',
                time: { created },
                agent: 'build',
                model: { providerID: 'openai', modelID: 'gpt-5' },
              },
              parts: [
                {
                  id: `${id}-text`,
                  sessionID: session.id,
                  messageID: id,
                  type: 'text',
                  text: 'Inspect the source.',
                },
              ],
            };
          }
          return {
            info: {
              id,
              sessionID: session.id,
              role: 'assistant',
              parentID: `expansion-message-${index - 1}`,
              time: { created, completed: created + 100 },
              providerID: 'openai',
              modelID: 'gpt-5',
              mode: 'build',
              agent: 'build',
              path: { cwd: '/workspace', root: '/workspace' },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [
              {
                id: `${id}-intro`,
                sessionID: session.id,
                messageID: id,
                type: 'text',
                text: Array.from(
                  { length: 12 },
                  (_, paragraph) =>
                    `Inspection paragraph ${paragraph}. The transcript should keep the clicked tool header at its painted position when details open below it.`
                ).join('\n\n'),
              },
              {
                id: `${id}-search`,
                sessionID: session.id,
                messageID: id,
                callID: `${id}-search-call`,
                type: 'tool',
                tool: 'grep',
                state: {
                  status: 'completed',
                  input: { pattern: 'expansion-anchor' },
                  title: 'Search source',
                  output: Array.from(
                    { length: 30 },
                    (_, line) => `/workspace/source.ts:${line + 1}: expansion-anchor result`
                  ).join('\n'),
                  metadata: {},
                  time: { start: created, end: created + 100 },
                },
              },
              {
                id: `${id}-answer`,
                sessionID: session.id,
                messageID: id,
                type: 'text',
                text: 'Inspection finished.\n\nThe search results are available above.\n\nOpen the search to inspect its details.',
              },
            ],
          };
        }
      );
      await page.addInitScript(
        (fixture) => {
          // SAFETY: The isolated E2E page reads this fixture before mounting.
          (
            window as typeof window & { varroPlaybackCapture: typeof fixture }
          ).varroPlaybackCapture = fixture;
        },
        { session, initialMessages }
      );
      await page.goto('/e2e/harness/index.html?scenario=session-playback');
      const list = page.locator('.interactive-list');
      if (virtualized)
        await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
      await expect
        .poll(() =>
          getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
        )
        .toBeLessThan(2);
      const summary = page.locator('.assistant-activity-summary').last();
      await summary.click();
      await expect(summary).toHaveAttribute('aria-expanded', 'true');
      const listBox = (await list.boundingBox())!;
      await page.mouse.move(listBox.x + 5, listBox.y + listBox.height / 2);
      await page.mouse.wheel(0, 2000);
      await expect
        .poll(() =>
          getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
        )
        .toBeLessThan(2);
      await waitForAnimationFrames(page, 8);
      if (detached) {
        const box = (await list.boundingBox())!;
        await page.mouse.move(box.x + 5, box.y + box.height / 2);
        await page.mouse.wheel(0, -60);
        await waitForAnimationFrames(page, 8);
      }
      const header = page.locator('.tool-invocation-header').last();
      await expect(header).toBeInViewport();
      const samples = await header.evaluate(async (element) => {
        if (!(element instanceof HTMLButtonElement)) throw new Error('Missing tool button');
        const viewport = element.closest<HTMLElement>('.interactive-list')!;
        const read = () => ({
          top: element.getBoundingClientRect().top,
          scrollTop: viewport.scrollTop,
          scrollHeight: viewport.scrollHeight,
        });
        const result = [read()];
        element.click();
        await Promise.resolve();
        result.push(read());
        for (let frame = 0; frame < 24; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          result.push(read());
        }
        return result;
      });
      await expect(header).toHaveAttribute('aria-expanded', 'true');
      expect(samples[1]!.scrollHeight).toBeGreaterThan(samples[0]!.scrollHeight + 100);
      expect(
        samples.every((sample) => Math.abs(sample.top - samples[0]!.top) <= 1),
        JSON.stringify(samples)
      ).toBe(true);
      expect(
        samples.every((sample) => Math.abs(sample.scrollTop - samples[0]!.scrollTop) <= 1),
        JSON.stringify(samples)
      ).toBe(true);
    });
  }
}
