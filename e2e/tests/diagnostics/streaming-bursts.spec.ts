import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../../src/shared/protocol';
import { BURST_CASES, createBurstCapture } from '../../../scripts/ai-streaming-burst-fixture.mjs';
import {
  analyzeBurstProbe,
  installBurstProbe,
} from '../../../scripts/ai-streaming-burst-probe.mjs';
import type { BurstProbeData } from '../../../scripts/ai-streaming-burst-probe.mjs';

for (const width of [390, 1280]) {
  for (const kind of BURST_CASES) {
    test(`synthetic ${kind} has no backward or excessive follow at ${width}px`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(45000);
      const capture = createBurstCapture(kind);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.addInitScript((fixture) => {
        // SAFETY: The isolated playback harness consumes this generated, session-local fixture.
        (window as typeof window & { varroPlaybackCapture: typeof fixture }).varroPlaybackCapture =
          fixture;
      }, capture);
      await page.goto('/e2e/harness/index.html?scenario=session-playback');
      await expect(page.locator('[data-msg-id="burst-current-assistant"]')).toContainText(
        'BURST-LEAD-MARKER'
      );
      await expect
        .poll(() =>
          page
            .locator('.interactive-list')
            .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
        )
        .toBeLessThanOrEqual(1);
      await page.evaluate(installBurstProbe);
      await page.evaluate('globalThis.varroBurstProbe.start()');
      const delivery = await page.evaluate(async (entries) => {
        // SAFETY: The session-playback scenario installs this canonical mock transport.
        const harness = (
          window as typeof window & {
            __varroE2E: { replayServerEvent(event: ServerEvent): void };
          }
        ).__varroE2E;
        const started = performance.now();
        const actual = [];
        for (const entry of entries) {
          const remaining = entry.offsetMs - (performance.now() - started);
          if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
          harness.replayServerEvent(entry.event);
          actual.push({ scheduled: entry.offsetMs, actual: performance.now() - started });
        }
        return actual;
      }, capture.events);
      const data = await page.evaluate<BurstProbeData>('globalThis.varroBurstProbe.stop()');
      const summary = analyzeBurstProbe(data);
      await writeFile(testInfo.outputPath('frames.json'), JSON.stringify(data));
      await writeFile(
        testInfo.outputPath('summary.json'),
        JSON.stringify({ summary, delivery }, null, 2)
      );
      await testInfo.attach('summary.json', {
        body: JSON.stringify({ summary, delivery }, null, 2),
        contentType: 'application/json',
      });
      await page.screenshot({ path: testInfo.outputPath('settled.png') });
      expect.soft(summary.frames).toBeGreaterThan(100);
      expect
        .soft(summary.eventCount, 'Every scheduled transport event was observed')
        .toBe(capture.events.length);
      expect.soft(summary.maxMountedRows, 'Virtualized history stays bounded').toBeLessThan(50);
      expect
        .soft(
          Math.max(...data.frames.map((frame) => frame.height)) - data.frames[0]!.height,
          'The content-growth precondition must actually occur'
        )
        .toBeGreaterThan(200);
      expect
        .soft(
          data.frames.at(-1)!.top - data.frames[0]!.top,
          'The viewport must actually follow the additions'
        )
        .toBeGreaterThan(100);
      expect.soft(summary.hiddenFrames).toBe(0);
      expect.soft(summary.droppedSamples).toBe(0);
      expect.soft(summary.reversals, 'Same painted block moved backward').toEqual([]);
      expect
        .soft(summary.excessiveSpeed, 'Frame movement exceeded 2200 px/s plus 2px rounding')
        .toEqual([]);
      expect
        .soft(summary.maxSustainedSpeedPxPerSecond, '90-120ms window speed')
        .toBeLessThanOrEqual(2250);
      expect
        .soft(summary.abruptStarts, 'No near-stationary frame may jump to catch-up speed')
        .toEqual([]);
      expect.soft(summary.finalBottomGap, 'Ten-second settlement').toBeLessThanOrEqual(2);
      const finalAssistant = capture.finalMessages.at(-1)!;
      for (const part of finalAssistant.parts) {
        if (part.type === 'text')
          await expect(page.locator('[data-msg-id="burst-current-assistant"]')).toContainText(
            part.text
          );
      }
    });
  }
}
