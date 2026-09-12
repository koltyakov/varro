/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: The frame collector is installed by this test in its isolated browser page. */
import { expect, test } from '@playwright/test';
import type { Part } from '@opencode-ai/sdk/v2';
import { getScrollMetrics, waitForAnimationFrames } from './helpers';
import { appendDeltaToRapidStreaming } from './scroll-helpers';

for (const reference of [
  {
    name: 'inline file path',
    open: '`',
    chunks: [
      '/Users/andrew/Projects/GitHub/varro/src/extension/',
      'hooks/runtime/open-code-runtime-instance.ts',
      ':763-840',
    ],
    close: '`',
    final: 'open-code-runtime-instance.ts',
  },
  {
    name: 'Markdown link destination',
    open: '[Reference](',
    chunks: [
      'https://example.test/documentation/streaming/',
      'message-list-virtualization/height-accounting/',
      'long-reference-completion',
    ],
    close: ')',
    final: 'Reference',
  },
]) {
  test(`completing a streamed ${reference.name} never moves painted content backward`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 486, height: 900 });
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const row = page.locator('[data-msg-id="message-rapid-assistant-streaming"]');
    await expect(row).toBeVisible();
    const marker = 'Replay reference-completion anchor.';
    await appendDeltaToRapidStreaming(page, `\n\n${marker}\n\nSee ${reference.open}`);
    await expect(row.locator('p').filter({ hasText: marker })).toBeVisible();
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThanOrEqual(1);

    await page.evaluate((text) => {
      const anchor = [...document.querySelectorAll('.rendered-markdown p')].find(
        (element) => element.textContent === text
      );
      if (!anchor) throw new Error('Missing painted replay marker');
      const list = document.querySelector<HTMLElement>('.interactive-list')!;
      const samples: Array<{ top: number; connected: boolean; scrollTop: number }> = [];
      const collector = { samples, raf: 0 };
      const sample = () => {
        samples.push({
          top: anchor.getBoundingClientRect().top,
          connected: anchor.isConnected,
          scrollTop: list.scrollTop,
        });
        collector.raf = requestAnimationFrame(sample);
      };
      (window as Window & { referenceFrames?: typeof collector }).referenceFrames = collector;
      sample();
    }, marker);

    for (const chunk of reference.chunks) {
      await appendDeltaToRapidStreaming(page, chunk);
      await expect(row.locator('.streaming-markdown-pending')).toContainText(chunk);
      await expect
        .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
        .toBeLessThanOrEqual(1);
      await waitForAnimationFrames(page, 2);
    }
    await appendDeltaToRapidStreaming(page, reference.close);
    await expect(row.locator('.streaming-markdown-pending')).toHaveCount(0);
    await expect(row.locator('a').filter({ hasText: reference.final })).toBeVisible();
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThanOrEqual(1);
    await waitForAnimationFrames(page, 5);
    const samples = await page.evaluate(() => {
      const collector = (
        window as Window & {
          referenceFrames?: {
            samples: Array<{ top: number; connected: boolean; scrollTop: number }>;
            raf: number;
          };
        }
      ).referenceFrames!;
      cancelAnimationFrame(collector.raf);
      return collector.samples;
    });
    expect(samples.every((sample) => sample.connected)).toBe(true);
    const reversals = samples.flatMap((sample, index) => {
      const previous = samples[index - 1];
      return previous && sample.top - previous.top > 1 ? [{ previous, sample }] : [];
    });
    expect(
      reversals,
      'The same painted paragraph must not reverse as a reference compacts'
    ).toEqual([]);
  });
}

