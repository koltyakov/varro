import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry, ToolPart } from '../../src/webview/types';

const SESSION = 'session-rapid-streaming-jitter';
const MESSAGE = 'message-rapid-assistant-streaming';
const ROW = `[data-msg-id="${MESSAGE}"]`;

for (const { width, toolCount } of [
  { width: 390, toolCount: 3 },
  { width: 1280, toolCount: 3 },
  { width: 390, toolCount: 32 },
  { width: 1280, toolCount: 32 },
  { width: 390, toolCount: 128 },
  { width: 1280, toolCount: 128 },
]) {
  test(`queues ${toolCount} tools, then streams and follows smoothly at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    await expect(page.locator(`${ROW} .rendered-markdown`)).toHaveText('Starting...');
    await page.waitForTimeout(300);
    const recording = page.evaluate(
      async ({ sessionID, messageID, count }) => {
        // SAFETY: The isolated browser fixture installs this event transport and canonical mock store.
        const harness = (
          window as typeof window & {
            __varroE2E: {
              replayServerEvent: (event: ServerEvent) => void;
              getSessionMessages: (id: string) => MessageEntry[];
            };
          }
        ).__varroE2E;
        const list = document.querySelector<HTMLElement>('.interactive-list')!;
        const marker = document.querySelector<HTMLElement>(
          `[data-msg-id="${messageID}"] .rendered-markdown p`
        )!;
        const tools: ToolPart[] = Array.from({ length: count }, (_, index) => ({
          id: `preview-tool-${index}`,
          messageID,
          sessionID,
          type: 'tool',
          tool: 'read',
          callID: `preview-call-${index}`,
          state: {
            status: 'running',
            input: { filePath: `/workspace/file-${index}.ts` },
            time: { start: Date.now() },
          },
        }));
        const finalText = Array.from(
          { length: 20 },
          (_, index) =>
            `Readable paragraph ${index}. This answer arrives in one burst and should grow in paced chunks while the viewport follows.`
        ).join('\n\n');
        const started = performance.now();
        let contentAt = 0;
        const result = [];
        // A speed-limited follow can take longer than the text queue. Record its full
        // settling path, including every frame after the answer stops growing.
        for (let frame = 0; frame < 360; frame += 1) {
          if (frame === 0) {
            for (const part of tools)
              harness.replayServerEvent({ type: 'message.part.updated', properties: { part } });
          }
          if (frame === 2) {
            for (const part of tools) {
              harness.replayServerEvent({
                type: 'message.part.updated',
                properties: {
                  part: {
                    ...part,
                    state: {
                      status: 'completed' as const,
                      input: part.state.input,
                      title: 'Read source',
                      output: 'contents',
                      metadata: {},
                      time: { start: Date.now() - 30, end: Date.now() },
                    },
                  },
                },
              });
            }
          }
          if (frame === 45) {
            contentAt = performance.now() - started;
            harness.replayServerEvent({
              type: 'message.part.updated',
              properties: {
                part: {
                  id: 'preview-answer',
                  messageID,
                  sessionID,
                  type: 'text',
                  text: finalText,
                },
              },
            });
            const info = harness
              .getSessionMessages(sessionID)
              .find((entry) => entry.info.id === messageID)!.info;
            if (info.role !== 'assistant') throw new Error('Expected assistant fixture');
            harness.replayServerEvent({
              type: 'message.updated',
              properties: {
                info: { ...info, finish: 'stop', time: { ...info.time, completed: Date.now() } },
              },
            });
            harness.replayServerEvent({
              type: 'session.status',
              properties: { sessionID, status: { type: 'idle' } },
            });
          }
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const items = [
            ...document.querySelectorAll<HTMLElement>('[data-activity-part-id^="preview-tool-"]'),
          ];
          const answer = document.querySelector(
            `[data-assistant-render-key="part:preview-answer"] .rendered-markdown`
          );
          result.push({
            at: performance.now() - started,
            top: list.scrollTop,
            height: list.scrollHeight,
            mountedRows: list.querySelectorAll('[data-msg-id]').length,
            anchorTop: marker.getBoundingClientRect().top,
            connected: marker.isConnected,
            preview: items.length,
            previewIds: items.map((item) => item.dataset.activityPartId!),
            innerTop: items[0]?.closest('.assistant-active-activity-items')?.scrollTop ?? null,
            exiting: items.some((item) => item.classList.contains('is-exiting')),
            textLength: answer?.textContent?.length ?? 0,
            contentAt,
            distance: list.scrollHeight - list.clientHeight - list.scrollTop,
          });
          if (
            frame >= 190 &&
            answer?.textContent?.includes('Readable paragraph 19.') &&
            result.slice(-3).every((sample) => sample.distance <= 2)
          )
            break;
        }
        return result;
      },
      { sessionID: SESSION, messageID: MESSAGE, count: toolCount }
    );
    await expect(page.locator('[data-activity-part-id^="preview-tool-"]').first()).toBeVisible();
    await page
      .locator('[data-activity-part-id^="preview-tool-"]')
      .first()
      .evaluate(async (element) => {
        await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
      });
    await page.screenshot({ path: testInfo.outputPath('preview.png') });
    const samples = await recording;
    await writeFile(
      testInfo.outputPath('presentation-frames.json'),
      JSON.stringify(samples, null, 2)
    );
    await testInfo.attach('presentation-frames.json', {
      body: JSON.stringify(samples, null, 2),
      contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath('completed.png') });

    const preview = samples.filter((sample) => sample.preview > 0 && !sample.exiting);
    expect(preview.length).toBeGreaterThan(20);
    expect(preview.at(-1)!.at - preview[0]!.at).toBeGreaterThan(400);
    expect(samples.every((sample) => sample.preview <= 1)).toBe(true);
    const seen = new Map<string, number>();
    for (const sample of samples) {
      const entering = sample.previewIds.filter((id) => !seen.has(id));
      expect(entering.length, `Admission at ${sample.at} ms`).toBeLessThanOrEqual(1);
      for (const id of entering) seen.set(id, sample.at);
    }
    const admissions = [...seen.values()];
    expect(admissions.length).toBe(1);
    expect(
      admissions.every((at, index) => index === 0 || at - admissions[index - 1]! >= 90),
      JSON.stringify(admissions)
    ).toBe(true);
    const innerJumps = samples.flatMap((sample, index) => {
      const previous = samples[index - 1];
      if (
        !previous ||
        sample.exiting ||
        previous.exiting ||
        sample.innerTop === null ||
        previous.innerTop === null
      )
        return [];
      return sample.innerTop - previous.innerTop > 32 ? [{ previous, sample }] : [];
    });
    expect(innerJumps).toEqual([]);
    expect(samples.some((sample) => sample.preview > 0 && sample.textLength > 0)).toBe(false);
    const firstText = samples.find((sample) => sample.textLength > 0)!;
    expect(firstText.at - firstText.contentAt).toBeLessThan(300);
    expect(
      new Set(samples.filter((sample) => sample.textLength > 0).map((sample) => sample.textLength))
        .size
    ).toBeGreaterThan(3);
    expect(samples.every((sample) => sample.connected)).toBe(true);
    expect(Math.max(...samples.map((sample) => sample.mountedRows))).toBeLessThan(40);
    const reversals = samples.flatMap((sample, index) =>
      index > 0 && sample.top < samples[index - 1]!.top - 2
        ? [{ previous: samples[index - 1], sample }]
        : []
    );
    expect(reversals).toEqual([]);
    // After content stops growing, easing still advances toward the measured bottom over several frames.
    const settling = samples.filter(
      (sample, index) =>
        index > 1 &&
        sample.textLength > 0 &&
        sample.height === samples[index - 1]!.height &&
        sample.height === samples[index - 2]!.height &&
        sample.top > samples[index - 1]!.top + 0.5
    );
    expect(settling.length).toBeGreaterThan(2);
    expect(samples.at(-1)!.distance).toBeLessThanOrEqual(2);
    await expect(page.locator(`${ROW} .rendered-markdown`).last()).toContainText(
      'Readable paragraph 19.'
    );
    await expect(page.locator('.streaming-markdown-pending')).toHaveCount(0);
    await page.locator(`${ROW} .assistant-activity-summary`).click();
    await expect(page.locator(`${ROW} .assistant-activity-detail`)).toHaveCount(toolCount);
  });
}

test('alternates a long-running tool with queued tools in one-second previews', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  await expect(page.locator(`${ROW} .rendered-markdown`)).toHaveText('Starting...');
  const samples = await page.evaluate(
    async ({ sessionID, messageID }) => {
      // SAFETY: This isolated fixture exposes its event transport and canonical session snapshots.
      const harness = (
        window as typeof window & {
          __varroE2E: {
            replayServerEvent: (event: ServerEvent) => void;
            getSessionMessages: (id: string) => MessageEntry[];
          };
        }
      ).__varroE2E;
      const startedAt = Date.now();
      for (const id of ['long', 'two', 'three']) {
        const part: ToolPart = {
          id: `rotation-${id}`,
          callID: `rotation-${id}-call`,
          type: 'tool',
          tool: 'grep',
          messageID,
          sessionID,
          state: { status: 'running', input: { pattern: id }, time: { start: startedAt } },
        };
        harness.replayServerEvent({ type: 'message.part.updated', properties: { part } });
      }
      const started = performance.now();
      const frames = [];
      while (performance.now() - started < 6_600) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const items = [
          ...document.querySelectorAll<HTMLElement>('[data-activity-part-id^="rotation-"]'),
        ];
        frames.push({
          at: performance.now() - started,
          ids: items.map((item) => item.dataset.activityPartId!),
          exiting: items.some((item) => item.classList.contains('is-exiting')),
          verb: document.querySelector('.interactive-loading-row .loading-verb')?.textContent,
          statusReserved: document
            .querySelector('.interactive-loading-row')
            ?.classList.contains('is-reserved'),
        });
      }
      const tools = harness
        .getSessionMessages(sessionID)
        .flatMap((message) => message.parts)
        .filter(
          (part): part is ToolPart => part.type === 'tool' && part.id.startsWith('rotation-')
        );
      return { frames, statuses: tools.map((part) => part.state.status) };
    },
    { sessionID: SESSION, messageID: MESSAGE }
  );
  expect(samples.frames.every((sample) => sample.ids.length <= 1 && !sample.exiting)).toBe(true);
  expect(
    samples.frames
      .filter((sample) => sample.ids.length === 1)
      .every((sample) => sample.verb !== 'Waiting' && sample.statusReserved)
  ).toBe(true);
  const changes = samples.frames.filter(
    (sample, index) =>
      sample.ids.length === 1 && sample.ids[0] !== samples.frames[index - 1]?.ids[0]
  );
  expect(changes.map((sample) => sample.ids[0])).toEqual([
    'rotation-long',
    'rotation-two',
    'rotation-long',
    'rotation-three',
    'rotation-long',
  ]);
  expect(changes[1]!.at).toBeGreaterThanOrEqual(2_950);
  for (let index = 2; index < changes.length; index += 1) {
    const elapsed = changes[index]!.at - changes[index - 1]!.at;
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(1_250);
  }
  expect(samples.statuses).toEqual(['running', 'running', 'running']);
});

test('keeps a single Explored summary across hidden tools, rotation, and completion', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  await expect(page.locator(`${ROW} .rendered-markdown`)).toHaveText('Starting...');
  const result = await page.evaluate(
    async ({ sessionID, messageID }) => {
      // SAFETY: This isolated fixture exposes its typed event transport.
      const harness = (
        window as typeof window & {
          __varroE2E: { replayServerEvent: (event: ServerEvent) => void };
        }
      ).__varroE2E;
      const startedAt = Date.now();
      const tools = ['before', 'long', 'next', 'after'].map((id): ToolPart => ({
        id: `single-group-${id}`,
        callID: `single-group-${id}-call`,
        type: 'tool',
        tool: 'grep',
        messageID,
        sessionID,
        state:
          id === 'before' || id === 'after'
            ? {
                status: 'completed',
                input: { pattern: id },
                output: 'Found matches',
                title: id,
                metadata: {},
                time: { start: startedAt - 100, end: startedAt },
              }
            : { status: 'running', input: { pattern: id }, time: { start: startedAt } },
      }));
      for (const part of tools) {
        harness.replayServerEvent({ type: 'message.part.updated', properties: { part } });
      }
      const row = document.querySelector(`[data-msg-id="${messageID}"]`)!;
      const frames = [];
      const started = performance.now();
      while (performance.now() - started < 6_600) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        frames.push({
          summaries: [...row.querySelectorAll('.assistant-activity-summary')].map(
            (summary) => summary.textContent
          ),
          ids: [...row.querySelectorAll<HTMLElement>('.assistant-active-activity-item')].map(
            (item) => item.dataset.activityPartId
          ),
        });
      }
      for (const part of tools) {
        if (part.state.status !== 'running') continue;
        const completed: ToolPart = {
          ...part,
          state: {
            status: 'completed',
            input: part.state.input,
            output: 'Found matches',
            title: part.id,
            metadata: {},
            time: { start: startedAt, end: Date.now() },
          },
        };
        harness.replayServerEvent({
          type: 'message.part.updated',
          properties: { part: completed },
        });
      }
      return frames;
    },
    { sessionID: SESSION, messageID: MESSAGE }
  );
  expect(result.every((frame) => frame.summaries.length <= 1 && frame.ids.length <= 1)).toBe(true);
  expect(
    result.every((frame) => frame.summaries.every((summary) => !summary?.includes('Exploring')))
  ).toBe(true);
  expect(result.some((frame) => frame.ids.includes('single-group-long'))).toBe(true);
  expect(result.some((frame) => frame.ids.includes('single-group-next'))).toBe(true);
  await expect(page.locator(`${ROW} .assistant-active-activity-item`)).toHaveCount(0);
  await expect(page.locator(`${ROW} .assistant-activity-summary`)).toHaveCount(1);
  await expect(page.locator(`${ROW} .assistant-activity-summary`)).toContainText(
    'Explored: 4 searches'
  );
});

test('reduced motion publishes available text without a paced reveal', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  await expect(page.locator(`${ROW} .rendered-markdown`)).toHaveText('Starting...');
  await page.evaluate(
    ({ sessionID, messageID }) => {
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'message.part.delta',
            properties: {
              sessionID,
              messageID,
              partID: `${messageID}-text-1`,
              field: 'text',
              delta: '\n\nReduced motion content is ready.',
            },
          },
        },
        '*'
      );
    },
    { sessionID: SESSION, messageID: MESSAGE }
  );
  await expect(page.locator(`${ROW} .rendered-markdown`)).toContainText(
    'Reduced motion content is ready.'
  );
});
