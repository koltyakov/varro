import { expect, test } from '@playwright/test';
import type { AssistantMessage, MessageEntry, Session } from '../../src/webview/types';

for (const virtualized of [false, true]) {
  test(`expanded activity guide joins fractional rows${virtualized ? ' in virtualized history' : ''}`, async ({
    page,
  }, testInfo) => {
    const created = 1_780_000_000_000;
    const session: Session = {
      id: 'session-activity-guide',
      projectID: 'project-test',
      directory: '/workspace',
      title: 'Activity guide continuity',
      version: '1.0.0',
      time: { created, updated: created },
    };
    const assistantInfo = (id: string): AssistantMessage => ({
      id,
      sessionID: session.id,
      role: 'assistant',
      parentID: 'guide-user',
      time: { created, completed: created + 1 },
      providerID: 'openai',
      modelID: 'gpt-5',
      mode: 'build',
      agent: 'build',
      path: { cwd: '/workspace', root: '/workspace' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const initialMessages: MessageEntry[] = [
      {
        info: {
          id: 'guide-user',
          sessionID: session.id,
          role: 'user',
          time: { created },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-5' },
        },
        parts: [
          {
            id: 'guide-prompt',
            messageID: 'guide-user',
            sessionID: session.id,
            type: 'text',
            text: 'Inspect the source and review the result.',
          },
        ],
      },
    ];
    for (let index = 0; index < (virtualized ? 60 : 0); index += 1) {
      const info = assistantInfo(`history-${index}`);
      initialMessages.push({
        info,
        parts: [
          {
            id: `${info.id}-text`,
            messageID: info.id,
            sessionID: session.id,
            type: 'text',
            text: `Earlier context ${index}. ${'The earlier response remains available in history. '.repeat(4)}`,
          },
        ],
      });
    }
    const activityIds = ['guide-read-1', 'guide-thought-1', 'guide-read-2', 'guide-thought-2'];
    for (const [index, id] of activityIds.entries()) {
      const info = assistantInfo(id);
      const common = { id: `${id}-part`, messageID: id, sessionID: session.id };
      initialMessages.push({
        info,
        parts: [
          index % 2 === 0
            ? {
                ...common,
                type: 'tool',
                callID: `${id}-call`,
                tool: 'read',
                state: {
                  status: 'completed',
                  input: { filePath: `/workspace/source-${index}.ts` },
                  output: 'export const result = true;',
                  title: 'Read source',
                  metadata: {},
                  time: { start: created, end: created + 10 },
                },
              }
            : {
                ...common,
                type: 'reasoning',
                text: '**Reviewing the source**\nChecking how the activity list joins across messages.',
                time: { start: created, end: created + 10 },
              },
        ],
      });
      initialMessages.push({ info: assistantInfo(`${id}-empty`), parts: [] });
    }
    await page.setViewportSize({ width: 496, height: 850 });
    await page.addInitScript(
      (fixture) => {
        // SAFETY: The isolated E2E harness reads this synthetic fixture before mounting.
        (window as typeof window & { varroPlaybackCapture: typeof fixture }).varroPlaybackCapture =
          fixture;
      },
      { session, initialMessages }
    );
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    await page.addStyleTag({
      content: '.assistant-activity-details .file-read-card-header { font-size: 13.5px; }',
    });
    const summary = page.locator('[data-msg-id="guide-read-1"] .assistant-activity-summary');
    await expect(summary).toBeVisible();
    await summary.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await summary.click();
    await expect(page.locator('[data-msg-id="guide-thought-2"] .chat-thinking-box')).toBeVisible();
    if (virtualized)
      await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

    const groups = page.locator('[data-msg-id^="guide-"] .assistant-activity-group');
    await expect(groups).toHaveCount(4);
    await expect
      .poll(() =>
        groups.evaluateAll((elements) =>
          elements.some(
            (element) =>
              Number.parseFloat(
                getComputedStyle(element).getPropertyValue('--interactive-item-block-correction')
              ) > 0
          )
        )
      )
      .toBe(true);
    const samples = await groups.evaluateAll(async (elements) => {
      const frames = [];
      for (let frame = 0; frame < 8; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const segments = elements.map((element) => {
          const bounds = element.getBoundingClientRect();
          const guide = getComputedStyle(element, '::before');
          return {
            top: bounds.top + Number.parseFloat(guide.top),
            bottom: bounds.bottom - Number.parseFloat(guide.bottom),
            left: bounds.left + Number.parseFloat(guide.left),
          };
        });
        frames.push(
          segments.slice(1).map((segment, index) => ({
            gap: segment.top - segments[index]!.bottom,
            offset: segment.left - segments[index]!.left,
          }))
        );
      }
      return frames;
    });
    await testInfo.attach('guide-joins.json', {
      body: JSON.stringify(samples),
      contentType: 'application/json',
    });
    if (virtualized) {
      await page.mouse.move(250, 450);
      await page.mouse.wheel(0, 400);
    }
    await expect(groups.first()).toBeInViewport({ ratio: 1 });
    await expect(groups.last()).toBeInViewport({ ratio: 1 });
    const first = await groups.first().boundingBox();
    const last = await groups.last().boundingBox();
    if (!first || !last) throw new Error('Activity guide screenshot bounds are missing');
    const guideX = await groups
      .first()
      .evaluate(
        (element) =>
          element.getBoundingClientRect().left +
          Number.parseFloat(getComputedStyle(element, '::before').left)
      );
    const screenshot = await page.screenshot({
      path: testInfo.outputPath('activity-guide.png'),
      clip: { x: 0, y: first.y, width: 496, height: last.y + last.height - first.y },
    });
    const faintRows = await page.evaluate(
      async ({ dataUrl, x }) => {
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Activity guide pixel capture is unavailable');
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, image.width, image.height).data;
        const contrastAt = (y: number) => {
          const guide = (y * image.width + Math.floor(x)) * 4;
          const background = guide + 8;
          return [0, 1, 2].reduce(
            (sum, channel) =>
              sum + Math.abs(pixels[guide + channel]! - pixels[background + channel]!),
            0
          );
        };
        const minimumContrast = contrastAt(5) * 0.5;
        if (minimumContrast <= 0)
          throw new Error('Activity guide is not painted in the screenshot');
        return Array.from({ length: image.height - 2 }, (_, index) => index + 1).filter(
          (y) => contrastAt(y) < minimumContrast
        );
      },
      { dataUrl: `data:image/png;base64,${screenshot.toString('base64')}`, x: guideX }
    );
    expect(faintRows).toEqual([]);
    expect(Math.max(...samples.flat().map((join) => Math.abs(join.gap)))).toBeCloseTo(0, 3);
    expect(Math.max(...samples.flat().map((join) => Math.abs(join.offset)))).toBeCloseTo(0, 3);
  });
}
