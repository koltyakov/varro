import { expect, test } from '@playwright/test';
import { waitForAnimationFrames } from './helpers';

for (const scenario of [
  { frames: 0, concurrent: false, deferred: false },
  { frames: 1, concurrent: false, deferred: false },
  { frames: 12, concurrent: false, deferred: false },
  { frames: 0, concurrent: true, deferred: false },
  { frames: 0, concurrent: true, deferred: true },
]) {
  test(`ArrowUp owns streaming resize destination: ${JSON.stringify(scenario)}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    if (scenario.deferred) {
      // Reproduce the observed host ordering: layout changes, native key movement,
      // then resize notification before the keyboard destination's animation frame.
      await page.addInitScript(() => {
        let deferred = false;
        const pending: Array<() => void> = [];
        const NativeResizeObserver = window.ResizeObserver;
        window.ResizeObserver = class extends NativeResizeObserver {
          constructor(callback: ResizeObserverCallback) {
            super((entries, observer) => {
              if (deferred) pending.push(() => callback(entries, observer));
              else callback(entries, observer);
            });
          }
        };
        window.addEventListener('ai08-defer-resize', () => {
          deferred = true;
        });
        window.addEventListener(
          'resize',
          (event) => {
            if (deferred) event.stopImmediatePropagation();
          },
          true
        );
        window.addEventListener('ai08-release-resize', () => {
          if (!deferred) return;
          deferred = false;
          window.dispatchEvent(new Event('resize'));
          for (const deliver of pending.splice(0)) deliver();
        });
      });
    }
    await page.setViewportSize({ width: 720, height: 794 });
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&activeTurnCollapse=1'
    );
    const list = page.locator('.interactive-list');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await page
      .locator('[data-msg-id="message-diff-preview-assistant-59"] .assistant-activity-summary')
      .click();
    await waitForAnimationFrames(page, 12);
    await list.focus();
    await page.keyboard.press('End');
    await list.hover();
    await page.mouse.wheel(0, -266);
    await waitForAnimationFrames(page, 12);

    const observation = await list.evaluateHandle((element, concurrent) => {
      const sessionID = 'session-diff-preview-large-transcript';
      const messageID = 'message-diff-preview-active-step-7';
      const viewport = element.getBoundingClientRect();
      const resizeParagraphs = Array.from(
        element.querySelectorAll<HTMLElement>('[data-msg-id] .rendered-markdown p')
      ).filter((paragraph) => {
        const rect = paragraph.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
      let paragraphs: HTMLElement[] = [];
      const sample = (targets: HTMLElement[]) => ({
        tops: targets.map((paragraph) => paragraph.getBoundingClientRect().top),
        connected: targets.every((paragraph) => paragraph.isConnected),
        painted: targets.every((paragraph) => {
          const rect = paragraph.getBoundingClientRect();
          return document.elementsFromPoint(rect.left + 8, rect.top + 8).includes(paragraph);
        }),
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        width: element.clientWidth,
        mounted: element.querySelectorAll('[data-msg-id]').length,
      });
      const resizeSamples = [{ phase: 'before-first-resize', ...sample(resizeParagraphs) }];
      const mark = (phase: string) => resizeSamples.push({ phase, ...sample(resizeParagraphs) });
      const onResize = () => mark('resize-event');
      window.addEventListener('resize', onResize);
      const samples: ReturnType<typeof sample>[] = [];
      let before: ReturnType<typeof sample> | null = null;
      let after: ReturnType<typeof sample> | null = null;
      let chunks = 0;
      let resizeChunks = 0;
      let frame = 0;
      let raf = 0;
      const delta = (text: string) =>
        window.postMessage(
          {
            type: 'server/event',
            payload: {
              type: 'message.part.delta',
              properties: {
                sessionID,
                messageID,
                partID: `${messageID}-part-1`,
                field: 'text',
                delta: text,
              },
            },
          },
          '*'
        );
      const timer = concurrent
        ? setInterval(() => {
            delta(`\n\nResize stream ${resizeChunks++}. ${'Checking report output. '.repeat(3)}`);
            if (resizeChunks === 30) clearInterval(timer);
          }, 30)
        : undefined;
      const captureKey = (event: KeyboardEvent) => {
        if (event.key !== 'ArrowUp') return;
        mark('keydown-capture');
        paragraphs = Array.from(
          element.querySelectorAll<HTMLElement>('[data-msg-id] .rendered-markdown p')
        )
          .filter((paragraph) => {
            const rect = paragraph.getBoundingClientRect();
            return rect.top > viewport.top + 50 && rect.bottom < viewport.bottom - 50;
          })
          .slice(0, 2);
        before = sample(paragraphs);
      };
      const onKey = (event: KeyboardEvent) => {
        if (event.key !== 'ArrowUp') return;
        after = sample(paragraphs);
        window.dispatchEvent(new Event('ai08-release-resize'));
        const tick = () => {
          samples.push(sample(paragraphs));
          if (frame < 18 && frame % 2 === 0) {
            delta(
              `\n\nStream chunk ${chunks++}. ${'Checking report output while the file preview updates. '.repeat(24)}`
            );
          }
          if (frame === 2) {
            window.postMessage(
              {
                type: 'server/event',
                payload: {
                  type: 'message.part.updated',
                  properties: {
                    part: {
                      id: 'arrow-up-file-edit',
                      sessionID,
                      messageID,
                      type: 'tool',
                      callID: 'arrow-up-file-edit-call',
                      tool: 'edit',
                      state: {
                        status: 'completed',
                        input: {
                          filePath: 'src/report.ts',
                          oldString: 'export const ready = false;',
                          newString: Array.from(
                            { length: 40 },
                            (_, index) => `export const ready${index} = true;`
                          ).join('\n'),
                        },
                        output: 'Updated',
                        title: 'Update report',
                        metadata: {},
                        time: { start: 1, end: 2 },
                      },
                    },
                  },
                },
              },
              '*'
            );
          }
          if (++frame < 60) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      };
      document.addEventListener('keydown', captureKey, { capture: true, once: true });
      document.addEventListener('keydown', onKey, { once: true });
      return {
        mark,
        finish: () => {
          cancelAnimationFrame(raf);
          clearInterval(timer);
          window.removeEventListener('resize', onResize);
          document.removeEventListener('keydown', captureKey, true);
          document.removeEventListener('keydown', onKey);
          return {
            before,
            after,
            samples,
            chunks,
            resizeChunks,
            resizeSamples,
            ids: paragraphs.map(
              (paragraph) => paragraph.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId
            ),
            resizeIds: resizeParagraphs.map(
              (paragraph) => paragraph.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId
            ),
          };
        },
      };
    }, scenario.concurrent);
    if (scenario.deferred)
      await page.evaluate(() => window.dispatchEvent(new Event('ai08-defer-resize')));
    for (const width of [486, 720, 486]) {
      await observation.evaluate((value, nextWidth) => value.mark(`before-${nextWidth}`), width);
      await page.setViewportSize({ width, height: 794 });
      await observation.evaluate((value, nextWidth) => value.mark(`returned-${nextWidth}`), width);
      if (scenario.frames) await waitForAnimationFrames(page, scenario.frames);
    }
    await expect(list).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await waitForAnimationFrames(page, 64);
    const result = await observation.evaluate((value) => value.finish());
    await testInfo.attach('arrow-up-frames.json', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    await observation.dispose();
    expect(result.ids.length).toBeGreaterThan(0);
    expect(result.chunks).toBe(9);
    if (scenario.concurrent) expect(result.resizeChunks).toBe(30);
    expect(result.samples).toHaveLength(60);
    expect(result.before?.painted).toBe(true);
    expect(result.after?.painted).toBe(true);
    for (const [paragraph, top] of result.after!.tops.entries()) {
      expect(top - result.before!.tops[paragraph]!).toBeCloseTo(40, 0);
    }
    // Resize observations are diagnostic. Keyboard direction begins at keydown,
    // not at a geometry read taken between layout and its queued resize callback.
    for (const [index, sample] of result.samples.entries()) {
      expect(sample.connected).toBe(true);
      expect(sample.painted).toBe(true);
      expect(sample.mounted).toBeLessThan(50);
      for (const [paragraph, top] of sample.tops.entries()) {
        expect(
          top,
          `frame ${index}, paragraph ${paragraph}: ${JSON.stringify({ before: result.before, after: result.after, sample })}`
        ).toBeGreaterThanOrEqual(
          (result.samples[index - 1] ?? result.after!).tops[paragraph]! - 1.5
        );
        // Only the first paragraph owns the anchor; later paragraph spacing can
        // reconcile fractional row heights while retaining the per-frame bound.
        if (paragraph === 0)
          expect(top).toBeGreaterThanOrEqual(result.after!.tops[paragraph]! - 1.5);
      }
    }
    const last = result.samples.at(-1)!;
    expect(last.scrollHeight - result.before!.scrollHeight).toBeGreaterThan(2_772);
    expect(last.tops[0]! - result.before!.tops[0]!).toBeGreaterThanOrEqual(38.5);
    if (scenario.frames === 12) {
      const keyResizeSample = result.resizeSamples.find(
        (sample) => sample.phase === 'keydown-capture'
      )!;
      expect(
        Math.abs(keyResizeSample.tops[0]! - result.resizeSamples[0]!.tops[0]!)
      ).toBeLessThanOrEqual(1.5);
    }
  });
}
