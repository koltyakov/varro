/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Playwright serializes these browser callbacks, which deliberately inject partial harness and server-event payloads across the page boundary. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { WebviewMessage } from '../../src/shared/protocol';
import {
  getScrollMetrics,
  getStickyMessageAlignment,
  getVisibleMessageAnchor,
  installOuterScrollSentinel,
  sampleMessageTopAcrossFrames,
  waitForAnimationFrame,
  waitForAnimationFrames,
} from './helpers';

type PartialDiffProbe = {
  gate: boolean;
  pending: Map<string, () => void>;
  events: Array<{
    type: string;
    at: number;
    part?: string;
    trusted?: boolean;
    top: number;
    markerTop: number;
    precedingHold: number;
    precedingPreviews: number;
  }>;
  release: (step: number, file: number) => void;
  record: (type: string, part?: string, trusted?: boolean) => void;
};

type PartialDiffWindow = typeof window & { partialDiffProbe: PartialDiffProbe };

async function updateDiffPreview(
  page: Page,
  messageId: string,
  fileCount: number,
  completed = false
) {
  const patchText = [
    '*** Begin Patch',
    ...Array.from({ length: fileCount }, (_, index) =>
      [
        `*** Update File: src/async-report-${index}.ts`,
        '@@',
        `-export const value${index} = 'pending';`,
        `+export const value${index} = 'ready';`,
      ].join('\n')
    ),
    '*** End Patch',
  ].join('\n');
  await updateDiffPreviewWithPatch(page, messageId, patchText, completed);
}

async function updateExpandableDiffPreview(page: Page, messageId: string) {
  const patchText = [
    '*** Begin Patch',
    '*** Update File: src/expanded-report.ts',
    '@@',
    ...Array.from({ length: 30 }, (_, index) => `-export const oldValue${index} = ${index};`),
    ...Array.from({ length: 30 }, (_, index) => `+export const newValue${index} = ${index};`),
    '*** End Patch',
  ].join('\n');
  await updateDiffPreviewWithPatch(page, messageId, patchText);
}

function makeWideDiffPatch(lineCount: number) {
  return [
    '*** Begin Patch',
    '*** Update File: src/wide-report.ts',
    '@@',
    ...Array.from(
      { length: lineCount },
      (_, index) => `+export const value${index} = '${'wide content '.repeat(20)}';`
    ),
    '*** End Patch',
  ].join('\n');
}

async function updateDiffPreviewWithPatch(
  page: Page,
  messageId: string,
  patchText: string,
  completed = false
) {
  const partId = `${messageId}-patch`;

  await page.evaluate(
    ({ id, part, patch, complete }) => {
      const nextPart = {
        id: part,
        sessionID: 'session-diff-preview-large-transcript',
        messageID: id,
        type: 'tool' as const,
        callID: `${part}-call`,
        tool: 'apply_patch',
        state: {
          status: complete ? ('completed' as const) : ('running' as const),
          input: { patchText: patch },
          output: 'Done',
          title: 'apply_patch',
          metadata: {},
          time: { start: 1, end: complete ? 2 : undefined },
        },
      };
      const harnessWindow = window as typeof window & {
        __varroE2E?: { updateMessagePart?: (updatedPart: unknown) => void };
      };
      harnessWindow.__varroE2E?.updateMessagePart?.(nextPart);
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'message.part.updated',
            properties: {
              part: nextPart,
            },
          },
        },
        '*'
      );
    },
    { id: messageId, part: partId, patch: patchText, complete: completed }
  );
}

