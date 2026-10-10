import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../../src/shared/protocol';
import type { MessageEntry, QuestionRequest, Session } from '../../../src/webview/types';

test('copied Windows question history stays stationary after virtual remounts', async ({
  page,
}) => {
  const file = process.env.VARRO_INCIDENT_FILE;
  if (!file) throw new Error('Set VARRO_INCIDENT_FILE to the read-only projected session copy');
  // SAFETY: The local diagnostic projector writes this fixture from the requested session.
  const fixture = JSON.parse(readFileSync(file, 'utf8')) as {
    session: Session;
    initialMessages: MessageEntry[];
    question: QuestionRequest;
  };
  await page.setViewportSize({ width: 500, height: 1182 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((capture) => {
    // SAFETY: The controlled playback harness reads this fixture before mounting.
    (window as typeof window & { varroPlaybackCapture: typeof capture }).varroPlaybackCapture =
      capture;
  }, fixture);
  await page.goto('/e2e/harness/index.html?scenario=session-playback');
  const list = page.locator('.interactive-list');
  await expect(list).toBeAttached();
  await page.evaluate((question) => {
    // SAFETY: This is the isolated browser harness, not the source session.
    const harness = (
      window as typeof window & {
        __varroE2E: { replayServerEvent(event: ServerEvent): void };
      }
    ).__varroE2E;
    harness.replayServerEvent({ type: 'question.asked', properties: question });
  }, fixture.question);
  await expect(list.locator('.question-prompt')).toBeVisible();
  await page.mouse.move(250, 400);
  for (const delta of [-900, -900, -900, 900, 900, 900]) {
    await page.mouse.wheel(0, delta);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    );
  }
  await list.focus();
  await page.keyboard.press('End');
  const samples = await list.evaluate(async (element) => {
    const frames = [];
    for (let frame = 0; frame < 240; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames.push({
        scrollTop: element.scrollTop,
        height: element.scrollHeight,
        bottomGap: element.scrollHeight - element.clientHeight - element.scrollTop,
        visibility: getComputedStyle(element).visibility,
        loading: !!document.querySelector('.chat-messages-loading'),
        rows: [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].map((row) => ({
          id: row.dataset.msgId,
          top: row.getBoundingClientRect().top,
          height: row.getBoundingClientRect().height,
          correction: row.style.getPropertyValue('--interactive-item-block-correction'),
          className: row.className,
          text: row.textContent?.slice(0, 150),
        })),
      });
    }
    return frames;
  });
  await test.info().attach('frames', {
    body: JSON.stringify({ errors, samples }),
    contentType: 'application/json',
  });
  await page.screenshot({ path: test.info().outputPath('history.png') });
  expect(errors).toEqual([]);
  expect(samples.some((sample) => sample.loading && sample.visibility !== 'hidden')).toBe(false);
  const settled = samples.slice(60);
  expect(new Set(settled.map((sample) => sample.scrollTop)).size).toBe(1);
  expect(new Set(settled.map((sample) => sample.height)).size).toBe(1);
  expect(settled.every((sample) => sample.bottomGap <= 1)).toBe(true);
  await expect(list).toContainText('Two facts shape the resume:');
  await expect(list.locator('.question-prompt')).toBeVisible();
});
