/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: The controlled E2E harness installs these mock message accessors. */
import { writeFile } from 'node:fs/promises';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { getScrollMetrics, getVisibleMessageAnchor, waitForAnimationFrames } from './helpers';
import { appendDeltaToRapidStreaming } from './scroll-helpers';

const SESSION_ID = 'session-rapid-streaming-jitter';
const MESSAGE_ID = 'message-rapid-assistant-streaming';
const ROW = `[data-msg-id="${MESSAGE_ID}"]`;

async function appendStreamingTextDelta(page: Page, partID: string, delta: string) {
  await page.evaluate(
    ({ sessionID, messageID, id, text }) => {
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'message.part.delta',
            properties: { sessionID, messageID, partID: id, field: 'text', delta: text },
          },
        },
        '*'
      );
    },
    { sessionID: SESSION_ID, messageID: MESSAGE_ID, id: partID, text: delta }
  );
}

test('renders streamed LaTeX with local fonts and scrollable wide equations', async ({ page }) => {
  await page.setViewportSize({ width: 441, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  const markdown = page.locator(`${ROW} .rendered-markdown`);
  await expect(markdown).toHaveText('Starting...');
  const formula = Array.from({ length: 20 }, (_, index) => `x_{${index + 1}}`).join(' + ');
  await appendDeltaToRapidStreaming(
    page,
    `\n\nInline $x^2$, literal \`$x^2$\`, and currency $5.\n\nThe equation is:\n$$${formula}`
  );
  await expect(markdown.locator('.katex')).toHaveCount(1);
  await expect(markdown.locator('code')).toHaveText('$x^2$');
  await expect(markdown.getByRole('img', { name: 'Streaming content' })).toBeVisible();
  expect(await markdown.innerText()).not.toContain('x_{1}');
  await page.evaluate(() => document.fonts.ready);
  await waitForAnimationFrames(page, 20);
  const pendingHeight = await markdown.evaluate(
    (element) => element.getBoundingClientRect().height
  );

  await appendDeltaToRapidStreaming(page, '\n\n= 123456789');
  await waitForAnimationFrames(page, 3);
  await expect(markdown.locator('.katex-display')).toHaveCount(0);
  expect(await markdown.innerText()).not.toContain('123456789');
  expect(await markdown.evaluate((element) => element.getBoundingClientRect().height)).toBeCloseTo(
    pendingHeight,
    0
  );
  await appendDeltaToRapidStreaming(page, '$');
  await waitForAnimationFrames(page, 3);
  await expect(markdown.locator('.katex-display')).toHaveCount(0);
  expect(await markdown.innerText()).not.toContain('x_{1}');
  expect(await markdown.evaluate((element) => element.getBoundingClientRect().height)).toBeCloseTo(
    pendingHeight,
    0
  );
  await appendDeltaToRapidStreaming(page, '$\n\nFollowing paragraph.');
  await expect(markdown.locator('.katex')).toHaveCount(2);
  await expect(markdown.locator('.katex-error')).toHaveCount(0);
  await expect(markdown).toContainText('Following paragraph.');
  const fontCount = await page.evaluate(async () => {
    const fonts = await document.fonts.load('16px KaTeX_Main');
    await document.fonts.ready;
    return fonts.length;
  });
  expect(fontCount).toBeGreaterThan(0);

  const display = markdown.locator('.katex-display');
  const geometry = await display.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const parts = element.querySelectorAll('.katex-html > .katex-base');
    const firstLeft = parts[0]!.getBoundingClientRect().left - box.left;
    element.scrollLeft = element.scrollWidth;
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      scrollLeft: element.scrollLeft,
      firstLeft,
      lastRight: parts[parts.length - 1]!.getBoundingClientRect().right - box.right,
      overflowX: getComputedStyle(element).overflowX,
      mathmlPosition: getComputedStyle(element.querySelector('.katex-mathml')!).position,
    };
  });
  expect(geometry.overflowX).toBe('auto');
  expect(geometry.mathmlPosition).toBe('absolute');
  expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
  expect(geometry.scrollLeft).toBeGreaterThan(0);
  expect(geometry.firstLeft).toBeGreaterThanOrEqual(-1);
  expect(geometry.lastRight).toBeLessThanOrEqual(1);
});

