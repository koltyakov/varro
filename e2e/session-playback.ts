import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ServerEvent } from '../src/shared/protocol';
import type { MessageEntry, Session } from '../src/webview/types';

export type PlaybackFixture = {
  capture: {
    id: number;
    label: string;
    scenario: string;
    session: Session;
    initialMessages: MessageEntry[];
    finalMessages: MessageEntry[];
  };
  timeline: Array<{
    delayMs: number;
    sourceGapMs: number;
    offsetMs: number;
    event: ServerEvent;
  }>;
};

type HarnessWindow = typeof window & {
  __varroE2E: {
    getSessionMessages: (id: string) => MessageEntry[];
    replayServerEvent: (event: ServerEvent) => void;
  };
};

export async function verifySessionPlayback(page: Page, playback: PlaybackFixture) {
  const { capture, timeline } = playback;
  test.setTimeout(
    Math.max(
      test.info().timeout,
      timeline.reduce((duration, entry) => duration + entry.delayMs, 0) + 30_000
    )
  );
  await page.addInitScript(
    (fixture) => {
      // SAFETY: The harness owns this injected fixture slot and validates it before startup.
      (
        window as typeof window & {
          varroPlaybackCapture: typeof fixture;
        }
      ).varroPlaybackCapture = fixture;
    },
    { session: capture.session, initialMessages: capture.initialMessages }
  );
  await page.goto('/e2e/harness/index.html?scenario=session-playback');
  await expect(page.locator('[aria-label="Chat messages"]')).toBeVisible();

  const observation = await page.evaluate(
    async ({ replayTimeline, sessionId }) => {
      type SampleState = { frame: number; missingAt: Map<string, number> };
      type FlickerViolation = { kind: string; frame: number; detail: string };
      const state: SampleState = { frame: 0, missingAt: new Map() };
      const violations: FlickerViolation[] = [];
      const previous = new Set<string>();
      const exitingOpacity = new Map<string, number>();
      let active = true;
      const sample = () => {
        if (!active) return;
        state.frame += 1;
        const transcript = document.querySelector('[aria-label="Chat messages"]');
        const rows = [...document.querySelectorAll('[data-msg-id]')];
        if (
          transcript &&
          rows.length > 0 &&
          !rows.some((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.bottom > 0 &&
              rect.top < innerHeight &&
              getComputedStyle(element).visibility !== 'hidden'
            );
          })
        ) {
          violations.push({
            kind: 'blank-transcript',
            frame: state.frame,
            detail: 'no painted row',
          });
        }
        for (const attribute of ['data-msg-id', 'data-activity-part-id']) {
          const counts = new Map<string, number>();
          for (const element of document.querySelectorAll(`[${attribute}]`)) {
            const value = element.getAttribute(attribute);
            if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
          }
          for (const [value, count] of counts) {
            if (count > 1)
              violations.push({
                kind: 'duplicate-identity',
                frame: state.frame,
                detail: `${attribute}=${value} count=${String(count)}`,
              });
          }
        }
        const current = new Set(
          [...document.querySelectorAll('[data-msg-id], [data-activity-part-id]')]
            .map((element) =>
              element.hasAttribute('data-activity-part-id')
                ? `activity:${element.getAttribute('data-activity-part-id')}`
                : `message:${element.getAttribute('data-msg-id')}`
            )
            .filter((value) => !value.endsWith(':null'))
        );
        for (const identity of previous) {
          if (!current.has(identity) && !state.missingAt.has(identity)) {
            state.missingAt.set(identity, state.frame);
          }
        }
        for (const identity of current) {
          const missingAt = state.missingAt.get(identity);
          if (missingAt !== undefined) {
            if (state.frame - missingAt <= 2) {
              violations.push({
                kind: 'brief-disappearance',
                frame: state.frame,
                detail: `${identity} absent at frame ${String(missingAt)}`,
              });
            }
            state.missingAt.delete(identity);
          }
        }
        previous.clear();
        for (const identity of current) previous.add(identity);
        for (const element of document.querySelectorAll<HTMLElement>(
          '[data-activity-part-id].is-exiting'
        )) {
          const id = element.dataset.activityPartId;
          if (!id) continue;
          const opacity = Number.parseFloat(getComputedStyle(element).opacity);
          const prior = exitingOpacity.get(id);
          if (prior !== undefined && opacity - prior > 0.05) {
            violations.push({
              kind: 'exit-opacity-rise',
              frame: state.frame,
              detail: `${id} rose from ${String(prior)} to ${String(opacity)}`,
            });
          }
          exitingOpacity.set(id, opacity);
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      // SAFETY: This page is the controlled harness, which installs the typed test API before rows mount.
      const harness = (window as HarnessWindow).__varroE2E;
      for (const entry of replayTimeline) {
        if (entry.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, entry.delayMs));
        }
        harness.replayServerEvent(entry.event);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      active = false;
      return {
        frames: state.frame,
        violations: violations.slice(0, 100),
        finalMessages: harness.getSessionMessages(sessionId),
      };
    },
    { replayTimeline: timeline, sessionId: capture.session.id }
  );

  await test.info().attach('session-playback-observation', {
    body: JSON.stringify(
      { capture: { ...capture, events: undefined }, timeline, observation },
      null,
      2
    ),
    contentType: 'application/json',
  });
  expect(observation.frames).toBeGreaterThan(5);
  expect(observation.violations).toEqual([]);
  expect(observation.finalMessages).toEqual(capture.finalMessages);
}