test('off-core file links preserve row height while a later response streams', async ({ page }) => {
  await page.setViewportSize({ width: 486, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  const historyId = 'message-rapid-assistant-47';
  const history = page.locator(`[data-msg-id="${historyId}"]`);
  await expect(history).toContainText('Response 47');
  const text = Array.from(
    { length: 24 },
    (_, index) =>
      `- \`/Users/andrew/Projects/GitHub/varro/src/webview/components/message-list/reference-${index}.ts:100-120\``
  ).join('\n');
  await page.evaluate(
    ({ messageID, text: content }) => {
      const part: Part = {
        id: `${messageID}-text-1`,
        messageID,
        sessionID: 'session-rapid-streaming-jitter',
        type: 'text',
        text: content,
      };
      const harness = (
        window as Window & { __varroE2E?: { updateMessagePart: (part: Part) => void } }
      ).__varroE2E;
      if (!harness) throw new Error('Missing E2E harness');
      harness.updateMessagePart(part);
      window.postMessage(
        { type: 'server/event', payload: { type: 'message.part.updated', properties: { part } } },
        '*'
      );
    },
    { messageID: historyId, text }
  );
  await expect(history.locator('a.file-path-link')).toHaveCount(24);
  await expect
    .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
    .toBeLessThanOrEqual(1);
  await waitForAnimationFrames(page, 3);
  const collector = await history.evaluateHandle((row) => {
    const state = { running: true, samples: [] as Array<{ height: number; links: number }> };
    const sample = () => {
      state.samples.push({
        height: row.getBoundingClientRect().height,
        links: row.querySelectorAll('a.file-path-link').length,
      });
      if (state.running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    return state;
  });
  for (let index = 0; index < 10; index++) {
    await appendDeltaToRapidStreaming(
      page,
      `\n\nStreaming block ${index}. ${'A later response moves the reference row out of the core. '.repeat(3)}`
    );
    await waitForAnimationFrames(page, 12);
  }
  await waitForAnimationFrames(page, 30);
  const samples = await collector.evaluate((state) => {
    state.running = false;
    return state.samples;
  });
  expect(samples.length).toBeGreaterThan(100);
  expect(
    samples.every((sample) => sample.links === 24),
    JSON.stringify(samples)
  ).toBe(true);
  const heights = samples.map((sample) => sample.height);
  expect(Math.max(...heights) - Math.min(...heights), JSON.stringify(samples)).toBeLessThan(1);
});

for (const block of [
  { name: 'paragraph', prefix: '', tag: 'p' },
  { name: 'list item', prefix: '- ', tag: 'li' },
  { name: 'heading', prefix: '## ', tag: 'h2' },
]) {
  test(`streaming a ${block.name} keeps already delivered words on their original lines`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 486, height: 900 });
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const row = page.locator('[data-msg-id="message-rapid-assistant-streaming"]');
    await expect(row).toBeVisible();
    const words =
      'Streaming Markdown should keep the words you have already read in the same place while additional text extends the current paragraph. New content belongs at the end instead of moving earlier words between lines.'.split(
        ' '
      );
    await appendDeltaToRapidStreaming(page, `\n\n${block.prefix}`);
    let delivered = '';
    let previous: Array<{ word: string; x: number; y: number }> = [];
    const shifts: Array<{ after: string; before: unknown; current: unknown }> = [];
    for (const word of words) {
      delivered += `${word} `;
      await appendDeltaToRapidStreaming(page, `${word} `);
      const element = row.locator(`.rendered-markdown ${block.tag}`).last();
      await expect(element).toHaveText(delivered.trim());
      const positions = await element.evaluate((node) => {
        const text = node.firstChild;
        if (!(text instanceof Text)) throw new Error('Expected plain streamed prose');
        const origin = node.getBoundingClientRect();
        return [...text.data.matchAll(/\S+/g)].map((match) => {
          const range = document.createRange();
          range.setStart(text, match.index);
          range.setEnd(text, match.index + match[0].length);
          const rect = range.getBoundingClientRect();
          return { word: match[0], x: rect.left - origin.left, y: rect.top - origin.top };
        });
      });
      for (const [index, before] of previous.entries()) {
        const current = positions[index]!;
        if (Math.abs(before.x - current.x) > 0.5 || Math.abs(before.y - current.y) > 0.5) {
          shifts.push({ after: word, before, current });
        }
      }
      previous = positions;
    }
    expect(shifts, 'Appending words must not rebalance text that has already been painted').toEqual(
      []
    );
  });
}

for (const pair of [
  { name: 'paragraph to paragraph', before: 'Previous block.', next: 'New block', gap: 12 },
  { name: 'bold heading to paragraph', before: '**Previous block.**', next: 'New block', gap: 8 },
  { name: 'paragraph to list', before: 'Previous block.', next: '- New block', gap: 8 },
  { name: 'list to paragraph', before: '- Previous block.', next: 'New block', gap: 8 },
  { name: 'ordered list to paragraph', before: '1. Previous block.', next: 'New block', gap: 8 },
]) {
  test(`${pair.name} spacing is fixed from first partial paint through segment promotion`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 486, height: 900 });
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const row = page.locator('[data-msg-id="message-rapid-assistant-streaming"]');
    await expect(row).toBeVisible();
    await appendDeltaToRapidStreaming(page, `\n\n${pair.before}\n\n${pair.next}`);
    await expect(row).toContainText('New block');
    const collector = await row.evaluateHandle((element) => {
      const state = { running: true, gaps: [] as number[] };
      const sample = () => {
        const blocks = [...element.querySelectorAll('[data-markdown-segment] > :is(p, ul, ol)')];
        const previous = blocks.find((block) => block.textContent?.includes('Previous block.'));
        const current = blocks.find((block) => block.textContent?.includes('New block'));
        if (!previous || !current) throw new Error('Missing adjacent Markdown blocks');
        state.gaps.push(
          current.getBoundingClientRect().top - previous.getBoundingClientRect().bottom
        );
        if (state.running) requestAnimationFrame(sample);
      };
      sample();
      return state;
    });
    await appendDeltaToRapidStreaming(page, ' continues with more streamed text.');
    await expect(row).toContainText('New block continues with more streamed text.');
    await waitForAnimationFrames(page, 3);
    await appendDeltaToRapidStreaming(page, '\n\nAnother tail follows.');
    await expect(row.locator('[data-markdown-segment="stable"]')).toContainText(
      'New block continues with more streamed text.'
    );
    await waitForAnimationFrames(page, 5);
    const gaps = await collector.evaluate((state) => {
      state.running = false;
      return state.gaps;
    });
    expect(gaps.length).toBeGreaterThan(5);
    expect(Math.max(...gaps) - Math.min(...gaps), JSON.stringify(gaps)).toBeLessThan(1);
    expect(gaps.at(-1)).toBeCloseTo(pair.gap, 0);
  });
}