test('preserves a settled equation and its horizontal position as more math streams', async ({
  page,
}) => {
  await page.setViewportSize({ width: 441, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  const markdown = page.locator(`${ROW} .rendered-markdown`);
  await expect(markdown).toHaveText('Starting...');
  const formula = Array.from({ length: 24 }, (_, index) => `x_{${index + 1}}`).join(' + ');
  await appendDeltaToRapidStreaming(page, `\n\n$$${formula} > 0$$\n\nReading the equation.`);
  await expect(markdown).toContainText('Reading the equation.');
  const equation = markdown.locator('[data-markdown-segment="stable"] .katex-display').first();
  await expect(equation).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
    )
    .toBeLessThanOrEqual(1);
  await equation.hover();
  await page.mouse.wheel(200, 0);
  await expect.poll(() => equation.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const original = await equation.elementHandle();
  const left = await equation.evaluate((element) => element.scrollLeft);

  for (let index = 0; index < 4; index += 1) {
    await appendDeltaToRapidStreaming(
      page,
      `\n\n$$y_${index} < z_${index}$$\n\nNext paragraph ${index}.`
    );
    await expect(markdown).toContainText(`Next paragraph ${index}.`);
    expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
    expect(await equation.evaluate((element) => element.scrollLeft)).toBe(left);
  }
});

test('hides inline LaTeX until its closing delimiter arrives', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  const markdown = page.locator(`${ROW} .rendered-markdown`);
  await expect(markdown).toHaveText('Starting...');
  await appendDeltaToRapidStreaming(page, '\n\nThe result is ');
  for (const delta of ['$', '\\', 'frac{a', '}{b}']) {
    await appendDeltaToRapidStreaming(page, delta);
    await waitForAnimationFrames(page, 3);
    await expect(markdown.locator('.katex')).toHaveCount(0);
    await expect(markdown.locator('.streaming-markdown-pending')).toHaveCount(1);
    await expect(markdown.getByRole('img', { name: 'Streaming content' })).toBeVisible();
    expect((await markdown.innerText()).trimEnd()).toBe('Starting...\n\nThe result is');
  }
  await appendDeltaToRapidStreaming(page, '$. It costs $5.');
  await expect(markdown.locator('.katex')).toHaveCount(1);
  await expect(markdown.locator('.streaming-markdown-pending')).toHaveCount(0);
  expect(await markdown.innerText()).toContain('It costs $5.');
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`shows stable pending link and document dots with motion ${reducedMotion}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const markdown = page.locator(`${ROW} .rendered-markdown`);
    await expect(markdown).toHaveText('Starting...');
    await appendDeltaToRapidStreaming(page, '\n\nRead https://example.test/');
    const indicator = markdown.getByRole('img', { name: 'Streaming content' });
    await expect(indicator).toBeVisible();
    const original = await indicator.elementHandle();
    const before = await indicator.boundingBox();
    const animations = await indicator.evaluate((element) =>
      Array.from(element.children)
        .flatMap((dot) => dot.getAnimations())
        .map((animation) => ({
          state: animation.playState,
          iterations: animation.effect?.getTiming().iterations,
        }))
    );
    expect(animations).toHaveLength(reducedMotion === 'reduce' ? 0 : 3);
    if (reducedMotion === 'no-preference') {
      expect(
        animations.every(
          (animation) => animation.state === 'running' && animation.iterations === Infinity
        )
      ).toBe(true);
    }
    await appendDeltaToRapidStreaming(page, 'reference');
    await waitForAnimationFrames(page, 3);
    expect(await indicator.evaluate((element, old) => element === old, original)).toBe(true);
    const after = await indicator.boundingBox();
    expect(after?.width).toBe(before?.width);
    expect(after?.height).toBe(before?.height);
    expect(await markdown.innerText()).not.toContain('https://example.test');

    await appendDeltaToRapidStreaming(page, ' and docs/');
    await expect(markdown.locator('a[href="https://example.test/reference"]')).toBeVisible();
    await expect(indicator).toBeVisible();
    await appendDeltaToRapidStreaming(page, 'usage.md');
    await waitForAnimationFrames(page, 3);
    expect(await markdown.innerText()).not.toContain('docs/usage.md');
    await appendDeltaToRapidStreaming(page, ' ');
    await expect(indicator).toHaveCount(0);
    await expect(markdown.locator('a.file-path-link')).toContainText('usage.md');
    await original?.dispose();
  });
}

for (const numbered of [false, true]) {
  test(`keeps blank-separated ${numbered ? 'numbered' : 'bullet'} gaps fixed while the last item streams`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 441, height: 900 });
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const markdown = page.locator(`${ROW} .rendered-markdown`);
    await expect(markdown).toHaveText('Starting...');
    const marker = (index: number) => (numbered ? `${index}.` : '-');
    let text = `Starting...\n\n${marker(1)} Assert the smallest useful result. Overly broad snapshot comparisons can fail because of irrelevant formatting, while focused assertions identify the actual broken contract.\n\n${marker(2)} Error messages deserve tests when users or callers rely on them.`;
    await appendDeltaToRapidStreaming(page, text.slice('Starting...'.length));
    await expect(markdown).toContainText('callers rely on them.');
    const collector = await markdown.evaluateHandle((element) => {
      const state = { running: true, gaps: [] as number[] };
      const sample = () => {
        const items = element.querySelectorAll('li');
        for (let index = 1; index < items.length; index += 1) {
          state.gaps.push(
            items[index]!.getBoundingClientRect().top -
              items[index - 1]!.getBoundingClientRect().bottom
          );
        }
        if (state.running) requestAnimationFrame(sample);
      };
      sample();
      return state;
    });
    for (const delta of [
      ' Otherwise, assert stable error types or codes instead of fragile wording that may legitimately change.',
      `\n\n${marker(3)} Mutation testing evaluates whether tests detect deliberate code changes.`,
      ' Surviving mutations often reveal weak assertions, missing edge cases, or untested paths.',
      '\n\nFollowing paragraph.',
    ]) {
      text += delta;
      await appendDeltaToRapidStreaming(page, delta);
      await waitForAnimationFrames(page, 20);
    }
    await completeResponse(page, text);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await waitForAnimationFrames(page, 6);
    const gaps = await collector.evaluate((state) => {
      state.running = false;
      return state.gaps;
    });
    expect(gaps.length).toBeGreaterThan(5);
    expect(Math.max(...gaps) - Math.min(...gaps), JSON.stringify(gaps)).toBeLessThan(1);
    expect(gaps.at(-1)).toBeCloseTo(1, 0);
  });
}

for (const numbered of [false, true]) {
  test(`keeps nested ${numbered ? 'numbered' : 'bullet'} list spacing when later paragraphs make it loose`, async ({
    page,
  }) => {
    // ses_e160e10e0ffeIjl71mdZKf95SK: the indented paragraph changes already-painted
    // list text into <p> elements, which must not acquire top-level prose spacing.
    await page.setViewportSize({ width: 544, height: 900 });
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const markdown = page.locator(`${ROW} .rendered-markdown`);
    await expect(markdown).toHaveText('Starting...');
    const marker = (index: number) => (numbered ? `${index}.` : '-');
    let text = [
      'Starting...',
      '',
      '## Issues found before accepting external results',
      '',
      `${marker(1)} **Runtime measurement validation needs tightening.**${numbered ? ' Confirmed directly in [`Metrics.record()`](tests/fixtures/comparative-benchmark/metrics.ts:15):' : ''}`,
      '   - `usage: {}` becomes known zero input/output tokens.',
      '   - An unknown event kind can increment browser requests.',
    ].join('\n');
    await appendDeltaToRapidStreaming(page, text.slice('Starting...'.length));
    await expect(markdown.locator('li li')).toHaveCount(2);
    const collector = await markdown.evaluateHandle((element) => {
      const state = { running: true, gaps: [] as number[], paragraphWrappers: [] as boolean[] };
      const sample = () => {
        const nested = element.querySelector('li > ul');
        const item = nested?.parentElement;
        if (!nested || !item) throw new Error('Missing nested validation list');
        const prose = document.createRange();
        prose.setStart(item, 0);
        prose.setEndBefore(nested);
        // Measure glyphs, not the optional paragraph wrapper's line box.
        const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
        let lastText: Node | null = null;
        while (walker.nextNode()) {
          if (prose.intersectsNode(walker.currentNode) && walker.currentNode.textContent?.trim()) {
            lastText = walker.currentNode;
          }
        }
        if (!lastText) throw new Error('Missing prose before nested validation list');
        prose.selectNodeContents(lastText);
        const lines = [...prose.getClientRects()].filter((rect) => rect.height > 0);
        const bottom = Math.max(...lines.map((rect) => rect.bottom));
        state.gaps.push(nested.getBoundingClientRect().top - bottom);
        state.paragraphWrappers.push(item.firstElementChild?.tagName === 'P');
        if (state.running) requestAnimationFrame(sample);
      };
      sample();
      return state;
    });
    for (const delta of [
      '\n\n   Require strict event schemas and mandatory usage fields,',
      ' with negative tests through the dynamic adapter boundary.',
      `\n\n${marker(2)} **Adapter trust is not certification.**`,
      '\n\n   Adapters receive controller context containing expected outcomes.',
      '\n\nFollowing paragraph.',
    ]) {
      text += delta;
      await appendDeltaToRapidStreaming(page, delta);
      await waitForAnimationFrames(page, 6);
    }
    await completeResponse(page, text);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await waitForAnimationFrames(page, 6);
    const samples = await collector.evaluate((state) => {
      state.running = false;
      return { gaps: state.gaps, paragraphWrappers: state.paragraphWrappers };
    });
    await attachEvidence(test.info(), 'nested-list-spacing.json', JSON.stringify(samples));
    expect(samples.paragraphWrappers).toContain(false);
    expect(samples.paragraphWrappers).toContain(true);
    expect(samples.gaps.length).toBeGreaterThan(5);
    expect(
      Math.max(...samples.gaps) - Math.min(...samples.gaps),
      JSON.stringify(samples)
    ).toBeLessThan(1);
  });
}

test('keeps the Thinking gap fixed while a pending indicator holds growing content', async ({
  page,
}) => {
  await page.setViewportSize({ width: 464, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  const markdown = page.locator(`${ROW} .rendered-markdown`);
  await expect(markdown).toHaveText('Starting...');
  await appendDeltaToRapidStreaming(page, '\n\n- Last visible bullet.');
  await expect(markdown.locator('li')).toHaveText('Last visible bullet.');
  await appendDeltaToRapidStreaming(page, '\n\n`');
  await expect(markdown.getByRole('img', { name: 'Streaming content' })).toBeVisible();
  await waitForAnimationFrames(page, 6);
  await expect(page.locator('.interactive-loading-row .loading-indicator')).toBeVisible();
  const collector = await markdown.evaluateHandle((element) => {
    const state = { running: true, gaps: [] as number[] };
    const sample = () => {
      const item = element.querySelector('.streaming-markdown-indicator')?.closest('p');
      const thinking = document.querySelector('.interactive-loading-row .loading-verb');
      if (item && thinking) {
        state.gaps.push(thinking.getBoundingClientRect().top - item.getBoundingClientRect().bottom);
      }
      if (state.running) requestAnimationFrame(sample);
    };
    sample();
    return state;
  });
  for (const delta of ['npm', ' run', ' test']) {
    await appendDeltaToRapidStreaming(page, delta);
    await waitForAnimationFrames(page, 20);
  }
  await expect(page.locator('.interactive-loading-row .loading-indicator')).toBeVisible();
  const gaps = await collector.evaluate((state) => {
    state.running = false;
    return state.gaps;
  });
  expect(gaps.length).toBeGreaterThan(5);
  expect(Math.max(...gaps) - Math.min(...gaps), JSON.stringify(gaps)).toBeLessThan(1);
});

// Replay of ses_fd36df443ffe3uYRdWBz2pwPfb: a new streamed text item began with a bullet whose
// only content was an unfinished code span. The hidden token left an empty list item whose marker
// overflowed the item; the measured entrance held that overflow as height and released it at
// cleanup, clamping the bottom-followed transcript backward by 22 px.
for (const deltas of [
  ['There are two corrections needed, not just one guard:\n\n- `Open as Edi'],
  // Replay of an HTML-heavy v1 session: an empty bullet arrived before its unfinished code.
  ['There are two corrections needed, not just one guard:\n\n- ', '`Open as Edi'],
]) {
  test(`does not shrink an entering text item whose bullet holds incomplete inline code: ${deltas.length} deltas`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 486, height: 900 });
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    await expect(page.locator(`${ROW} .rendered-markdown`)).toHaveText('Starting...');
    const partID = `${MESSAGE_ID}-text-2`;
    const collector = await page.locator(ROW).evaluateHandle((row) => {
      const state = { running: true, heights: [] as number[], entering: 0 };
      const sample = () => {
        state.heights.push(row.getBoundingClientRect().height);
        if (row.querySelector('.measured-entrance-active')) state.entering += 1;
        if (state.running) requestAnimationFrame(sample);
      };
      sample();
      return state;
    });
    await page.evaluate(
      ({ sessionID, messageID, id }) => {
        window.postMessage(
          {
            type: 'server/event',
            payload: {
              type: 'message.part.updated',
              properties: {
                part: {
                  id,
                  sessionID,
                  messageID,
                  type: 'text',
                  text: '',
                  time: { start: Date.now() },
                },
              },
            },
          },
          '*'
        );
      },
      { sessionID: SESSION_ID, messageID: MESSAGE_ID, id: partID }
    );
    for (const delta of deltas) {
      await appendStreamingTextDelta(page, partID, delta);
      await waitForAnimationFrames(page, 12);
    }
    const entering = page.locator(`${ROW} [data-assistant-render-key] .rendered-markdown`).last();
    await expect(entering).toContainText('not just one guard:');
    await waitForAnimationFrames(page, 40);
    const state = await collector.evaluate((value) => {
      value.running = false;
      return value;
    });
    expect(state.entering).toBeGreaterThan(0);
    const reversals = state.heights.flatMap((height, index) =>
      index > 0 && height < state.heights[index - 1]! - 0.5
        ? [[state.heights[index - 1], height]]
        : []
    );
    expect(reversals, JSON.stringify(state.heights)).toEqual([]);
    // A bullet with no visible content must not paint an orphan marker.
    await expect(entering.locator('li:visible')).toHaveCount(0);
  });
}