test.describe('diff preview anchoring', () => {
  for (const partialOlderResponse of [false, true]) {
    test(`preserves the native prose destination with ${partialOlderResponse ? 'one older detail already loaded' : 'all details still pending'}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 486, height: 794 });
      await page.clock.install();
      await page.goto(
        '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1&diffPreviewCompleted=1'
      );
      await expect(page.locator('.interactive-list')).toBeVisible();
      await page.evaluate(() => {
        const sessionID = 'session-diff-preview-large-transcript';
        const host = window as PartialDiffWindow & {
          __sendToExtension: (message: WebviewMessage) => void;
          __varroE2E: {
            getSessionMessages: (id: string) => Array<{ info: Record<string, unknown> }>;
            updateMessageInfo: (info: Record<string, unknown>) => void;
            updateMessagePart: (part: unknown) => void;
          };
        };
        const list = document.querySelector<HTMLElement>('.interactive-list')!;
        const probe: PartialDiffProbe = {
          gate: false,
          pending: new Map(),
          events: [],
          release(step, file) {
            const key = `${step}/${file}`;
            const respond = this.pending.get(key);
            if (!respond) throw new Error(`Missing pending detail ${key}`);
            this.pending.delete(key);
            respond();
          },
          record(type, part, trusted) {
            const preceding = list.querySelector<HTMLElement>(
              '[data-msg-id="message-partial-diff-1"]'
            );
            const marker = list.querySelector('[data-msg-id="message-partial-diff-2"] p');
            this.events.push({
              type,
              at: performance.now(),
              part,
              trusted,
              top: list.scrollTop,
              markerTop: marker
                ? marker.getBoundingClientRect().top - list.getBoundingClientRect().top
                : 0,
              precedingHold: Number.parseFloat(preceding?.style.minHeight ?? '') || 0,
              precedingPreviews:
                preceding?.querySelectorAll('.file-change-inline-diffs').length ?? 0,
            });
          },
        };
        host.partialDiffProbe = probe;
        const details = new Map<string, { key: string; part: unknown }>();
        const originalSend = host.__sendToExtension;
        host.__sendToExtension = (rawMessage: unknown) => {
          const message = rawMessage as WebviewMessage;
          if (message.type !== 'api/request') return originalSend(message);
          const detail = details.get(message.payload.path);
          if (!detail) return originalSend(message);
          const respond = () =>
            window.postMessage(
              { type: 'api/response', payload: { id: message.payload.id, data: detail.part } },
              '*'
            );
          if (probe.gate) probe.pending.set(detail.key, respond);
          else respond();
        };
        window.addEventListener(
          'message',
          (event: MessageEvent<{ type?: string; payload?: { data?: { id?: string } } }>) => {
            if (probe.gate && event.data?.type === 'api/response') {
              const id = event.data.payload?.data?.id;
              if (id?.startsWith('message-partial-diff-')) probe.record('response', id);
            }
          },
          true
        );
        list.addEventListener(
          'wheel',
          (event) => {
            if (probe.gate) probe.record('wheel', undefined, event.isTrusted);
          },
          { capture: true, passive: true }
        );
        list.addEventListener('scroll', (event) => {
          if (probe.gate) probe.record('scroll', undefined, event.isTrusted);
        });
        const template = host.__varroE2E.getSessionMessages(sessionID).at(-1)!.info;
        const emit = (type: string, properties: Record<string, unknown>) =>
          window.postMessage({ type: 'server/event', payload: { type, properties } }, '*');
        for (let step = 0; step < 4; step++) {
          const messageID = `message-partial-diff-${step}`;
          const info = { ...template, id: messageID, time: { created: Date.now() + step } };
          host.__varroE2E.updateMessageInfo(info);
          emit('message.updated', { info });
          const parts: unknown[] = [
            {
              id: `${messageID}-text`,
              messageID,
              sessionID,
              type: 'text',
              text: `Retained partial step ${step}.`,
            },
          ];
          for (let file = 0; file < 3; file++) {
            const filePath = `src/partial-${step}-${file}.ts`;
            const part = {
              id: `${messageID}-edit-${file}`,
              messageID,
              sessionID,
              type: 'tool',
              tool: 'edit',
              callID: `${messageID}-call-${file}`,
              state: {
                status: 'completed',
                input: {
                  filePath,
                  oldString: 'export const value = 0;',
                  newString: 'export const value = 1;',
                },
                output: 'Done',
                metadata: {},
                time: { start: 1, end: 2 },
              },
            };
            const deferred = `/partial-diff/${step}/${file}`;
            details.set(deferred, { key: `${step}/${file}`, part });
            parts.push({
              ...part,
              deferred,
              state: {
                ...part.state,
                input: {},
                metadata: {
                  files: [{ filePath, type: 'update', additions: 1, deletions: 1 }],
                },
              },
            });
          }
          for (const part of parts) {
            host.__varroE2E.updateMessagePart(part);
            emit('message.part.updated', { part });
          }
        }
      });
      const marker = page.locator('[data-msg-id="message-partial-diff-2"] p').first();
      const preceding = page.locator('[data-msg-id="message-partial-diff-1"]');
      await expect(
        page.locator('[data-msg-id="message-partial-diff-3"] .diff-view-file')
      ).toHaveCount(3);
      await waitForAnimationFrames(page, 20);
      const list = page.locator('.interactive-list');
      const box = await list.boundingBox();
      const markerBox = await marker.boundingBox();
      if (!box || !markerBox) throw new Error('Missing partial-response marker');
      await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
      await page.mouse.wheel(0, markerBox.y - box.y - 113);
      await waitForAnimationFrames(page, 30);
      const position = () =>
        marker.evaluate(
          (element) =>
            element.getBoundingClientRect().top -
            document.querySelector('.interactive-list')!.getBoundingClientRect().top
        );
      // The first large wheel can hydrate and round virtual rows. Correct that
      // setup drift natively before recording the destination under test.
      for (let attempt = 0; attempt < 2; attempt++) {
        const offset = (await position()) - 113;
        if (Math.abs(offset) <= 2) break;
        await page.mouse.wheel(0, offset);
        await waitForAnimationFrames(page, 20);
      }
      const before = await position();
      expect(Math.abs(before - 113)).toBeLessThanOrEqual(2);
      const showDiffs = (showFileDiffs: boolean) =>
        page.evaluate(
          (value) =>
            window.postMessage(
              {
                type: 'config/update',
                payload: {
                  desktopSessionPaneSide: 'left',
                  defaultPermissionMode: 'default',
                  chatFontSize: 13,
                  chatEditorFontSize: 12,
                  chatFontFamily: 'default',
                  showFileDiffs: value,
                },
              },
              '*'
            ),
          showFileDiffs
        );
      await showDiffs(false);
      await waitForAnimationFrames(page, 30);
      expect(Math.abs((await position()) - before)).toBeLessThanOrEqual(2);
      await page.evaluate(() => {
        (window as PartialDiffWindow).partialDiffProbe.gate = true;
      });
      await showDiffs(true);
      await expect
        .poll(() =>
          page.evaluate(() => (window as PartialDiffWindow).partialDiffProbe.pending.size)
        )
        .toBe(12);
      await expect(preceding.locator('.file-change-inline-diffs')).toHaveCount(0);
      // Freeze the next presentation callback, not response delivery or native input.
      // This makes the recorded response-between-frames ordering deterministic.
      const now = await page.evaluate(() => Date.now());
      await page.clock.pauseAt(now + 16);
      expect(Math.abs((await position()) - before)).toBeLessThanOrEqual(2);
      const inputScrollTop = await list.evaluate((element) => element.scrollTop);
      await page.evaluate(() => {
        (window as PartialDiffWindow).partialDiffProbe.events.length = 0;
      });
      if (partialOlderResponse) {
        await page.evaluate(() => (window as PartialDiffWindow).partialDiffProbe.release(0, 0));
        await expect(
          page.locator('[data-msg-id="message-partial-diff-0"] .file-change-inline-diffs')
        ).toHaveCount(1);
      }
      await page.mouse.wheel(0, -96);
      await expect
        // Hydration compensation can already have changed the live scrollTop.
        // Check native movement at receipt, before that correction, instead.
        .poll(() =>
          page.evaluate(
            () =>
              (window as PartialDiffWindow).partialDiffProbe.events.find(
                (event) => event.type === 'wheel' && event.trusted
              )?.top
          )
        )
        .toBe(inputScrollTop - 96);
      await page.clock.runFor(17);
      const afterInput = await position();
      // Never add another 96 to the passive wheel listener's already-scrolled rectangle.
      const expectedTop = before + 96;
      await page.evaluate(() => {
        (window as PartialDiffWindow).partialDiffProbe.record('after-input');
      });
      const samples = [afterInput];
      for (let step = 0; step < 4; step++) {
        for (let file = 0; file < 3; file++) {
          if (partialOlderResponse && step === 0 && file === 0) continue;
          await page.evaluate(
            ({ row, part }) => (window as PartialDiffWindow).partialDiffProbe.release(row, part),
            { row: step, part: file }
          );
          await expect(
            page.locator(`[data-msg-id="message-partial-diff-${step}"] .file-change-inline-diffs`)
          ).toHaveCount(file + 1);
          await page.clock.runFor(17);
          samples.push(await position());
        }
      }
      await page.clock.runFor(300);
      samples.push(await position());
      const events = await page.evaluate(
        () => (window as PartialDiffWindow).partialDiffProbe.events
      );
      await test.info().attach('partial-response-input-order', {
        body: JSON.stringify(
          { partialOlderResponse, before, expectedTop, samples, events },
          null,
          2
        ),
        contentType: 'application/json',
      });
      const wheel = events.find((event) => event.type === 'wheel' && event.trusted);
      const wheelIndex = events.findIndex((event) => event === wheel);
      const inputIndex = events.findIndex((event) => event.type === 'after-input');
      expect(wheel).toBeDefined();
      expect(wheel!.top).toBe(inputScrollTop - 96);
      expect(wheel!.precedingHold).toBeGreaterThan(0);
      expect(wheel!.precedingPreviews).toBe(0);
      expect(
        events
          .slice(wheelIndex + 1, inputIndex)
          .some((event) => event.type === 'scroll' && event.trusted)
      ).toBe(true);
      expect(events.slice(0, wheelIndex).filter((event) => event.type === 'response')).toEqual(
        partialOlderResponse
          ? [expect.objectContaining({ part: 'message-partial-diff-0-edit-0' })]
          : []
      );
      const precedingResponses = events
        .map((event, index) => ({ event, index }))
        .filter(
          ({ event }) =>
            event.type === 'response' && event.part?.startsWith('message-partial-diff-1-')
        );
      expect(precedingResponses).toHaveLength(3);
      expect(precedingResponses.every(({ index }) => index > inputIndex)).toBe(true);
      expect(await preceding.evaluate((element) => element.style.minHeight)).toBe('');
      await page.clock.resume();
      if (partialOlderResponse) {
        await test.info().attach('partial-response-settled', {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
      }
      expect(
        samples.every((top) => Math.abs(top - expectedTop) <= 2),
        JSON.stringify({ expectedTop, samples })
      ).toBe(true);
    });
  }

  for (const input of [
    { delay: 100, delta: -32 },
    { delay: 0, delta: -96 },
    { delay: 100, delta: -96 },
    { delay: 100, delta: -180 },
    { delay: 100, delta: -96, edge: 'overlay' },
    { delay: 100, delta: -96, edge: 'solid' },
  ]) {
    test(`preserves painted prose when the preceding visible diff tail is removed, wheel ${input.delta} after ${input.delay}ms${'edge' in input ? ` at the painted ${input.edge} edge` : ''}`, async ({
      page,
    }) => {
      const edge = 'edge' in input ? input.edge : undefined;
      const edgeSelector =
        edge === 'solid'
          ? '.latest-user-message-sticky-bottom-solid'
          : '.latest-user-message-sticky-overlay';
      await page.setViewportSize({ width: 486, height: 794 });
      await page.goto(
        '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1&diffPreviewCompleted=1'
      );
      await expect(page.locator('.interactive-list')).toBeVisible();
      await page.evaluate((extraTail) => {
        const sessionID = 'session-diff-preview-large-transcript';
        const host = window as typeof window & {
          __sendToExtension: (message: WebviewMessage) => void;
          __diffTailPending: number;
          __diffTailGate: boolean;
          __releaseDiffTailResponses: () => void;
          __varroE2E: {
            getSessionMessages: (id: string) => Array<{ info: Record<string, unknown> }>;
            updateMessageInfo: (info: Record<string, unknown>) => void;
            updateMessagePart: (part: unknown) => void;
          };
        };
        const originalSend = host.__sendToExtension;
        const details = new Map<string, { part: unknown; delay: number }>();
        host.__diffTailPending = 0;
        host.__diffTailGate = false;
        const queuedResponses: Array<() => void> = [];
        host.__releaseDiffTailResponses = () => {
          host.__diffTailGate = false;
          for (const respond of queuedResponses.splice(0)) respond();
        };
        host.__sendToExtension = (rawMessage: unknown) => {
          const message = rawMessage as WebviewMessage;
          if (message.type !== 'api/request') return originalSend(message);
          const detail = details.get(message.payload.path);
          if (!detail) return originalSend(message);
          host.__diffTailPending++;
          setTimeout(() => {
            const respond = () => {
              host.__diffTailPending--;
              window.postMessage(
                {
                  type: 'api/response',
                  payload: { id: message.payload.id, data: detail.part },
                },
                '*'
              );
            };
            if (host.__diffTailGate) queuedResponses.push(respond);
            else respond();
          }, detail.delay);
        };
        const template = host.__varroE2E.getSessionMessages(sessionID).at(-1)!.info;
        const emit = (type: string, properties: Record<string, unknown>) =>
          window.postMessage({ type: 'server/event', payload: { type, properties } }, '*');
        for (let step = 0; step < (extraTail ? 5 : 4); step++) {
          const messageID = `message-diff-tail-step-${step}`;
          const info = { ...template, id: messageID, time: { created: Date.now() + step } };
          host.__varroE2E.updateMessageInfo(info);
          emit('message.updated', { info });
          const text = {
            id: `${messageID}-text`,
            messageID,
            sessionID,
            type: 'text',
            text: `Retained step ${step}.`,
          };
          const patch = {
            id: `${messageID}-patch`,
            messageID,
            sessionID,
            type: 'tool',
            tool: 'apply_patch',
            callID: `${messageID}-call`,
            state: {
              status: 'completed',
              input: {
                patchText: [
                  '*** Begin Patch',
                  ...Array.from({ length: 3 }, (_, file) =>
                    [
                      `*** Update File: src/tail-${file}.ts`,
                      '@@',
                      '-export const oldValue = 0;',
                      '+export const newValue = 1;',
                    ].join('\n')
                  ),
                  '*** End Patch',
                ].join('\n'),
              },
              output: 'Done',
              metadata: {},
              time: { start: 1, end: 2 },
            },
          };
          const deferred = `/diff-tail/${step}`;
          details.set(deferred, { part: patch, delay: 350 + step * 35 });
          const summary = {
            ...patch,
            deferred,
            state: {
              ...patch.state,
              input: {},
              metadata: {
                files: Array.from({ length: 3 }, (_, file) => ({
                  filePath: `src/tail-${file}.ts`,
                  type: 'update',
                  additions: 1,
                  deletions: 1,
                })),
              },
            },
          };
          for (const part of [text, summary]) {
            host.__varroE2E.updateMessagePart(part);
            emit('message.part.updated', { part });
          }
        }
      }, !!edge);
      const marker = page.locator('[data-msg-id="message-diff-tail-step-2"] p').first();
      await expect(
        page.locator(`[data-msg-id="message-diff-tail-step-${edge ? 4 : 3}"] .diff-view-file`)
      ).toHaveCount(3);
      await waitForAnimationFrames(page, 20);
      const list = page.locator('.interactive-list');
      const box = await list.boundingBox();
      const markerBox = await marker.boundingBox();
      if (!box || !markerBox) throw new Error('Missing retained diff-tail marker');
      let targetTop = 113;
      if (edge) {
        const overlay = await page.locator(edgeSelector).boundingBox();
        if (!overlay) throw new Error('Missing sticky overlay edge');
        targetTop = Math.ceil(overlay.y + overlay.height - box.y) + 2;
      }
      await page.mouse.move(edge ? box.x + box.width - 4 : box.x + 8, box.y + box.height / 2);
      await page.mouse.wheel(0, markerBox.y - box.y - targetTop);
      await waitForAnimationFrames(page, 30);
      if (edge) {
        // Native scrolling can first change the sticky prompt's measured height.
        // Establish the edge against that settled overlay, not its prior geometry.
        for (let attempt = 0; attempt < 2; attempt++) {
          const markerTop = await marker.evaluate((element) => element.getBoundingClientRect().top);
          const overlay = await page.locator(edgeSelector).boundingBox();
          if (!overlay) throw new Error('Missing sticky overlay after native scroll');
          const clearance = markerTop - overlay.y - overlay.height;
          if (clearance > 0 && clearance < 8) break;
          await page.mouse.wheel(0, clearance - 2);
          await waitForAnimationFrames(page, 20);
        }
      }
      const before = await marker.evaluate((element) => element.getBoundingClientRect().top);
      expect(before - box.y).toBeGreaterThan(8);
      expect(before - box.y).toBeLessThan(box.height - 40);
      if (edge) {
        const overlay = await page.locator(edgeSelector).boundingBox();
        if (!overlay) throw new Error('Missing settled sticky overlay');
        const clearance = before - overlay.y - overlay.height;
        expect(clearance).toBeGreaterThan(0);
        expect(clearance).toBeLessThan(8);
        if (edge === 'solid') {
          const fade = await page.locator('.latest-user-message-sticky-bottom-fade').boundingBox();
          if (!fade) throw new Error('Missing translucent sticky fade');
          expect(before).toBeLessThan(fade.y + fade.height);
        }
        await test.info().attach('painted-sticky-edge', {
          body: JSON.stringify({ edge, before, overlay, clearance }),
          contentType: 'application/json',
        });
      }
      for (const [index, showFileDiffs] of [false, true, false, true].entries()) {
        if (index === 3) {
          await page.evaluate(() => {
            (window as typeof window & { __diffTailGate: boolean }).__diffTailGate = true;
          });
        }
        await page.evaluate(
          (value) =>
            window.postMessage(
              {
                type: 'config/update',
                payload: {
                  desktopSessionPaneSide: 'left',
                  defaultPermissionMode: 'default',
                  chatFontSize: 13,
                  chatEditorFontSize: 12,
                  chatFontFamily: 'default',
                  showFileDiffs: value,
                },
              },
              '*'
            ),
          showFileDiffs
        );
        let expectedTop = before;
        let trackedMarker = marker;
        let wheelEvidence: string | undefined;
        if (index === 3) {
          // A newer native destination must win while the same details are pending.
          if (input.delay > 0) await page.waitForTimeout(input.delay);
          expect(
            await page.evaluate(
              () => (window as typeof window & { __diffTailPending: number }).__diffTailPending
            )
          ).toBeGreaterThan(0);
          await expect(
            page.locator('[data-msg-id="message-diff-tail-step-1"] .file-change-inline-diffs')
          ).toHaveCount(0);
          await page.mouse.wheel(0, input.delta);
          await waitForAnimationFrames(page, 2);
          const nativeTop = await marker.evaluate((element) => element.getBoundingClientRect().top);
          expect(Math.abs(nativeTop - before + input.delta)).toBeLessThanOrEqual(2);
          const precedingMarker = page
            .locator('[data-msg-id="message-diff-tail-step-1"] p')
            .first();
          const visibility = await precedingMarker.evaluate((element) => {
            const list = document.querySelector('.interactive-list')!;
            const sticky = list.querySelector('.latest-user-message-sticky-overlay')!;
            return {
              precedingTop: element.getBoundingClientRect().top,
              stickyBottom: sticky.getBoundingClientRect().bottom,
            };
          });
          if (input.delta === -180) {
            // Once genuinely exposed, the earlier paragraph may own the new destination.
            expect(visibility.precedingTop).toBeGreaterThan(visibility.stickyBottom + 8);
            trackedMarker = precedingMarker;
          } else if (input.delta === -96) {
            expect(visibility.precedingTop).toBeLessThan(visibility.stickyBottom);
          }
          expectedTop = await trackedMarker.evaluate(
            (element) => element.getBoundingClientRect().top
          );
          wheelEvidence = JSON.stringify({ input, before, nativeTop, expectedTop, visibility });
        }
        const samples = await trackedMarker.evaluate(async (element, release) => {
          const tops: number[] = [element.getBoundingClientRect().top];
          if (release) {
            (
              window as typeof window & { __releaseDiffTailResponses: () => void }
            ).__releaseDiffTailResponses();
          }
          for (let frame = 0; frame < 60; frame++) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            tops.push(element.getBoundingClientRect().top);
          }
          return tops;
        }, index === 3);
        if (wheelEvidence) {
          await test.info().attach('pending-wheel-anchor', {
            body: wheelEvidence,
            contentType: 'application/json',
          });
        }
        expect(
          samples.every((top) => Math.abs(top - expectedTop) <= 2),
          JSON.stringify(samples)
        ).toBe(true);
        const previews = page.locator(
          '[data-msg-id="message-diff-tail-step-2"] .file-change-inline-diffs'
        );
        if (showFileDiffs) await expect(previews).not.toHaveCount(0);
        else await expect(previews).toHaveCount(0);
      }
    });
  }

  test('keeps the painted running diff through deferred completion hydration', async ({ page }) => {
    await page.setViewportSize({ width: 486, height: 794 });
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    await expect(page.locator('.interactive-list')).toBeVisible();
    const id = 'message-diff-completion';
    await page.evaluate((messageID) => {
      const sessionID = 'session-diff-preview-large-transcript';
      const host = window as typeof window & {
        __varroE2E: {
          getSessionMessages: (id: string) => Array<{ info: Record<string, unknown> }>;
          updateMessageInfo: (info: Record<string, unknown>) => void;
          updateSessionStatus: (id: string, status: { type: 'busy' }) => void;
        };
      };
      const info = {
        ...host.__varroE2E.getSessionMessages(sessionID).at(-1)!.info,
        id: messageID,
        finish: undefined,
        time: { created: Date.now() },
      };
      host.__varroE2E.updateMessageInfo(info);
      host.__varroE2E.updateSessionStatus(sessionID, { type: 'busy' });
      for (const payload of [
        { type: 'message.updated', properties: { info } },
        { type: 'session.status', properties: { sessionID, status: { type: 'busy' } } },
      ])
        window.postMessage({ type: 'server/event', payload }, '*');
    }, id);
    await updateDiffPreview(page, id, 2);
    const row = page.locator(`[data-msg-id="${id}"]`);
    await expect(row.locator('.file-change-inline-diffs').last()).toContainText('ready');
    await waitForAnimationFrames(page, 30);
    const result = await page.evaluate(async (messageID) => {
      const host = window as typeof window & {
        __sendToExtension: (message: WebviewMessage) => void;
        __varroE2E: { updateMessagePart: (part: unknown) => void };
      };
      const selector = `[data-msg-id="${messageID}"] .file-change-inline-diffs`;
      const originalNode = [...document.querySelectorAll(selector)].at(-1)!;
      const original = host.__sendToExtension;
      const deferred = '/completion-diff-details';
      let responseAt = 0;
      const requests: string[] = [];
      const part = {
        id: `${messageID}-patch`,
        messageID,
        sessionID: 'session-diff-preview-large-transcript',
        type: 'tool',
        tool: 'apply_patch',
        callID: `${messageID}-patch-call`,
        state: {
          status: 'completed',
          input: {},
          output: 'Done',
          title: 'apply_patch',
          metadata: {
            files: [0, 1].map((index) => ({
              filePath: `src/async-report-${index}.ts`,
              type: 'update',
              additions: 1,
              deletions: 1,
            })),
          },
          deferredFiles: [0, 1].map((index) => ({
            kind: 'edited',
            path: `src/async-report-${index}.ts`,
            dedupeKey: `edited:src/async-report-${index}.ts`,
            additions: 1,
            deletions: 1,
          })),
          time: { start: 1, end: 2 },
        },
      };
      host.__sendToExtension = (rawMessage: unknown) => {
        const message = rawMessage as WebviewMessage;
        if (message.type !== 'api/request' || message.payload.path !== deferred)
          return original(message);
        requests.push(message.payload.path);
        setTimeout(() => {
          responseAt = performance.now();
          window.postMessage(
            {
              type: 'api/response',
              payload: {
                id: message.payload.id,
                data: {
                  ...part,
                  state: {
                    ...part.state,
                    deferredFiles: undefined,
                    input: {
                      patchText: [
                        '*** Begin Patch',
                        ...[0, 1].map(
                          (index) =>
                            `*** Update File: src/async-report-${index}.ts\n@@\n-export const value${index} = 'pending';\n+export const value${index} = 'confirmed';`
                        ),
                        '*** End Patch',
                      ].join('\n'),
                    },
                  },
                },
              },
            },
            '*'
          );
        }, 450);
      };
      const summary = { ...part, deferred };
      host.__varroE2E.updateMessagePart(summary);
      const startedAt = performance.now();
      window.postMessage(
        {
          type: 'server/event',
          payload: { type: 'message.part.updated', properties: { part: summary } },
        },
        '*'
      );
      const frames: Array<{ sameNode: boolean; files: number; painted: boolean }> = [];
      while (performance.now() - startedAt < 750) {
        await new Promise(requestAnimationFrame);
        const rect = originalNode.getBoundingClientRect();
        const viewport = document.querySelector('.interactive-list')!.getBoundingClientRect();
        frames.push({
          sameNode:
            originalNode.isConnected &&
            [...document.querySelectorAll(selector)].includes(originalNode),
          files: originalNode.querySelectorAll('.diff-view-file').length,
          painted: rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom,
        });
      }
      host.__sendToExtension = original;
      return {
        frames,
        delay: responseAt - startedAt,
        requests,
      };
    }, id);
    await test.info().attach('completion-diff-frames', {
      body: JSON.stringify(result),
      contentType: 'application/json',
    });
    expect(result.requests).toEqual(['/completion-diff-details']);
    expect(result.delay).toBeGreaterThanOrEqual(350);
    expect(result.frames.length).toBeGreaterThan(10);
    expect(
      result.frames.every((frame) => frame.sameNode && frame.files === 2 && frame.painted)
    ).toBe(true);
    await expect(row.locator('.file-change-inline-diffs').last()).toContainText('confirmed');
  });

  test('keeps deferred diff row heights and anchors through wheel remounts and detached toggles', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 486, height: 794 });
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1&diffPreviewTurns=60&diffPreviewInline=0&diffPreviewCompleted=1'
    );
    await page.evaluate(() => {
      const host = window as typeof window & {
        __sendToExtension: (message: WebviewMessage) => void;
        __varroE2E: {
          updateMessagePart: (part: unknown) => void;
          updateMessageInfo: (info: Record<string, unknown>) => void;
          getSessionMessages: (id: string) => Array<{ info: Record<string, unknown> }>;
        };
      };
      const original = host.__sendToExtension;
      const details = new Map<string, unknown>();
      const template = host.__varroE2E
        .getSessionMessages('session-diff-preview-large-transcript')
        .at(-1)!.info;
      host.__sendToExtension = (rawMessage: unknown) => {
        const message = rawMessage as WebviewMessage;
        if (message.type !== 'api/request' || !details.has(message.payload.path))
          return original(message);
        const { id, path } = message.payload;
        setTimeout(
          () =>
            window.postMessage(
              { type: 'api/response', payload: { id, data: details.get(path) } },
              '*'
            ),
          30
        );
      };
      for (let index = 0; index < 60; index++) {
        const messageID = `message-wheel-diff-${index}`;
        const info = {
          ...template,
          id: messageID,
          time: { created: Date.now() + index, completed: Date.now() + index + 1 },
        };
        host.__varroE2E.updateMessageInfo(info);
        window.postMessage(
          { type: 'server/event', payload: { type: 'message.updated', properties: { info } } },
          '*'
        );
        const deferred = `/wheel-diff/${index}`;
        const files = Array.from({ length: 4 }, (_, file) => ({
          filePath: `src/row-${index}-${file}.ts`,
          type: 'update',
          additions: 20,
          deletions: 1,
        }));
        const part = {
          id: `${messageID}-patch`,
          sessionID: 'session-diff-preview-large-transcript',
          messageID,
          type: 'tool',
          tool: 'apply_patch',
          callID: `${messageID}-patch-call`,
          state: {
            status: 'completed',
            input: {},
            output: 'Done',
            title: 'Edit',
            metadata: { files },
            time: { start: 1, end: 2 },
          },
        };
        details.set(deferred, {
          ...part,
          state: {
            ...part.state,
            input: {
              patchText: [
                '*** Begin Patch',
                ...files.map((file) =>
                  [
                    `*** Update File: ${file.filePath}`,
                    '@@',
                    '-const oldValue = 0;',
                    ...Array.from({ length: 20 }, (_, line) => `+const value${line} = ${line};`),
                  ].join('\n')
                ),
                '*** End Patch',
              ].join('\n'),
            },
            metadata: {},
          },
        });
        host.__varroE2E.updateMessagePart({ ...part, deferred });
        window.postMessage(
          {
            type: 'server/event',
            payload: {
              type: 'message.part.updated',
              properties: { part: { ...part, deferred } },
            },
          },
          '*'
        );
      }
    });
    await expect(
      page.locator('[data-msg-id="message-wheel-diff-59"] .file-change-card')
    ).toHaveCount(4);
    await waitForAnimationFrames(page, 12);
    await page.evaluate(() => {
      window.postMessage(
        {
          type: 'config/update',
          payload: {
            desktopSessionPaneSide: 'left',
            defaultPermissionMode: 'default',
            chatFontSize: 13,
            chatEditorFontSize: 12,
            chatFontFamily: 'default',
            showFileDiffs: true,
          },
        },
        '*'
      );
    });
    await expect(page.locator('.diff-view-widget').first()).toBeAttached();
    await waitForAnimationFrames(page, 30);
    const tracker = await page.evaluateHandle(() => {
      const loadedHeights = new Map<string, number>();
      const violations: Array<{ id: string; expected: number; actual: number }> = [];
      let frame = 0;
      const sample = () => {
        for (const row of document.querySelectorAll<HTMLElement>('[data-msg-id]')) {
          const id = row.dataset.msgId!;
          const height = row.getBoundingClientRect().height;
          if (row.querySelector('.diff-view-widget')) loadedHeights.set(id, Math.ceil(height));
          else if (
            loadedHeights.has(id) &&
            row.querySelector('.file-change-card') &&
            Math.abs(height - loadedHeights.get(id)!) > 1
          )
            violations.push({ id, expected: loadedHeights.get(id)!, actual: height });
        }
        frame = requestAnimationFrame(sample);
      };
      sample();
      return {
        finish: () => {
          cancelAnimationFrame(frame);
          return { violations, measured: loadedHeights.size };
        },
      };
    });
    const bounds = await page.locator('.interactive-list').boundingBox();
    if (!bounds) throw new Error('Missing transcript');
    await page.mouse.move(bounds.x + 8, bounds.y + 150);
    for (const delta of [-96, -180, -420, -2400, -2400, 2400, 2400, 420, 180, 96]) {
      await page.mouse.wheel(0, delta);
      await waitForAnimationFrames(page, 12);
    }
    const result = await tracker.evaluate((value) => value.finish());
    await tracker.dispose();
    expect(result.measured).toBeGreaterThan(5);
    expect(result.violations).toEqual([]);

    await page.mouse.wheel(0, -96);
    await waitForAnimationFrames(page, 30);
    const list = page.locator('.interactive-list');
    const clipped = await getVisibleMessageAnchor(list);
    // Keep the retained card's start visible, so removing preview lines does not remove the marker.
    await page.mouse.wheel(0, clipped.top + 1);
    await waitForAnimationFrames(page, 30);
    const anchor = await getVisibleMessageAnchor(list);
    expect(Math.abs(anchor.top)).toBeLessThanOrEqual(2);
    expect(await page.locator('.diff-view-widget').count()).toBeGreaterThan(0);
    const positions = sampleMessageTopAcrossFrames(list, anchor.id, 24);
    await page.evaluate(() => {
      window.postMessage(
        {
          type: 'config/update',
          payload: {
            desktopSessionPaneSide: 'left',
            defaultPermissionMode: 'default',
            chatFontSize: 13,
            chatEditorFontSize: 12,
            chatFontFamily: 'default',
            showFileDiffs: false,
          },
        },
        '*'
      );
    });
    await expect(page.locator('.diff-view-widget')).toHaveCount(0);
    const samples = await positions;
    expect(samples.every((top) => top !== null && Math.abs(top - anchor.top) <= 1)).toBe(true);
    const preservedTop = (await getScrollMetrics(page, '.interactive-list')).scrollTop;
    await page.mouse.wheel(0, -96);
    await waitForAnimationFrames(page, 12);
    const movedTop = (await getScrollMetrics(page, '.interactive-list')).scrollTop;
    expect(movedTop).toBeLessThan(preservedTop - 2);
    await waitForAnimationFrames(page, 12);
    expect((await getScrollMetrics(page, '.interactive-list')).scrollTop).toBe(movedTop);
  });

  test('positions delayed diff hydration immediately after enabling previews', async ({ page }) => {
    await page.setViewportSize({ width: 486, height: 794 });
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1&diffPreviewTurns=60&diffPreviewInline=0&diffPreviewCompleted=1'
    );
    const id = 'message-diff-preview-assistant-59';
    await page.evaluate((messageId) => {
      const host = window as typeof window & {
        __sendToExtension: (message: WebviewMessage) => void;
        __varroE2E: { updateMessagePart: (part: unknown) => void };
        releaseDiffDetails?: () => void;
      };
      const original = host.__sendToExtension;
      const part = {
        id: `${messageId}-patch`,
        sessionID: 'session-diff-preview-large-transcript',
        messageID: messageId,
        type: 'tool',
        callID: `${messageId}-patch-call`,
        tool: 'apply_patch',
        deferred: '/deferred-diff',
        state: {
          status: 'completed',
          input: {},
          output: 'Done',
          title: 'apply_patch',
          metadata: {
            files: Array.from({ length: 12 }, (_, index) => ({
              filePath: `src/deferred-${index}.ts`,
              type: 'update',
              additions: 20,
              deletions: 1,
            })),
          },
          time: { start: 1, end: 2 },
        },
      };
      host.__sendToExtension = (rawMessage: unknown) => {
        const message = rawMessage as WebviewMessage;
        if (message.type !== 'api/request' || message.payload.path !== '/deferred-diff')
          return original(message);
        host.releaseDiffDetails = () =>
          window.postMessage(
            {
              type: 'api/response',
              payload: {
                id: message.payload.id,
                data: {
                  ...part,
                  deferred: undefined,
                  state: {
                    ...part.state,
                    input: {
                      patchText: [
                        '*** Begin Patch',
                        ...Array.from({ length: 12 }, (_, index) =>
                          [
                            `*** Update File: src/deferred-${index}.ts`,
                            '@@',
                            '-const oldValue = 0;',
                            ...Array.from(
                              { length: 20 },
                              (_line, line) => `+const newValue${line} = ${line};`
                            ),
                          ].join('\n')
                        ),
                        '*** End Patch',
                      ].join('\n'),
                    },
                    metadata: {},
                  },
                },
              },
            },
            '*'
          );
      };
      host.__varroE2E.updateMessagePart(part);
    }, id);
    await expect(page.locator(`[data-msg-id="${id}"] .file-change-card`)).toHaveCount(12);
    await waitForAnimationFrames(page, 12);
    await page.evaluate(() =>
      window.postMessage(
        {
          type: 'config/update',
          payload: {
            desktopSessionPaneSide: 'left',
            defaultPermissionMode: 'default',
            chatFontSize: 13,
            chatEditorFontSize: 12,
            chatFontFamily: 'default',
            showFileDiffs: true,
          },
        },
        '*'
      )
    );
    // Outlast the old two-stable-frame/12-frame settle while the request is still pending.
    await page.waitForTimeout(350);
    const samples = await page.evaluate(async () => {
      const host = window as typeof window & { releaseDiffDetails?: () => void };
      if (!host.releaseDiffDetails) throw new Error('Diff detail request did not start');
      const list = document.querySelector<HTMLElement>('.interactive-list')!;
      host.releaseDiffDetails();
      const frames: Array<{ diffs: number; gap: number; reserve: number }> = [];
      for (let i = 0; i < 60; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        frames.push({
          diffs: list.querySelectorAll('.file-change-inline-diffs').length,
          gap: list.scrollHeight - list.clientHeight - list.scrollTop,
          reserve:
            list.querySelector<HTMLElement>('.append-scroll-bottom-reserve')?.offsetHeight ?? 0,
        });
      }
      return frames;
    });
    const hydrated = samples.filter((sample) => sample.diffs > 0);
    expect(hydrated.length).toBeGreaterThan(0);
    expect(
      hydrated.every((sample) => sample.gap <= 1 && sample.reserve === 0),
      JSON.stringify(samples)
    ).toBe(true);
    const row = page.locator(`[data-msg-id="${id}"]`);
    const loadedHeight = await row.evaluate((element) => element.getBoundingClientRect().height);
    const listBox = await page.locator('.interactive-list').boundingBox();
    if (!listBox) throw new Error('Missing transcript');
    await page.mouse.move(listBox.x + 8, listBox.y + 150);
    await page.mouse.wheel(0, -20_000);
    await expect(row).toHaveCount(0);
    await page.getByRole('button', { name: 'Scroll to latest message' }).click();
    await expect(row).toHaveCount(1);
    await waitForAnimationFrames(page, 12);
    await page.waitForTimeout(350);
    // The remounted summary must occupy the exact loaded height throughout the delayed request.
    expect(await row.evaluate((element) => element.getBoundingClientRect().height)).toBe(
      loadedHeight
    );
    await page.evaluate(() => {
      const host = window as typeof window & { releaseDiffDetails?: () => void };
      host.releaseDiffDetails?.();
    });
    await expect(row.locator('.diff-view-widget')).toHaveCount(1);
    await waitForAnimationFrames(page, 12);
    expect(await row.evaluate((element) => element.getBoundingClientRect().height)).toBe(
      loadedHeight
    );
  });

  for (const turnCount of [1, 60]) {
    for (const enabled of [false, true]) {
      test(`positions diff view immediately when ${enabled ? 'enabled' : 'disabled'} in ${turnCount} turns without trailing reserve`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 486, height: 794 });
        await page.goto(
          `/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1&diffPreviewTurns=${turnCount}&diffPreviewInline=0&diffPreviewCompleted=1`
        );
        const messageId = `message-diff-preview-assistant-${turnCount - 1}`;
        await updateDiffPreview(page, messageId, 12, true);
        await expect(page.locator(`[data-msg-id="${messageId}"] .file-change-card`)).toHaveCount(
          12
        );
        const setDiffView = async (showFileDiffs: boolean) =>
          page.evaluate((value) => {
            window.postMessage(
              {
                type: 'config/update',
                payload: {
                  desktopSessionPaneSide: 'left',
                  defaultPermissionMode: 'default',
                  chatFontSize: 13,
                  chatEditorFontSize: 12,
                  chatFontFamily: 'default',
                  showFileDiffs: value,
                },
              },
              '*'
            );
          }, showFileDiffs);
        await setDiffView(!enabled);
        const preview = page.locator(`[data-msg-id="${messageId}"] .file-change-inline-diffs`);
        await expect(preview).toHaveCount(enabled ? 0 : 1);
        await expect
          .poll(() =>
            getScrollMetrics(page, '.interactive-list').then((value) => value.distanceFromBottom)
          )
          .toBeLessThanOrEqual(1);
        await page.waitForTimeout(1_000);
        await waitForAnimationFrames(page, 12);

        const samples = await page.evaluate(
          async ({ value, id }) => {
            const list = document.querySelector<HTMLElement>('.interactive-list')!;
            window.postMessage(
              {
                type: 'config/update',
                payload: {
                  desktopSessionPaneSide: 'left',
                  defaultPermissionMode: 'default',
                  chatFontSize: 13,
                  chatEditorFontSize: 12,
                  chatFontFamily: 'default',
                  showFileDiffs: value,
                },
              },
              '*'
            );
            const result: Array<{
              visible: boolean;
              distance: number;
              reserve: number;
              height: number;
            }> = [];
            for (let frame = 0; frame < 18; frame += 1) {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              result.push({
                visible: !!list.querySelector(`[data-msg-id="${id}"] .file-change-inline-diffs`),
                distance: list.scrollHeight - list.clientHeight - list.scrollTop,
                height: list.scrollHeight,
                reserve:
                  list.querySelector<HTMLElement>('.append-scroll-bottom-reserve')?.offsetHeight ??
                  0,
              });
            }
            return result;
          },
          { value: enabled, id: messageId }
        );
        const changed = samples.filter((sample) => sample.visible === enabled);
        expect(changed.length).toBeGreaterThan(0);
        expect(
          changed.every((sample) => sample.distance <= 1),
          JSON.stringify(samples)
        ).toBe(true);
        expect(
          changed.every((sample) => sample.reserve === 0),
          JSON.stringify(samples)
        ).toBe(true);
      });
    }
  }

  test('upward wheel wins when a focused diff blurs before its scroll event', async ({ page }) => {
    await page.setViewportSize({ width: 486, height: 794 });
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    const list = page.locator('.interactive-list');
    const messageId = 'message-diff-preview-assistant-59';
    await updateDiffPreviewWithPatch(page, messageId, makeWideDiffPatch(8));
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((value) => value.distanceFromBottom)
      )
      .toBeLessThanOrEqual(1);
    const diff = page.locator(`[data-msg-id="${messageId}"] .diff-view-lines`);
    await diff.focus();
    await expect(diff).toBeFocused();
    await waitForAnimationFrames(page, 4);
    const before = await getScrollMetrics(page, '.interactive-list');
    // Reproduce a blur from a reflow/remount before the browser reports native wheel movement.
    await diff.evaluate((element) => {
      window.addEventListener('wheel', () => element.blur(), { capture: true, once: true });
    });
    const bounds = await list.boundingBox();
    await page.mouse.move(bounds!.x + 4, bounds!.y + bounds!.height / 2);
    expect(
      await page.evaluate(
        ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.interactive-list'),
        { x: bounds!.x + 4, y: bounds!.y + bounds!.height / 2 }
      )
    ).toBe(true);
    await page.mouse.wheel(0, -96);
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((value) => value.scrollTop))
      .toBeLessThan(before.scrollTop - 90);
    const anchor = await getVisibleMessageAnchor(list);
    const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 24);
    expect(
      samples.every((top) => top !== null && Math.abs(top - anchor.top) < 1.5),
      JSON.stringify({ anchor, samples })
    ).toBe(true);
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      90
    );
  });

  test('keeps a twelve-edit same-file and multi-file burst painted and ordered', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 486, height: 794 });
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();
    await waitForAnimationFrames(page, 12);
    const result = await page.evaluate(async () => {
      const sessionID = 'session-diff-preview-large-transcript';
      const messageID = 'message-diff-preview-burst';
      const host = window as typeof window & {
        __varroE2E: {
          getSessionMessages: (id: string) => Array<{ info: Record<string, unknown> }>;
          updateMessageInfo: (info: Record<string, unknown>) => void;
          updateMessagePart: (part: unknown) => void;
          updateSessionStatus: (id: string, status: { type: 'busy' }) => void;
        };
      };
      const info = {
        ...host.__varroE2E.getSessionMessages(sessionID).at(-1)!.info,
        id: messageID,
        finish: undefined,
        time: { created: Date.now() },
      };
      const emit = (type: string, properties: Record<string, unknown>) =>
        window.postMessage(
          {
            type: 'server/event',
            payload: { type, properties },
          },
          '*'
        );
      host.__varroE2E.updateMessageInfo(info);
      host.__varroE2E.updateSessionStatus(sessionID, { type: 'busy' });
      emit('message.updated', { info });
      emit('session.status', { sessionID, status: { type: 'busy' } });
      const times: number[] = [];
      const frames: Array<{ painted: boolean; duplicate: boolean }> = [];
      let stopped = false;
      const observe = () => {
        const transcript = document.querySelector<HTMLElement>('.interactive-list')!;
        const view = transcript.getBoundingClientRect();
        const rows = [...transcript.querySelectorAll<HTMLElement>('[data-msg-id]')];
        const keys = [...transcript.querySelectorAll('[data-assistant-render-key]')].map(
          (element) => element.getAttribute('data-assistant-render-key')
        );
        frames.push({
          painted: rows.some((row) => {
            const rect = row.getBoundingClientRect();
            return rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom;
          }),
          duplicate: new Set(keys).size !== keys.length,
        });
        if (!stopped) requestAnimationFrame(observe);
      };
      requestAnimationFrame(observe);
      for (let index = 0; index < 12; index++) {
        const id = `${messageID}-edit-${index}`;
        const fileCount = 1 + Math.floor(index / 3);
        const patchText = [
          '*** Begin Patch',
          ...Array.from({ length: fileCount }, (_, file) =>
            [
              `*** Update File: src/burst-${file}.ts`,
              '@@',
              `-export const value = 'burst-${index - 1}';`,
              `+export const value = 'burst-${index}';`,
            ].join('\n')
          ),
          '*** End Patch',
        ].join('\n');
        const part = {
          id,
          sessionID,
          messageID,
          type: 'tool',
          callID: `${id}-call`,
          tool: 'apply_patch',
          state: {
            status: 'completed',
            input: { patchText },
            output: 'Done',
            metadata: {},
            time: { start: index * 2 + 1, end: index * 2 + 2 },
          },
        };
        host.__varroE2E.updateMessagePart(part);
        times.push(performance.now());
        emit('message.part.updated', { part });
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
      }
      stopped = true;
      return { times, frames };
    });
    await test.info().attach('rapid-diff-edit-frames', {
      body: JSON.stringify(result),
      contentType: 'application/json',
    });
    expect(result.times).toHaveLength(12);
    expect(result.times.at(-1)! - result.times[0]!).toBeLessThan(1000);
    expect(result.frames.every((frame) => frame.painted && !frame.duplicate)).toBe(true);
    const row = page.locator('[data-msg-id="message-diff-preview-burst"]');
    await expect(row.locator('.file-change-inline-diffs')).toHaveCount(4);
    // Equal consecutive file sets coalesce; adding a file starts the next ordered stack.
    await expect(row.locator('.file-change-inline-diffs')).toContainText([
      'burst-2',
      'burst-5',
      'burst-8',
      'burst-11',
    ]);
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((value) => value.distanceFromBottom)
      )
      .toBeLessThanOrEqual(1);
  });

  for (const transition of ['completes', 'arrives'] as const) {
    test(`retains the same painted expanded diff when ${transition === 'completes' ? 'a second edit to the same file completes' : 'another edit to the same file arrives'}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 486, height: 794 });
      await page.goto(
        '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
      );
      const messageId = 'message-diff-preview-streaming-edits';
      const sendEdit = async (editIndex: number, completeEdit: boolean) => {
        await page.evaluate(
          ({ messageId: targetMessageId, editIndex: index, completed }) => {
            const sessionID = 'session-diff-preview-large-transcript';
            const harness = (
              window as typeof window & {
                __varroE2E: {
                  getSessionMessages: (id: string) => Array<{ info: Record<string, unknown> }>;
                  updateMessageInfo: (info: Record<string, unknown>) => void;
                  updateMessagePart: (part: unknown) => void;
                  updateSessionStatus: (id: string, status: { type: 'busy' }) => void;
                };
              }
            ).__varroE2E;
            const info = harness
              .getSessionMessages(sessionID)
              .find((entry) => entry.info.id === 'message-diff-preview-assistant-59')!.info;
            if (index === 0) {
              const activeInfo = {
                ...info,
                id: targetMessageId,
                finish: undefined,
                time: { created: Date.now() },
              };
              harness.updateMessageInfo(activeInfo);
              harness.updateSessionStatus(sessionID, { type: 'busy' });
              window.postMessage(
                {
                  type: 'server/event',
                  payload: {
                    type: 'message.updated',
                    properties: { info: activeInfo },
                  },
                },
                '*'
              );
              window.postMessage(
                {
                  type: 'server/event',
                  payload: {
                    type: 'session.status',
                    properties: { sessionID, status: { type: 'busy' } },
                  },
                },
                '*'
              );
            }
            const id = `${targetMessageId}-${index === 0 ? 'patch' : `edit-${index}`}`;
            const part = {
              id,
              sessionID,
              messageID: targetMessageId,
              type: 'tool',
              callID: `${id}-call`,
              tool: 'edit',
              state: {
                status: completed ? 'completed' : 'running',
                input: {
                  filePath: 'src/streaming-preview.css',
                  oldString: Array.from(
                    { length: 80 },
                    (_, i) => `.row-${i} { width: ${i}px; }`
                  ).join('\n'),
                  newString: Array.from(
                    { length: 80 },
                    (_, i) => `.row-${i} { width: ${i + index + 1}px; }`
                  ).join('\n'),
                },
                title: 'Edit preview',
                metadata: {},
                output: completed ? 'Updated' : undefined,
                time: completed ? { start: 2, end: 3 } : { start: 2 },
              },
            };
            harness.updateMessagePart(part);
            window.postMessage(
              {
                type: 'server/event',
                payload: {
                  type: 'message.part.updated',
                  properties: { part },
                },
              },
              '*'
            );
          },
          { messageId, editIndex, completed: completeEdit }
        );
      };
      await sendEdit(0, true);
      await sendEdit(1, false);
      await page.locator(`[data-msg-id="${messageId}"] .diff-view-toggle`).first().click();
      const overlay = page.locator('.diff-view-overlay');
      await expect(overlay).toBeVisible();
      await overlay.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations({ subtree: true }).map((animation) => animation.finished)
        );
      });
      const lines = overlay.locator('.diff-view-overlay-lines');
      await lines.hover();
      await page.mouse.wheel(0, 240);
      await expect.poll(() => lines.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
      await waitForAnimationFrames(page, 6);

      const observation = await overlay.evaluateHandle((element) => {
        const viewport = element.querySelector<HTMLElement>('.diff-view-overlay-lines')!;
        const before = { top: element.getBoundingClientRect().top, scrollTop: viewport.scrollTop };
        const samples: Array<{
          same: boolean;
          connected: boolean;
          opacity: string;
          visible: boolean;
          top: number;
          scrollTop: number;
        }> = [];
        let removed = false;
        let animations = 0;
        let frame = 0;
        const observer = new MutationObserver((records) => {
          removed ||= records.some((record) =>
            Array.from(record.removedNodes).some(
              (node) => node === element || node.contains(element)
            )
          );
        });
        observer.observe(document.body, { childList: true, subtree: true });
        const onAnimation = (event: AnimationEvent) => {
          if (event.target instanceof Element && event.target.closest('.diff-view-overlay'))
            animations += 1;
        };
        document.addEventListener('animationstart', onAnimation, true);
        const sample = () => {
          samples.push({
            same: document.querySelector('.diff-view-overlay') === element,
            connected: element.isConnected,
            opacity: getComputedStyle(element).opacity,
            visible:
              getComputedStyle(element).visibility === 'visible' &&
              element.getBoundingClientRect().height > 0,
            top: element.getBoundingClientRect().top,
            scrollTop: viewport.scrollTop,
          });
          frame = requestAnimationFrame(sample);
        };
        sample();
        return {
          finish: () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            document.removeEventListener('animationstart', onAnimation, true);
            return {
              before,
              samples,
              removed,
              animations,
            };
          },
        };
      });
      if (transition === 'arrives') await sendEdit(2, false);
      await sendEdit(1, true);
      await waitForAnimationFrames(page, 20);
      const result = await observation.evaluate((tracker) => tracker.finish());
      await observation.dispose();
      await test.info().attach('portal-continuity', {
        body: JSON.stringify(result),
        contentType: 'application/json',
      });
      expect(result.removed, JSON.stringify(result)).toBe(false);
      expect(result.samples.length).toBeGreaterThan(10);
      expect(
        result.samples.every(
          (sample) =>
            sample.same &&
            sample.connected &&
            sample.visible &&
            sample.opacity === '1' &&
            Math.abs(sample.top - result.before.top) < 1 &&
            Math.abs(sample.scrollTop - result.before.scrollTop) < 1
        ),
        JSON.stringify(result)
      ).toBe(true);
      expect(result.animations).toBe(0);
      await page.getByRole('button', { name: 'Close expanded diff' }).click();
      await expect(page.locator(`[data-msg-id="${messageId}"] .diff-view-file`)).toHaveCount(1);
      await expect(
        page.locator(`[data-msg-id="${messageId}"] .diff-view-file`).last()
      ).toContainText(`width: ${transition === 'arrives' ? 3 : 2}px`);
    });
  }

  test('keeps a detached row anchored and its diff visible when the active turn completes', async ({
    page,
  }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&activeTurnCollapse=1&expandedActivity=1'
    );
    const list = page.locator('.interactive-list');
    const editMessageId = 'message-diff-preview-assistant-59';
    const anchorMessageId = 'message-diff-preview-active-step-5';
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect(page.locator(`[data-msg-id="${editMessageId}"] .diff-view-file`)).toBeVisible();
    expect(
      await page.locator(`[data-msg-id="${editMessageId}"]`).evaluate((row) => {
        return getComputedStyle(row).contain;
      })
    ).toBe('layout style');
    expect(
      await page
        .locator(`[data-msg-id="${editMessageId}"] .diff-view-lines-content`)
        .evaluate((element) => getComputedStyle(element).willChange)
    ).toContain('contents');
    const anchorRow = page.locator(`[data-msg-id="${anchorMessageId}"]`);
    await anchorRow.scrollIntoViewIfNeeded();
    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 120);
      element.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(300);
    await waitForAnimationFrames(page, 4);
    const before = await getVisibleMessageAnchor(list, anchorMessageId);
    const beforeMetrics = await getScrollMetrics(page, '.interactive-list');
    expect(beforeMetrics.distanceFromBottom).toBeGreaterThan(100);

    await page.evaluate(() => {
      const sessionId = 'session-diff-preview-large-transcript';
      const finalMessageId = 'message-diff-preview-active-step-7';
      const harnessWindow = window as typeof window & {
        __varroE2E?: {
          getSessionMessages?: (id: string) => Array<{ info: Record<string, unknown> }>;
          updateMessageInfo?: (info: Record<string, unknown>) => void;
          updateSessionStatus?: (id: string, status: { type: 'idle' }) => void;
        };
      };
      const info = harnessWindow.__varroE2E
        ?.getSessionMessages?.(sessionId)
        .find((message) => message.info.id === finalMessageId)?.info;
      if (!info) throw new Error('Active turn final assistant is missing');
      info.time = { ...(info.time as Record<string, unknown>), completed: Date.now() };
      harnessWindow.__varroE2E?.updateMessageInfo?.(info);
      harnessWindow.__varroE2E?.updateSessionStatus?.(sessionId, { type: 'idle' });
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'session.status',
            properties: { sessionID: sessionId, status: { type: 'idle' } },
          },
        },
        '*'
      );
    });

    const samples = await sampleMessageTopAcrossFrames(list, before.id, 10);
    expect(
      samples.every((top) => top !== null && Math.abs(top - before.top) < 1.5),
      JSON.stringify({ before, beforeMetrics, samples })
    ).toBe(true);
    expect(await list.locator('[data-msg-id]').count()).toBeLessThan(50);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 4);
    const summary = page.locator(`[data-msg-id="${editMessageId}"] .assistant-activity-summary`);
    await expect(page.locator(`[data-msg-id="${editMessageId}"] .diff-view-file`)).toBeVisible();
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeLessThan(3);
    expect(await list.locator('[data-msg-id]').count()).toBeLessThan(50);

    const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
    await composer.fill('Make one more change');
    await page.getByLabel('Send (Enter)').click();

    await expect(page.locator('.chat-turn-user').last()).toContainText('Make one more change');
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
    await expect(summary).toContainText('Explored: 1 file');
    await expect(summary).not.toContainText('edit');
    await expect(page.locator(`[data-msg-id="${editMessageId}"] .diff-view-file`)).toBeVisible();
  });

  test('centers the expanded diff without blocking the composer', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    const messageId = 'message-diff-preview-assistant-59';
    await updateExpandableDiffPreview(page, messageId);

    await page
      .locator(`[data-msg-id="${messageId}"] .diff-view-toggle`)
      .evaluate((button) => (button as HTMLButtonElement).click());

    const overlay = page.locator('.diff-view-overlay');
    await expect(overlay).toBeVisible();

    const layout = await overlay.evaluate((element) => {
      const overlayRect = element.getBoundingClientRect();
      const panelRect = element
        .querySelector<HTMLElement>('.diff-view-overlay-panel')!
        .getBoundingClientRect();
      const composerRect = document
        .querySelector<HTMLElement>('.chat-input-container')!
        .getBoundingClientRect();
      const list = element
        .closest<HTMLElement>('.interactive-list-shell')
        ?.querySelector<HTMLElement>(':scope > .interactive-list');

      return {
        centerDelta:
          panelRect.top + panelRect.height / 2 - (overlayRect.top + overlayRect.height / 2),
        leftEdgeDelta: panelRect.left - composerRect.left,
        rightEdgeDelta: panelRect.right - composerRect.right,
        listFilter: list ? getComputedStyle(list).filter : '',
        listOpacity: list ? getComputedStyle(list).opacity : '',
      };
    });

    expect(Math.abs(layout.centerDelta)).toBeLessThan(1);
    expect(Math.abs(layout.leftEdgeDelta)).toBeLessThan(1);
    expect(Math.abs(layout.rightEdgeDelta)).toBeLessThan(1);
    expect(layout.listFilter).toBe('blur(40px)');
    expect(layout.listOpacity).toBe('0.1');
    await expect(overlay.locator('.diff-view-overlay-title .diff-view-icon')).toBeVisible();

    const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
    await composer.click();
    await composer.fill('Continue while reviewing this diff');
    await expect(composer).toBeFocused();
    await expect(composer).toHaveText('Continue while reviewing this diff');
    await expect(overlay).toBeVisible();

    const overlayFilename = overlay.locator('.diff-view-overlay-filename');
    await overlayFilename.click();
    await expect(overlay).toBeVisible();

    const headerGap = await overlay.locator('.diff-view-overlay-header').evaluate((header) => {
      const filenameRect = header
        .querySelector<HTMLElement>('.diff-view-overlay-filename')!
        .getBoundingClientRect();
      const statsRect = header
        .querySelector<HTMLElement>('.diff-view-stats')!
        .getBoundingClientRect();
      return {
        x: (filenameRect.right + statsRect.left) / 2,
        y: filenameRect.top + filenameRect.height / 2,
        width: statsRect.left - filenameRect.right,
      };
    });
    expect(headerGap.width).toBeGreaterThan(20);
    await page.mouse.click(headerGap.x, headerGap.y);
    await expect(overlay).toHaveCount(0);

    await page
      .locator(`[data-msg-id="${messageId}"] .diff-view-toggle`)
      .evaluate((button) => (button as HTMLButtonElement).click());
    await expect(overlay).toBeVisible();
    await overlay.click({ position: { x: 2, y: 2 } });
    await expect(overlay).toHaveCount(0);
  });

  test('keeps visible content anchored while diff previews resize asynchronously', async ({
    page,
  }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => list.evaluate((element) => element.querySelectorAll('[data-msg-id]').length))
      .toBeLessThan(50);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * 0.55);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 4);

    const before = await list.evaluate((element) => {
      const containerRect = element.getBoundingClientRect();
      const rows = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')];
      const firstVisible = rows.find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
      });
      const diffRowsAbove = rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return row.querySelector('.diff-view-widget') && rect.bottom <= containerRect.top;
      });
      const target = diffRowsAbove.at(-1);
      element.dataset.maxRenderedMessageRows = String(rows.length);
      const rowObserver = new MutationObserver((records) => {
        const addedRows = records.reduce((count, record) => {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            count += node.matches('[data-msg-id]') ? 1 : 0;
            count += node.querySelectorAll('[data-msg-id]').length;
          }
          return count;
        }, 0);
        element.dataset.maxRenderedMessageRows = String(
          Math.max(
            Number(element.dataset.maxRenderedMessageRows ?? 0),
            element.querySelectorAll('[data-msg-id]').length,
            addedRows
          )
        );
      });
      rowObserver.observe(element, { childList: true, subtree: true });

      return {
        anchorId: firstVisible?.dataset.msgId ?? '',
        anchorTop: firstVisible ? firstVisible.getBoundingClientRect().top - containerRect.top : 0,
        targetId: target?.dataset.msgId ?? '',
      };
    });

    expect(before.anchorId).not.toBe('');
    expect(before.targetId).not.toBe('');

    await list.dispatchEvent('wheel', { deltaY: -1 });
    await updateDiffPreview(page, before.targetId, 20);
    await expect(page.locator(`[data-msg-id="${before.targetId}"] .diff-view-file`)).toHaveCount(
      20
    );
    await waitForAnimationFrames(page, 4);

    const mountedResizeSamples = await sampleMessageTopAcrossFrames(list, before.anchorId, 4);
    expect(
      mountedResizeSamples.every((top) => top !== null && Math.abs(top - before.anchorTop) < 1.5),
      JSON.stringify({ before, mountedResizeSamples })
    ).toBe(true);

    const beforeOffscreenUpdate = {
      id: before.anchorId,
      top: mountedResizeSamples.at(-1)!,
    };
    await expect(page.locator('[data-msg-id="message-diff-preview-assistant-0"]')).toHaveCount(0);
    await list.dispatchEvent('wheel', { deltaY: -1 });
    await updateDiffPreview(page, 'message-diff-preview-assistant-0', 24);
    await waitForAnimationFrames(page, 4);

    const offscreenUpdateSamples = await sampleMessageTopAcrossFrames(
      list,
      beforeOffscreenUpdate.id,
      4
    );
    expect(
      offscreenUpdateSamples.every(
        (top) => top !== null && Math.abs(top - beforeOffscreenUpdate.top!) < 1.5
      ),
      JSON.stringify({ beforeOffscreenUpdate, offscreenUpdateSamples })
    ).toBe(true);
    expect(
      await list.evaluate((element) => Number(element.dataset.maxRenderedMessageRows ?? 0))
    ).toBeLessThan(50);
  });

  test('aligns the first changed diff row with the top of the preview', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    await expect(page.locator('.interactive-list')).toBeVisible();

    const messageId = 'message-diff-preview-assistant-59';
    await updateDiffPreviewWithPatch(
      page,
      messageId,
      [
        '*** Begin Patch',
        '*** Update File: src/aligned-report.ts',
        '@@ -10,7 +10,8 @@',
        ' context 1',
        ' context 2',
        ' context 3',
        ' context 4',
        ' context 5',
        ' context 6',
        ' context 7',
        '+changed row',
        '*** End Patch',
      ].join('\n')
    );

    const preview = page.locator(`[data-msg-id="${messageId}"] .diff-view-lines`);
    const firstChange = preview.locator('.diff-view-line-addition').first();
    await expect(firstChange).toContainText('changed row');

    const topOffset = await firstChange.evaluate((row) => {
      const viewport = row.closest<HTMLElement>('.diff-view-lines')!;
      return row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    });
    expect(topOffset).toBeGreaterThanOrEqual(0);
    expect(topOffset).toBeLessThan(2);
  });

  test('opens the diff dialog without obscuring horizontal scrolling', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    await expect(page.locator('.interactive-list')).toBeVisible();

    const messageId = 'message-diff-preview-assistant-59';
    await updateDiffPreviewWithPatch(page, messageId, makeWideDiffPatch(8));

    const preview = page.locator(`[data-msg-id="${messageId}"] .diff-view-lines`);
    const toggle = page.locator(`[data-msg-id="${messageId}"] .diff-view-toggle`);
    await expect(preview).toHaveAttribute('aria-label', 'Changes in src/wide-report.ts');
    await expect(toggle).toHaveAttribute('title', 'Expand diff preview');

    const dimensions = await preview.evaluate((viewport) => {
      const viewportRect = viewport.getBoundingClientRect();
      const shell = viewport.closest<HTMLElement>('.diff-view-lines-shell')!;
      const rows = Array.from(viewport.querySelectorAll<HTMLElement>('.diff-view-line'));
      const visibleRows = rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top < viewportRect.bottom && rect.bottom > viewportRect.top;
      });
      const toggleButton = shell
        .closest<HTMLElement>('.diff-view-file')!
        .querySelector<HTMLElement>('.diff-view-toggle')!;
      const fadeHeight = Number.parseFloat(getComputedStyle(shell, '::after').height);

      return {
        clientHeight: viewport.clientHeight,
        fadeHeight,
        hasHorizontalScrollbar: !!shell.querySelector('.diff-view-scrollbar-horizontal'),
        rowHeight: rows[0]!.getBoundingClientRect().height,
        shellHeight: shell.getBoundingClientRect().height,
        toggleInHeader: toggleButton.parentElement?.classList.contains('diff-view-item-expandable'),
        visibleRowCount: visibleRows.length,
      };
    });

    expect(dimensions.visibleRowCount).toBe(6);
    expect(dimensions.clientHeight).toBeCloseTo(dimensions.rowHeight * 6, 0);
    expect(dimensions.hasHorizontalScrollbar).toBe(false);
    expect(dimensions.shellHeight).toBeCloseTo(dimensions.rowHeight * 6 + 1, 3);
    expect(dimensions.fadeHeight).toBeCloseTo(dimensions.rowHeight / 2, 0);
    expect(dimensions.toggleInHeader).toBe(true);

    await expect
      .poll(() => toggle.evaluate((button) => getComputedStyle(button).opacity))
      .toBe('0.35');

    const header = page.locator(`[data-msg-id="${messageId}"] .diff-view-item`);
    // Wait for layout stability so bottom-follow cannot move the header away from the pointer.
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThanOrEqual(1);
    await header.hover({ position: { x: 4, y: 4 } });
    await expect
      .poll(() => toggle.evaluate((button) => getComputedStyle(button).opacity))
      .toBe('0.7');

    await toggle.hover();
    await expect
      .poll(() => toggle.evaluate((button) => getComputedStyle(button).opacity))
      .toBe('1');
    const headerTopBeforeExpansion = await header.evaluate(
      (element) => element.getBoundingClientRect().top
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await waitForAnimationFrames(page, 4);
    const headerTopAfterExpansion = await header.evaluate(
      (element) => element.getBoundingClientRect().top
    );
    expect(Math.abs(headerTopAfterExpansion - headerTopBeforeExpansion)).toBeLessThan(2);

    const expandedPreview = page.locator('.diff-view-overlay-lines');
    await expect(expandedPreview).toBeVisible();
    const expandedLayout = await expandedPreview.evaluate((viewport) => {
      viewport.scrollLeft = viewport.scrollWidth;
      return {
        clientWidth: viewport.clientWidth,
        overflowX: getComputedStyle(viewport).overflowX,
        scrollLeft: viewport.scrollLeft,
        scrollWidth: viewport.scrollWidth,
      };
    });

    expect(expandedLayout.scrollWidth).toBeGreaterThan(expandedLayout.clientWidth);
    expect(expandedLayout.scrollLeft).toBeGreaterThan(0);
    expect(expandedLayout.overflowX).toBe('auto');

    await page.waitForTimeout(300);
    const list = page.locator('.interactive-list');
    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 400);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);
    const expandedOverlayAnchor = await getVisibleMessageAnchor(list);
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      200
    );

    await updateDiffPreviewWithPatch(page, messageId, makeWideDiffPatch(30));
    const expandedOverlaySamples = await sampleMessageTopAcrossFrames(
      list,
      expandedOverlayAnchor.id,
      4
    );

    const expandedMetrics = await getScrollMetrics(page, '.interactive-list');
    expect(
      expandedOverlaySamples.every(
        (top) => top !== null && Math.abs(top - expandedOverlayAnchor.top) < 1.5
      ),
      JSON.stringify({ expandedOverlayAnchor, expandedOverlaySamples })
    ).toBe(true);
    expect(expandedMetrics.distanceFromBottom).toBeGreaterThan(200);
    await expect(page.locator('.jump-to-latest-button')).toHaveCount(0);

    await page.locator('.diff-view-overlay-close').click();
    await expect(page.locator('.diff-view-overlay')).toHaveCount(0);
    const jumpToLatest = page.locator('.jump-to-latest-button');
    await expect(jumpToLatest).toBeVisible();
    await jumpToLatest.click();
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(3);

    const focusPreview = page.locator(
      '[data-msg-id="message-diff-preview-assistant-58"] .diff-view-lines'
    );
    await focusPreview.focus();
    await expect(focusPreview).toBeFocused();
    await waitForAnimationFrames(page, 2);
    const focusedAnchor = await getVisibleMessageAnchor(list);

    await updateDiffPreview(page, messageId, 12);
    const focusedSamples = await sampleMessageTopAcrossFrames(list, focusedAnchor.id, 4);

    const focusedMetrics = await getScrollMetrics(page, '.interactive-list');
    expect(
      focusedSamples.every((top) => top !== null && Math.abs(top - focusedAnchor.top) < 1.5),
      JSON.stringify({ focusedAnchor, focusedSamples })
    ).toBe(true);
    expect(focusedMetrics.distanceFromBottom).toBeGreaterThan(200);

    await page.locator('[contenteditable="true"]').focus();
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(3);
  });

  test('keeps a focused diff header fixed when it is expanded after scrolling', async ({
    page,
  }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    const messageId = 'message-diff-preview-assistant-30';
    await updateExpandableDiffPreview(page, messageId);
    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * 0.5);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 4);

    const toggle = page.locator(`[data-msg-id="${messageId}"] .diff-view-toggle`);
    const header = page.locator(`[data-msg-id="${messageId}"] .diff-view-item`);
    await expect(toggle).toBeAttached();
    await toggle.scrollIntoViewIfNeeded();
    await toggle.focus();

    await list.evaluate((element) => {
      element.scrollTop += 100;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 2);
    const headerTopBeforeExpansion = await header.evaluate((element) => {
      const scrollList = element.closest<HTMLElement>('.interactive-list')!;
      return element.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
    });

    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(300);
    await waitForAnimationFrames(page, 4);

    const headerTopAfterExpansion = await header.evaluate((element) => {
      const scrollList = element.closest<HTMLElement>('.interactive-list')!;
      return element.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
    });
    expect(Math.abs(headerTopAfterExpansion - headerTopBeforeExpansion)).toBeLessThan(2);
  });

  test('stops following the bottom when an expanded diff is collapsed', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    const messageId = 'message-diff-preview-assistant-59';
    await updateExpandableDiffPreview(page, messageId);
    const toggle = page.locator(`[data-msg-id="${messageId}"] .diff-view-toggle`);
    await expect(toggle).toBeAttached();

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    await toggle.evaluate((button) => (button as HTMLButtonElement).click());
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await waitForAnimationFrames(page, 4);
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    await toggle.evaluate((button) => {
      const measure = button.getBoundingClientRect.bind(button);
      button.getBoundingClientRect = () => {
        const rect = measure();
        return button.getAttribute('aria-expanded') === 'false'
          ? new DOMRect(rect.x, rect.y - 800, rect.width, rect.height)
          : rect;
      };
    });

    const collapseDistances = await toggle.evaluate(async (button) => {
      const scrollList = button.closest<HTMLElement>('.interactive-list')!;
      const sample = () => scrollList.scrollHeight - scrollList.clientHeight - scrollList.scrollTop;
      (button as HTMLButtonElement).click();
      const distances = [sample()];
      for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        distances.push(sample());
      }
      return distances;
    });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    expect(Math.max(...collapseDistances)).toBeLessThan(3);

    await page.waitForTimeout(300);
    const detachedAnchor = await getVisibleMessageAnchor(list);
    await updateDiffPreview(page, messageId, 12);
    const detachedSamples = await sampleMessageTopAcrossFrames(list, detachedAnchor.id, 4);

    const detachedMetrics = await getScrollMetrics(page, '.interactive-list');
    expect(
      detachedSamples.every((top) => top !== null && Math.abs(top - detachedAnchor.top) < 1.5),
      JSON.stringify({ detachedAnchor, detachedSamples })
    ).toBe(true);
    expect(detachedMetrics.distanceFromBottom).toBeGreaterThan(200);
  });

  test('does not reattach to bottom after a zero-delta layout scroll event', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect(page.locator('[data-msg-id="message-diff-preview-assistant-59"]')).toBeAttached();
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then(
          (metrics) => metrics.scrollHeight - metrics.clientHeight
        )
      )
      .toBeGreaterThan(1_000);
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(3);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -8, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 8);
    });
    await waitForAnimationFrames(page, 3);

    const detachedDistance = (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom;
    expect(detachedDistance).toBeGreaterThan(3);
    expect(detachedDistance).toBeLessThan(15);

    await list.evaluate((element) => {
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    const afterDistance = (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom;
    expect(afterDistance).toBeGreaterThan(3);
    expect(afterDistance).toBeLessThan(15);
  });

  test('never resumes bottom follow while scrolling through stale diff heights', async ({
    page,
  }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&expandedActivity=1'
    );
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    for (let index = 20; index < 46; index += 1) {
      await updateDiffPreview(page, `message-diff-preview-assistant-${index}`, 8);
    }
    await waitForAnimationFrames(page, 5);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    const distances: number[] = [];
    for (let index = 0; index < 36; index += 1) {
      await page.mouse.wheel(0, -240);
      await waitForAnimationFrames(page, 2);
      distances.push((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom);
    }

    const detachedIndex = distances.findIndex((distance) => distance > 100);
    expect(detachedIndex).toBeGreaterThanOrEqual(0);
    for (const distance of distances.slice(detachedIndex)) {
      expect(distance).toBeGreaterThan(50);
    }
  });

  test('keeps the visible message anchored when older diff history loads', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&windowed=1&deferHistory=1&expandedActivity=1&messagePageSize=50'
    );
    const list = page.locator('.interactive-list');
    const historyBanner = page.locator('.message-history-banner');
    await expect(list).toBeVisible();
    await expect(page.locator('[data-msg-id="message-diff-preview-user-0"]')).toHaveCount(0);
    await expect(historyBanner).toBeVisible();
    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const harness = window as Window & {
            __varroE2E?: { pendingHistoryRequestCount?: () => number };
          };
          return harness.__varroE2E?.pendingHistoryRequestCount?.() ?? 0;
        })
      )
      .toBe(1);

    for (let index = 36; index < 45; index += 1) {
      await updateDiffPreview(page, `message-diff-preview-assistant-${index}`, 12);
    }
    await waitForAnimationFrames(page, 4);

    await page.locator('.chat-main-column-shell').evaluate(async (shell) => {
      shell.style.maxWidth = 'none';
      for (let frame = 0; frame <= 8; frame += 1) {
        shell.style.width = `${760 - frame * 30}px`;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1000, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(historyBanner).toHaveClass(/is-loading/);
    const anchor = await getVisibleMessageAnchor(list);
    expect(anchor.id).toBe('message-diff-preview-user-35');

    const released = await page.evaluate(() => {
      const harness = window as Window & {
        __varroE2E?: { releaseNextHistoryRequest?: () => boolean };
      };
      return harness.__varroE2E?.releaseNextHistoryRequest?.() ?? false;
    });
    expect(released).toBe(true);

    const anchorSamples = await sampleMessageTopAcrossFrames(list, anchor.id, 8);
    expect(
      anchorSamples.every((top) => top !== null && Math.abs(top - anchor.top) < 1.5),
      JSON.stringify({ anchor, anchorSamples })
    ).toBe(true);

    await expect
      .poll(() =>
        list.evaluate((element) => {
          const loadedOlderRow = element.querySelector(
            '[data-msg-id="message-diff-preview-user-10"]'
          );
          const topSpacerHeight =
            element.querySelector<HTMLElement>('.virtual-spacer-top')?.getBoundingClientRect()
              .height ?? 0;
          return !!loadedOlderRow || topSpacerHeight > 100;
        })
      )
      .toBe(true);

    const boundary = page.locator('[data-msg-id="message-diff-preview-user-35"]');
    await expect(boundary).toBeAttached();
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      100
    );
  });

  test('loads and navigates to an unloaded sticky boundary prompt after a width change', async ({
    page,
  }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&windowed=1&boundarySticky=1&expandedActivity=1&messagePageSize=50'
    );
    const list = page.locator('.interactive-list');
    const targetRow = page.locator('[data-msg-id="message-diff-preview-user-35"]');
    const targetCard = targetRow.locator('.user-message-card');
    const sticky = page.locator('.latest-user-message-sticky');
    await expect(list).toBeVisible();
    await expect(targetRow).toHaveCount(0);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      element.scrollTop = 80;
      element.dispatchEvent(new Event('scroll'));
    });

    await expect(sticky).toContainText('Review asynchronous report change 35.');
    await page.locator('.chat-main-column-shell').evaluate(async (shell) => {
      shell.style.maxWidth = 'none';
      for (let frame = 0; frame <= 12; frame += 1) {
        shell.style.width = `${760 - frame * 20}px`;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const outerScrollTop = await installOuterScrollSentinel(page);
    const sawLoading = await sticky.evaluate((card) => {
      (card as HTMLElement).click();
      const loading = card.querySelector<HTMLElement>('.latest-user-message-sticky-loading');
      const spinner = card.querySelector<HTMLElement>('.latest-user-message-sticky-spinner');
      const bounds = loading?.getBoundingClientRect();
      return (
        !(loading?.textContent?.includes('Loading…') ?? false) &&
        !!spinner &&
        !!bounds &&
        bounds.width > 0 &&
        bounds.height > 0
      );
    });
    expect(sawLoading).toBe(true);

    await expect(targetCard).toBeAttached();
    await expect
      .poll(() =>
        getStickyMessageAlignment(targetCard).then((geometry) => Math.abs(geometry.delta))
      )
      .toBeLessThanOrEqual(1);
    expect(await page.locator('#root').evaluate((root) => root.scrollTop)).toBe(outerScrollTop);
  });

  test('navigates after loading assistant-heavy paginated history', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=assistant-heavy-history&windowed=1');
    const list = page.locator('.interactive-list');
    const sticky = page.locator('.latest-user-message-sticky');
    const targetRow = page.locator('[data-msg-id="message-assistant-heavy-target"]');
    const targetCard = targetRow.locator('.user-message-card');
    await expect(list).toBeVisible();
    await expect(targetRow).toHaveCount(0);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      element.scrollTop = 32;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(sticky).toContainText('Apply the needed fixes/improvements');
    const outerScrollTop = await installOuterScrollSentinel(page);
    await sticky.evaluate((card) => (card as HTMLElement).click());

    await expect(targetCard).toBeAttached();
    await page.waitForTimeout(500);
    await expect(targetCard).toBeAttached();
    await expect
      .poll(() =>
        getStickyMessageAlignment(targetCard).then((geometry) => Math.abs(geometry.delta))
      )
      .toBeLessThanOrEqual(1);
    expect(await page.locator('#root').evaluate((root) => root.scrollTop)).toBe(outerScrollTop);
  });
});

