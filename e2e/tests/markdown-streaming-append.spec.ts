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

for (const width of [1280, 390]) {
  test.describe(`Markdown prose append at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    for (const fallback of [false, true]) {
      test(`preserves paragraph identity and selection before ${fallback ? 'unsafe fallback' : 'safe completion'}`, async ({
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

        if (fallback) {
          await appendDeltaToRapidStreaming(
            page,
            '\n\n**Bold fallback** and `inline code`\n\nFinal tail'
          );
          paragraphs.push('**Bold fallback** and `inline code`', 'Final tail');
          await expect(stable.locator('strong')).toHaveText('Bold fallback');
          await expect(stable.locator('code')).toHaveText('inline code');
          expect(await selected.evaluate((paragraph) => paragraph.isConnected)).toBe(false);
        }
        await completeResponse(page, paragraphs.join('\n\n'));
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
        await waitForAnimationFrames(page, 6);
        await expect(markdown.locator('p')).toHaveText(
          paragraphs.map((text) =>
            text.replace('&amp;', '&').replaceAll('**', '').replaceAll('`', '')
          )
        );
        await expect(markdown.locator('.streaming-markdown-pending')).toHaveCount(0);
        if (fallback) {
          await expect(markdown.locator('strong')).toHaveText('Bold fallback');
          await expect(markdown.locator('code')).toHaveText('inline code');
        }
        await attachEvidence(
          testInfo,
          'append-identity.json',
          JSON.stringify({ width, fallback, evidence, errors }, null, 2)
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
      for (let index = 0; index < 5; index += 1) {
        const text = `Following paragraph ${index} ${'Fresh prose must stay in view. '.repeat(8)}`;
        await appendDeltaToRapidStreaming(page, `\n\n${text}`);
        await expect(page.locator(ROW)).toContainText(text.trim());
        await waitForAnimationFrames(page, 4);
        expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeLessThan(
          15
        );
      }
      const after = await getScrollMetrics(page, '.interactive-list');
      expect(after.scrollTop).toBeGreaterThan(before.scrollTop);
      expect(after.scrollHeight).toBeGreaterThan(before.scrollHeight);
      await attachEvidence(
        testInfo,
        'bottom-follow.json',
        JSON.stringify({ width, before, after, errors }, null, 2)
      );
      expect(errors).toEqual([]);
    });
  });
}