test('keeps verification paragraph gaps fixed as inline emphasis streams and settles', async ({
  page,
}) => {
  await page.setViewportSize({ width: 464, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  const markdown = page.locator(`${ROW} .rendered-markdown`);
  await expect(markdown).toHaveText('Starting...');
  let text =
    'Starting...\n\n**Verification**\n\n- Build, lint, formatting, typecheck, and TypeScript suggestion checks passed.\n\nThe full AI-08 run could not start because AI-07 preparation exhausted its running-tool and control-visibility retries.';
  await appendDeltaToRapidStreaming(page, text.slice('Starting...'.length));
  await expect(markdown).toContainText('control-visibility retries.');
  const collector = await markdown.evaluateHandle(() => {
    const state = { running: true, listGaps: [] as number[], paragraphGaps: [] as number[] };
    const sample = () => {
      const element = document.querySelector(
        '[data-msg-id="message-rapid-assistant-streaming"] .rendered-markdown'
      );
      if (!element) throw new Error('Missing verification Markdown');
      const list = element.querySelector('ul');
      const paragraphs = [...element.querySelectorAll('p')];
      const report = paragraphs.find((p) => p.textContent?.startsWith('The full AI-08'));
      const cleanup = paragraphs.find((p) => p.textContent?.startsWith('Cleanup is complete:'));
      if (list && report)
        state.listGaps.push(
          report.getBoundingClientRect().top - list.getBoundingClientRect().bottom
        );
      if (report && cleanup)
        state.paragraphGaps.push(
          cleanup.getBoundingClientRect().top - report.getBoundingClientRect().bottom
        );
      if (state.running) requestAnimationFrame(sample);
    };
    sample();
    return state;
  });
  for (const delta of [
    ' Therefore, the full AI-suite result remains ',
    '**FAIL/blocked**',
    ', rather than a claimed complete pass.',
    '\n\nCleanup is complete: fixture restored, temporary session deleted, test editor/server stopped, and test credential copy removed.',
    ' Unrelated changes were preserved.',
    '\n\n[Fix and verification ledger](https://example.test/ledger)',
  ]) {
    text += delta;
    await appendDeltaToRapidStreaming(page, delta);
    await waitForAnimationFrames(page, 20);
  }
  await completeResponse(page, text);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await waitForAnimationFrames(page, 6);
  const samples = await collector.evaluate((state) => {
    state.running = false;
    return { listGaps: state.listGaps, paragraphGaps: state.paragraphGaps };
  });
  for (const [gaps, expected] of [
    [samples.listGaps, 8],
    [samples.paragraphGaps, 12],
  ] as const) {
    expect(gaps.length).toBeGreaterThan(5);
    expect(Math.max(...gaps) - Math.min(...gaps), JSON.stringify(samples)).toBeLessThan(1);
    expect(gaps.at(-1)).toBeCloseTo(expected, 0);
  }
});

test('hides streamed inline commands until the closing backtick arrives', async ({ page }) => {
  await page.setViewportSize({ width: 908, height: 720 });
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  const markdown = page.locator(`${ROW} .rendered-markdown`);
  await expect(markdown).toHaveText('Starting...');
  let text = 'Starting...\n\n**Verification**\n\n- Run ';
  await appendDeltaToRapidStreaming(page, text.slice('Starting...'.length));
  const commands = ['npm run test', 'npm run test:e2e', 'npm run lint'];
  for (const [index, command] of commands.entries()) {
    for (const delta of ['`', ...command.split(/(?= )/)]) {
      text += delta;
      await appendDeltaToRapidStreaming(page, delta);
      const pending = markdown.locator('.streaming-markdown-pending');
      await expect(pending).toHaveText('');
      await expect(pending).toBeVisible();
      await expect(pending).toHaveAttribute('aria-label', 'Streaming content');
      await expect(markdown.locator('code')).toHaveText(commands.slice(0, index));
      expect(await markdown.innerText()).not.toContain('`');
    }
    const delta = `\`, passed.${index < commands.length - 1 ? '\n- Run ' : ''}`;
    text += delta;
    await appendDeltaToRapidStreaming(page, delta);
    await expect(markdown.locator('code')).toHaveText(commands.slice(0, index + 1));
    await expect(markdown.locator('code').last()).toBeVisible();
    await expect(markdown.locator('.streaming-markdown-pending')).toHaveCount(0);
  }
  await completeResponse(page, text);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(markdown.locator('code')).toHaveText(commands);
  await expect(markdown.locator('.streaming-markdown-pending')).toHaveCount(0);
});

const INLINE_ICON_TABLE = [
  '| Screenshot | What the trace shows |',
  '|---|---|',
  '| [00002](./artifacts/00002.png), +5.6 ms | The compositor jumped 1,448 CSS px upward and submitted a frame with one missing tile at +2.8 ms. The main-thread `scroll` handler did not start until +14.1 ms. It ran for 100.6 ms, but text was already visible again at +18.3 ms. The slow handler delayed fresh paint; it did not trigger the first blank. |',
  '| [00005](./artifacts/00005.png) and [00006](./artifacts/00006.png), +133.8 and +140.9 ms | A 1,053 px downward jump was followed by missing-tile draws at +127.7 ms and +138.9 ms. The webview painted and activated a new layer tree by +144.0 ms. The text was back in [00007](./artifacts/00007.png) at +150.2 ms. |',
].join('\n');

test('aligns visible link icons in tables and prose', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 458, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter&theme=dark');
  const markdown = page.locator(`${ROW} .rendered-markdown`);
  await expect(markdown).toHaveText('Starting...');
  await completeResponse(
    page,
    [
      'In the [primary compositor trace](./artifacts/compositor-trace.json), times are relative to the first drag move.',
      '',
      INLINE_ICON_TABLE,
      '',
      'The [DOM samples](./artifacts/dom-evidence.json) show that mounted rows covered both destinations. See the [trace docs](https://example.test/docs).',
    ].join('\n')
  );
  const leading = markdown.locator('.link-leading-content');
  await expect(leading).toHaveCount(7);
  await page.evaluate(() => document.fonts.ready);

  for (const size of [13.5, 18]) {
    await markdown.evaluate((element, fontSize) => {
      if (!(element instanceof HTMLElement)) throw new Error('Missing Markdown element');
      element.style.fontSize = `${fontSize}px`;
    }, size);
    const offsets = await leading.evaluateAll(async (wrappers) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 96;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Missing icon measurement context');
      const measurements = [];
      for (const wrapper of wrappers) {
        const icon = wrapper.querySelector('img');
        const label = wrapper.querySelector('.link-leading-label');
        if (!icon || !label) throw new Error('Missing link icon or label');

        await icon.decode();
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(icon, 0, 0, canvas.width, canvas.height);
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        const lastPixel = data.findLastIndex((alpha, index) => index % 4 === 3 && alpha >= 128);
        if (lastPixel < 0) throw new Error('Link icon has no visible pixels');
        const inkBottom = Math.floor(lastPixel / (canvas.width * 4)) + 1;
        // A zero-size inline block sits on the label's first baseline.
        const marker = document.createElement('span');
        marker.style.cssText = 'display: inline-block; width: 0; height: 0;';
        label.prepend(marker);
        const baseline = marker.getBoundingClientRect().top;
        const iconBox = icon.getBoundingClientRect();
        marker.remove();
        measurements.push({
          offset: iconBox.top + (iconBox.height * inkBottom) / canvas.height - baseline,
          label: label.textContent,
          context: wrapper.closest('td') ? 'table cell' : 'prose',
        });
      }
      return measurements;
    });
    await markdown.screenshot({ path: testInfo.outputPath(`inline-icons-${size}px.png`) });
    for (const { offset, label, context } of offsets) {
      expect(
        Math.abs(offset),
        `${label} in ${context} at ${size}px (offset ${offset}px)`
      ).toBeLessThanOrEqual(1.25);
      if (context === 'table cell') {
        // Screenshot icons draw low in their box. At 1x, a whole-pixel miss shows as a full row.
        expect(
          Math.abs(offset),
          `${label} in ${context} at ${size}px (offset ${offset}px)`
        ).toBeLessThanOrEqual(0.1);
      }
    }
  }
});