test.describe('sticky preview overlap', () => {
  test('hides immediately when next user message reaches the painted sticky overlay', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=sticky-preview');
    const list = page.locator('.interactive-list');
    const sticky = page.locator('.latest-user-message-sticky');

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);
    await expect(sticky).toBeVisible();

    const overlapDetected = await list.evaluate((element) => {
      const stickyEl = document.querySelector('.latest-user-message-sticky-overlay');
      const nextPrompt = document.querySelector(
        '[data-msg-id="message-sticky-user-2"] .user-message-card'
      );
      if (!stickyEl || !nextPrompt) return false;

      const step = 5;
      for (let i = 0; i < 600; i++) {
        element.scrollTop += step;
        element.dispatchEvent(new Event('scroll'));

        const currentStickyEl = document.querySelector('.latest-user-message-sticky-overlay');
        const currentPromptEl = document.querySelector(
          '[data-msg-id="message-sticky-user-2"] .user-message-card'
        );
        if (!currentStickyEl || !currentPromptEl) break;

        const currentStickyBottom = currentStickyEl.getBoundingClientRect().bottom;
        const currentPromptTop = currentPromptEl.getBoundingClientRect().top;
        if (currentPromptTop < currentStickyBottom) {
          return true;
        }
      }
      return false;
    });

    expect(overlapDetected).toBe(false);
  });

  test('sticky hides when scrolling back up toward its source message', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=sticky-preview');
    const list = page.locator('.interactive-list');
    const sticky = page.locator('.latest-user-message-sticky');

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);
    await expect(sticky).toBeVisible();

    await list.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);
    await waitForAnimationFrame(page);

    await expect(sticky).not.toBeVisible();
  });
});