test('paints screenshot icons close to the digits and at a consistent height', async ({
  browser,
  baseURL,
}, testInfo) => {
  // Retina rasterization exposes half-pixel dips that a 1x screenshot rounds away.
  const browserContext = await browser.newContext({
    baseURL,
    deviceScaleFactor: 2,
    viewport: { width: 458, height: 800 },
  });
  const page = await browserContext.newPage();
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter&theme=dark');
  const markdown = page.locator(`${ROW} .rendered-markdown`);
  await expect(markdown).toHaveText('Starting...');
  await completeResponse(page, INLINE_ICON_TABLE);
  const icons = markdown.locator('td img.file-path-icon');
  await expect(icons).toHaveCount(4);
  await icons.evaluateAll((images: HTMLImageElement[]) =>
    Promise.all(images.map((image) => image.decode()))
  );
  await page.evaluate(() => document.fonts.ready);
  await markdown.scrollIntoViewIfNeeded();

  const samples = [];
  // Different line positions exercise the raster rounding that DOM rectangles don't capture.
  for (const padding of [0, 0.25, 0.5, 0.75]) {
    await markdown.evaluate((element, top) => {
      if (!(element instanceof HTMLElement)) throw new Error('Missing Markdown element');
      element.style.paddingTop = `${top}px`;
    }, padding);
    const screenshot = await page.screenshot({
      path: testInfo.outputPath(`inline-icon-raster-${padding}.png`),
      scale: 'device',
    });
    const offsets = await markdown.evaluate(async (element, pixels) => {
      const screenshotImage = new Image();
      screenshotImage.src = `data:image/png;base64,${pixels}`;
      await screenshotImage.decode();
      const canvas = document.createElement('canvas');
      canvas.width = screenshotImage.width;
      canvas.height = screenshotImage.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Missing screenshot canvas');
      context.drawImage(screenshotImage, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const scale = window.devicePixelRatio;
      const inkBounds = (box: DOMRect) => {
        let left = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;
        for (let y = Math.floor(box.top * scale); y < Math.ceil(box.bottom * scale); y++) {
          for (let x = Math.floor(box.left * scale); x < Math.ceil(box.right * scale); x++) {
            // The screenshot uses the dark theme; both the blue label and teal icon have
            // a brighter green channel than the background or border.
            if ((data[(y * canvas.width + x) * 4 + 1] ?? 0) > 100) {
              left = Math.min(left, x);
              right = Math.max(right, x);
              bottom = Math.max(bottom, y);
            }
          }
        }
        if (left === Infinity) throw new Error(`No visible pixels in ${JSON.stringify(box)}`);
        return { left, right, bottom };
      };
      return Array.from(element.querySelectorAll('td .link-leading-content'), (wrapper) => {
        const icon = wrapper.querySelector('img');
        const label = wrapper.querySelector('.link-leading-label')?.firstChild;
        if (!icon || !(label instanceof Text)) throw new Error('Missing icon or label');
        const digit = document.createRange();
        digit.setStart(label, 0);
        digit.setEnd(label, 1);
        const iconInk = inkBounds(icon.getBoundingClientRect());
        const digitInk = inkBounds(digit.getBoundingClientRect());
        return {
          label: label.data,
          offset: iconInk.bottom - digitInk.bottom,
          gap: (digitInk.left - iconInk.right - 1) / scale,
        };
      });
    }, screenshot.toString('base64'));
    samples.push({ padding, offsets });
  }
  await browserContext.close();
  const offsets = samples.flatMap((sample) => sample.offsets.map((entry) => entry.offset));
  expect(new Set(offsets).size, JSON.stringify(samples)).toBe(1);
  // Ink below the digits reads as a sunken icon.
  expect(offsets[0], JSON.stringify(samples)).toBeLessThanOrEqual(0);
  const gaps = samples.flatMap((sample) => sample.offsets.map((entry) => entry.gap));
  expect(Math.min(...gaps), JSON.stringify(samples)).toBeGreaterThan(0);
  expect(Math.max(...gaps), JSON.stringify(samples)).toBeLessThanOrEqual(3);
});

test('keeps filename links inside narrow table cells throughout streaming and completion', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  const markdown = page.locator(`${ROW} .rendered-markdown`);
  await expect(markdown).toHaveText('Starting...');
  let text =
    'Starting...\n\n| Candidate | Files to cover | Benefit | Complication |\n|---|---|---|---|\n';
  await appendDeltaToRapidStreaming(page, text.slice('Starting...'.length));
  for (const row of [
    '| Gradle | `build.gradle.kts` | Java support | Build logic |\n',
    '| Conda | `environment.yml`, `environment.yaml` | Python support | Channels |\n',
  ]) {
    text += row;
    await appendDeltaToRapidStreaming(page, row);
    await expect(markdown.locator('tbody tr')).toHaveCount(text.includes('Conda') ? 2 : 1);
    const overflow = await markdown.locator('td .link-leading-content').evaluateAll((links) =>
      links.flatMap((link) => {
        const cell = link.closest('td')!;
        const box = link.getBoundingClientRect();
        const cellBox = cell.getBoundingClientRect();
        return box.right > cellBox.right - parseFloat(getComputedStyle(cell).paddingRight) + 1
          ? [link.textContent]
          : [];
      })
    );
    expect(overflow).toEqual([]);
    const orphanedIcons = await markdown.locator('td .link-leading-content').evaluateAll((links) =>
      links.flatMap((link) => {
        const icon = link.querySelector('.file-path-icon')!;
        const label = link.querySelector('.link-leading-label')!;
        const range = document.createRange();
        range.setStart(label.firstChild!, 0);
        range.setEnd(label.firstChild!, 1);
        return range.getBoundingClientRect().top > icon.getBoundingClientRect().bottom
          ? [label.textContent]
          : [];
      })
    );
    expect(orphanedIcons).toEqual([]);
  }
  await completeResponse(page, text);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(markdown.locator('thead th')).toHaveText([
    'Candidate',
    'Files to cover',
    'Benefit',
    'Complication',
  ]);
  await expect(markdown.locator('a.file-path-link')).toHaveText([
    'build.gradle.kts',
    'environment.yml',
    'environment.yaml',
  ]);
});

for (const fontSize of [13, 13.5]) {
  test(`keeps pending bullet spacing when its first token completes at ${fontSize}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 486, height: 900 });
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    await page.addStyleTag({ content: `.rendered-markdown { font-size: ${fontSize}px; }` });
    const markdown = page.locator(`${ROW} .rendered-markdown`);
    await expect(markdown).toHaveText('Starting...');
    await appendDeltaToRapidStreaming(
      page,
      '\n\nAdded coverage for valid empty shell environment values.\n\n- `bun test src/main/shell-env.test.ts'
    );
    await expect(markdown.getByRole('img', { name: 'Streaming content' })).toBeVisible();
    await waitForAnimationFrames(page, 12);
    const height = await markdown.evaluate((element) => element.getBoundingClientRect().height);
    const paragraphGap = () =>
      markdown
        .locator('p')
        .nth(1)
        .evaluate((element) => getComputedStyle(element).marginBottom);
    const gap = await paragraphGap();
    await appendDeltaToRapidStreaming(page, '`');
    await expect(markdown.locator('li code')).toHaveText('bun test src/main/shell-env.test.ts');
    expect(await paragraphGap()).toBe(gap);
    expect(
      await markdown.evaluate((element) => element.getBoundingClientRect().height)
    ).toBeGreaterThanOrEqual(height);
  });
}

test('keeps preceding content stable while a streamed HTML disclosure forms', async ({ page }) => {
  // Character-by-character playback intentionally waits four paint frames per delta.
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 486, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  const markdown = page.locator(`${ROW} .rendered-markdown`);
  await expect(markdown).toHaveText('Starting...');
  const collector = await markdown.evaluateHandle((element) => {
    const state = {
      running: true,
      samples: [] as Array<{ top: number; height: number; text: string | null; html: string }>,
    };
    const sample = () => {
      const anchor = element.querySelector('p');
      if (anchor)
        state.samples.push({
          top: anchor.getBoundingClientRect().top,
          height: element.getBoundingClientRect().height,
          text: element.textContent,
          html: element.innerHTML,
        });
      if (state.running) requestAnimationFrame(sample);
    };
    sample();
    return state;
  });
  const text =
    'Starting...\n\nAdded coverage for valid empty shell environment values.\n\n- `bun test src/main/shell-env.test.ts`: 5 passed\n- `bun run typecheck`: passed\n\n<details>\n<summary>Explored</summary>\n\nInspected `shell-env.ts`, its tests, related utility usage, and nearby state utilities. Reviewed the focused diff with `git diff --check`.\n\n</details>\n\nVFZ-TOOLS-END';
  for (let index = 'Starting...'.length; index < text.length; index += 1) {
    await appendDeltaToRapidStreaming(page, text.slice(index, index + 1));
    await waitForAnimationFrames(page, 4);
  }
  await completeResponse(page, text);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await waitForAnimationFrames(page, 10);
  const samples = await collector.evaluate((state) => {
    state.running = false;
    return state.samples;
  });
  const reversals = samples.filter(
    (sample, index) => index > 0 && sample.top - samples[index - 1]!.top > 2
  );
  await attachEvidence(
    test.info(),
    'disclosure-frames.json',
    JSON.stringify({ samples, reversals })
  );
  await expect(markdown).toContainText('Reviewed the focused diff with git diff --check.');
  await expect(markdown).toContainText('VFZ-TOOLS-END');
  expect(samples.length).toBeGreaterThan(20);
  expect(reversals).toEqual([]);
});

async function attachEvidence(testInfo: TestInfo, name: string, json: string) {
  const path = testInfo.outputPath(name);
  await writeFile(path, json);
  await testInfo.attach(name, { path, contentType: 'application/json' });
}

async function completeResponse(page: Page, finalText: string) {
  await page.evaluate(
    ({ sessionID, messageID, text }) => {
      const harness = (
        window as Window & {
          __varroE2E?: {
            getSessionMessages: (id: string) => Array<{ info: Message }>;
            updateMessageInfo: (info: Message) => void;
            updateMessagePart: (part: Part) => void;
            updateSessionStatus: (id: string, status: { type: 'idle' }) => void;
          };
        }
      ).__varroE2E;
      if (!harness) throw new Error('Missing E2E harness');
      const original = harness
        .getSessionMessages(sessionID)
        .find((entry) => entry.info.id === messageID)?.info;
      if (!original || original.role !== 'assistant')
        throw new Error('Missing streaming assistant');
      const info: Message = {
        ...original,
        time: { ...original.time, completed: Date.now() },
        finish: 'stop',
      };
      const part: Part = {
        id: `${messageID}-text-1`,
        sessionID,
        messageID,
        type: 'text',
        text,
      };
      harness.updateMessagePart(part);
      harness.updateMessageInfo(info);
      harness.updateSessionStatus(sessionID, { type: 'idle' });
      for (const payload of [
        { type: 'message.part.updated', properties: { part } },
        { type: 'message.updated', properties: { info } },
        { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } },
      ])
        window.postMessage({ type: 'server/event', payload }, '*');
    },
    { sessionID: SESSION_ID, messageID: MESSAGE_ID, text: finalText }
  );
}

test('restores offscreen formula semantics when editor screen-reader mode changes', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  await expect(page.locator(`${ROW} .rendered-markdown`)).toHaveText('Starting...');
  const formulaCount = 54;
  const text = Array.from(
    { length: formulaCount },
    (_, index) =>
      `### Formula ${index}\n\n$$\\frac{x_${index}^2 + 1}{\\sqrt{y}} = \\sum_{i=0}^{n} i$$`
  ).join('\n\n');
  await completeResponse(page, text);
  const math = page.locator(`${ROW} .katex-mathml`);
  await expect(math).toHaveCount(formulaCount);
  await page.evaluate(() => document.fonts.ready);
  await waitForAnimationFrames(page, 6);
  const cdp = await page.context().newCDPSession(page);
  const semantics = async () => {
    const tree: {
      nodes: Array<{ role?: { value?: string }; name?: { value?: string }; ignored: boolean }>;
    } = await cdp.send('Accessibility.getFullAXTree');
    return tree.nodes
      .filter((node) => node.role?.value?.startsWith('MathML'))
      .map((node) => ({ role: node.role?.value, name: node.name?.value, ignored: node.ignored }));
  };
  const geometry = () =>
    page.locator(ROW).evaluate((row) => {
      const bounds = row.getBoundingClientRect();
      return {
        height: bounds.height,
        text: row.textContent,
        formulas: [...row.querySelectorAll('.katex-html, .katex-html *')].map((element) => {
          const rect = element.getBoundingClientRect();
          return [rect.x - bounds.x, rect.y - bounds.y, rect.width, rect.height];
        }),
      };
    });
  // Standalone views do not receive VS Code's accessibility signal.
  await expect(math.first()).toHaveCSS('content-visibility', 'visible');
  const original = await semantics();
  expect(original.filter((node) => node.role === 'MathMLMath')).toHaveLength(formulaCount);
  const originalGeometry = await geometry();
  const expectOriginalGeometry = async () => {
    const current = await geometry();
    expect(current.height).toBe(originalGeometry.height);
    expect(current.text).toBe(originalGeometry.text);
    expect(current.formulas).toHaveLength(originalGeometry.formulas.length);
    // Transformed SVG bounds differ by floating-point rounding after a scroll.
    const deltas = current.formulas.flatMap((rect, index) =>
      rect.map((value, axis) => Math.abs(value - originalGeometry.formulas[index]![axis]!))
    );
    expect(Math.max(...deltas)).toBeLessThan(0.001);
  };
  await page.evaluate(() => {
    document.body.dataset.vscodeThemeId = 'Default Dark Modern';
  });
  await expect(math.first()).toHaveCSS('content-visibility', 'auto');
  await expectOriginalGeometry();
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await page.evaluate(() => document.body.classList.add('vscode-using-screen-reader'));
    await expect(math.first()).toHaveCSS('content-visibility', 'visible');
    await expect.poll(semantics).toEqual(original);
    await expectOriginalGeometry();
    // Fully unmount and remount the formula row with accessibility enabled.
    await page.locator('.interactive-list').hover();
    await page.mouse.wheel(0, -100000);
    await expect(page.locator(ROW)).toHaveCount(0);
    await page.mouse.wheel(0, 100000);
    await expect(math).toHaveCount(formulaCount);
    await expect.poll(semantics).toEqual(original);
    await expectOriginalGeometry();
    await page.evaluate(() => document.body.classList.remove('vscode-using-screen-reader'));
    await expect(math.first()).toHaveCSS('content-visibility', 'auto');
    await expectOriginalGeometry();
  }
  await cdp.detach();
});

for (const width of [1280, 390]) {
  test.describe(`Markdown prose append at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    for (const appendKind of ['plain', 'formatted', 'raw HTML']) {
      test(`preserves paragraph identity and selection with ${appendKind} append boundaries`, async ({
        page,
      }, testInfo) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
        const markdown = page.locator(`${ROW} .rendered-markdown`);
        await expect(markdown).toHaveText('Starting...');
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
        const paragraphs = ['Starting...', 'Selected prose stays connected.', 'Open tail'];
        await appendDeltaToRapidStreaming(page, `\n\n${paragraphs.slice(1).join('\n\n')}`);
        const stable = markdown.locator('[data-markdown-segment="stable"]');
        await expect(stable.locator('p')).toHaveText(paragraphs.slice(0, 2));
        const selected = await stable.locator('p').nth(1).elementHandle();
        if (!selected) throw new Error('Missing stable paragraph');
        await selected.evaluate((paragraph) => {
          const text = paragraph.firstChild;
          if (!text) throw new Error('Missing selectable prose');
          const selection = window.getSelection();
          const range = document.createRange();
          range.setStart(text, 0);
          range.setEnd(text, 14);
          selection?.removeAllRanges();
          selection?.addRange(range);
        });

        const evidence = [];
        for (let index = 0; index < 5; index += 1) {
          const appendedText = `Safe appended paragraph ${index} keeps earlier prose intact &amp; readable.`;
          paragraphs.push(appendedText);
          await appendDeltaToRapidStreaming(page, `\n\n${appendedText}`);
          await expect(markdown.locator('p')).toHaveText(
            paragraphs.map((text) => text.replace('&amp;', '&'))
          );
          const sample = await selected.evaluate((paragraph) => {
            const selection = window.getSelection();
            return {
              connected: paragraph.isConnected,
              sameParagraph:
                paragraph ===
                document.querySelectorAll(
                  '[data-msg-id="message-rapid-assistant-streaming"] [data-markdown-segment="stable"] p'
                )[1],
              selectedText: selection?.toString(),
              sameAnchor: selection?.anchorNode === paragraph.firstChild,
              sameFocus: selection?.focusNode === paragraph.firstChild,
              anchorOffset: selection?.anchorOffset,
              focusOffset: selection?.focusOffset,
            };
          });
          evidence.push(sample);
          expect(sample).toEqual({
            connected: true,
            sameParagraph: true,
            selectedText: 'Selected prose',
            sameAnchor: true,
            sameFocus: true,
            anchorOffset: 0,
            focusOffset: 14,
          });
        }

        if (appendKind !== 'plain') {
          const formatted =
            appendKind === 'formatted'
              ? '**Bold fallback** and `inline code`'
              : '<strong>Bold fallback</strong> and <code>inline code</code>';
          await appendDeltaToRapidStreaming(page, `\n\n${formatted}\n\nFinal tail`);
          paragraphs.push(formatted, 'Final tail');
          await expect(stable.locator('strong')).toHaveText('Bold fallback');
          await expect(stable.locator('code')).toHaveText('inline code');
          expect(await selected.evaluate((paragraph) => paragraph.isConnected)).toBe(
            appendKind === 'formatted'
          );
          if (appendKind === 'formatted') {
            expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
              'Selected prose'
            );
          }
        }
        await completeResponse(page, paragraphs.join('\n\n'));
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
        await waitForAnimationFrames(page, 6);
        await expect(markdown.locator('p')).toHaveText(
          paragraphs.map((text) =>
            text
              .replace('&amp;', '&')
              .replaceAll('**', '')
              .replaceAll('`', '')
              .replace(/<\/?(?:strong|code)>/g, '')
          )
        );
        await expect(markdown.locator('.streaming-markdown-pending')).toHaveCount(0);
        if (appendKind !== 'plain') {
          await expect(markdown.locator('strong')).toHaveText('Bold fallback');
          await expect(markdown.locator('code')).toHaveText('inline code');
        }
        await attachEvidence(
          testInfo,
          'append-identity.json',
          JSON.stringify({ width, appendKind, evidence, errors }, null, 2)
        );
        expect(errors).toEqual([]);
      });
    }

    test('keeps the detached visible anchor fixed and resumes bottom follow for new prose', async ({
      page,
    }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
      const list = page.locator('.interactive-list');
      await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
      await expect
        .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
        .toBeLessThan(15);
      await appendDeltaToRapidStreaming(page, '\n\nStable prose before detaching.\n\nOpen tail');
      await expect(page.locator(`${ROW} [data-markdown-segment="stable"]`)).toContainText(
        'Stable prose before detaching.'
      );
      await list.hover();
      await page.mouse.wheel(0, -480);
      await expect
        .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
        .toBeGreaterThan(300);
      await waitForAnimationFrames(page, 8);
      const anchor = await getVisibleMessageAnchor(list);

      // Start sampling before posting deltas so the first mutation frame is included.
      const watcher = await list.evaluateHandle((element, target) => {
        const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
          (candidate) => candidate.dataset.msgId === target.id
        );
        if (!row) throw new Error('Missing detached anchor');
        const state = { running: true, samples: [] as Array<{ connected: boolean; top: number }> };
        const sample = () => {
          state.samples.push({
            connected: row.isConnected,
            top: row.getBoundingClientRect().top - element.getBoundingClientRect().top,
          });
          if (state.running) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        return state;
      }, anchor);
      for (let index = 0; index < 5; index += 1) {
        const text = `Detached paragraph ${index} ${'New prose grows below the reader. '.repeat(8)}`;
        await appendDeltaToRapidStreaming(page, `\n\n${text}`);
        await expect(page.locator(ROW)).toContainText(text.trim());
        await waitForAnimationFrames(page, 4);
      }
      const samples = await watcher.evaluate((state) => {
        state.running = false;
        return state.samples;
      });
      await attachEvidence(
        testInfo,
        'detached-anchor.json',
        JSON.stringify({ width, anchor, samples }, null, 2)
      );
      expect(samples.length).toBeGreaterThan(20);
      expect(
        samples.every((sample) => sample.connected && Math.abs(sample.top - anchor.top) < 1.5)
      ).toBe(true);
      expect(
        (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom
      ).toBeGreaterThan(300);

      await page.mouse.wheel(0, 10000);
      await expect
        .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
        .toBeLessThan(15);
      const before = await getScrollMetrics(page, '.interactive-list');
      const followWatcher = await list.evaluateHandle((element) => {
        const state = { running: true, tops: [] as number[] };
        const sample = () => {
          state.tops.push(element.scrollTop);
          if (state.running) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        return state;
      });
      for (let index = 0; index < 5; index += 1) {
        const text = `Following paragraph ${index} ${'Fresh prose must stay in view. '.repeat(8)}`;
        await appendDeltaToRapidStreaming(page, `\n\n${text}`);
        await expect(page.locator(ROW)).toContainText(text.trim());
        // The viewport follows with the same bounded easing as standalone blocks.
        // Keep the bottom-distance contract while observing every intermediate frame.
        await expect
          .poll(
            () => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom),
            { timeout: 1500 }
          )
          .toBeLessThan(15);
      }
      const followTops = await followWatcher.evaluate((state) => {
        state.running = false;
        return state.tops;
      });
      expect(followTops.length).toBeGreaterThan(5);
      expect(
        followTops.every((top, index) => index === 0 || top >= followTops[index - 1]! - 1),
        JSON.stringify(followTops)
      ).toBe(true);
      const after = await getScrollMetrics(page, '.interactive-list');
      expect(after.scrollTop).toBeGreaterThan(before.scrollTop);
      expect(after.scrollHeight).toBeGreaterThan(before.scrollHeight);
      await attachEvidence(
        testInfo,
        'bottom-follow.json',
        JSON.stringify({ width, before, after, followTops, errors }, null, 2)
      );
      expect(errors).toEqual([]);
    });
  });
}
