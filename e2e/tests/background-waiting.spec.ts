import { expect, test } from '@playwright/test';
import type { ExtensionMessage, ServerEvent } from '../../src/shared/protocol';
import type { AssistantMessage, MessageEntry, Session } from '../../src/webview/types';

test('shows a background process card until the resumed response finishes', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 494, height: 800 });
  const created = Date.now() - 10_000;
  const session: Session = {
    id: 'session-background-waiting',
    projectID: 'project-test',
    directory: '/workspace',
    title: 'Background tests',
    version: '1.0.0',
    time: { created, updated: created },
  };
  const assistant: AssistantMessage = {
    id: 'assistant-waiting',
    sessionID: session.id,
    role: 'assistant',
    parentID: 'user-waiting',
    time: { created: created + 1_000 },
    providerID: 'openai',
    modelID: 'gpt-5',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: { input: 42, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  const initialMessages: MessageEntry[] = [
    {
      info: {
        id: assistant.parentID,
        sessionID: session.id,
        role: 'user',
        time: { created },
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-5' },
      },
      parts: [
        {
          id: 'prompt-waiting',
          messageID: assistant.parentID,
          sessionID: session.id,
          type: 'text',
          text: 'Run the tests',
        },
      ],
    },
  ];
  await page.addInitScript(
    (fixture) => {
      // SAFETY: The isolated playback harness reads this fixture before mounting.
      (window as typeof window & { varroPlaybackCapture: typeof fixture }).varroPlaybackCapture =
        fixture;
    },
    { session, initialMessages }
  );
  await page.goto('/e2e/harness/index.html?scenario=session-playback');
  await expect(page.locator('.user-message-card')).toContainText('Run the tests');
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'config/update',
          payload: {
            showTurnTimer: true,
            desktopSessionPaneSide: 'right',
            defaultPermissionMode: 'default',
            chatFontSize: 13,
            chatEditorFontSize: 13,
            chatFontFamily: '',
          },
        } satisfies ExtensionMessage,
      })
    )
  );
  const replay = (events: ServerEvent[]) =>
    page.evaluate((batch) => {
      // SAFETY: The controlled playback page exposes the mock event transport.
      const harness = (
        window as typeof window & {
          __varroE2E: { replayServerEvent(event: ServerEvent): void };
        }
      ).__varroE2E;
      for (const event of batch) harness.replayServerEvent(event);
    }, events);
  await replay([
    { type: 'session.status', properties: { sessionID: session.id, status: { type: 'busy' } } },
    { type: 'message.updated', properties: { info: assistant } },
    {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'answer-waiting',
          messageID: assistant.id,
          sessionID: session.id,
          type: 'text',
          text: 'Testing is still running.',
        },
      },
    },
    {
      type: 'session.status',
      properties: {
        sessionID: session.id,
        status: { type: 'busy', background: true, backgroundStartedAt: Date.now() - 13_000 },
      },
    },
    {
      type: 'message.updated',
      properties: {
        info: { ...assistant, finish: 'stop', time: { ...assistant.time, completed: Date.now() } },
      },
    },
  ]);
  const card = page.locator('.background-process');
  await expect(card).toBeVisible();
  await expect(card.locator('.tool-invocation-title')).toHaveText('Background process');
  await expect(page.locator('.toolbar-turn-timer')).toBeVisible();
  await expect(card.locator('.tool-call-wait-icon')).toBeVisible();
  await expect(card.locator('.tool-invocation-duration')).toHaveText(/1[3-9]s/);
  const layout = await card.evaluate((element) => {
    const cardBox = element.getBoundingClientRect();
    const title = element.querySelector('.tool-invocation-title')!.getBoundingClientRect();
    const duration = element.querySelector('.tool-invocation-duration')!.getBoundingClientRect();
    return {
      rightInset: cardBox.right - duration.right,
      titleEnd: title.right,
      durationStart: duration.left,
      height: cardBox.height,
    };
  });
  expect(layout.rightInset).toBeGreaterThan(0);
  expect(layout.rightInset).toBeLessThan(16);
  expect(layout.durationStart).toBeGreaterThanOrEqual(layout.titleEnd);
  expect(layout.height).toBeGreaterThan(24);
  await expect(page.locator('.assistant-dialog-summary')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('background-process.png') });
  const before = await card.boundingBox();
  const samples = await page.evaluate(async () => {
    const result: Array<{ top?: number; worked: boolean; turnTimer: boolean }> = [];
    for (let frame = 0; frame < 30; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      result.push({
        top: document.querySelector('.background-process')?.getBoundingClientRect().top,
        worked: !!document.querySelector('.assistant-dialog-summary'),
        turnTimer: !!document.querySelector('.toolbar-turn-timer'),
      });
    }
    return result;
  });
  expect(
    samples.every(
      (sample) =>
        !sample.worked &&
        sample.turnTimer &&
        sample.top !== undefined &&
        Math.abs(sample.top - before!.y) <= 1
    )
  ).toBe(true);
  const resumed = { ...assistant, id: 'assistant-resumed', time: { created: Date.now() } };
  await replay([
    {
      type: 'session.status',
      properties: { sessionID: session.id, status: { type: 'busy', background: true } },
    },
    { type: 'message.updated', properties: { info: resumed } },
  ]);
  await expect(card).toHaveCount(0);
  await expect(page.locator('.loading-verb')).toBeVisible();
  await expect(page.locator('.toolbar-turn-timer')).toBeVisible();
  await expect(page.locator('.assistant-dialog-summary')).toHaveCount(0);
  await replay([
    {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'answer-resumed',
          messageID: resumed.id,
          sessionID: session.id,
          type: 'text',
          text: 'All tests passed.',
        },
      },
    },
    {
      type: 'message.updated',
      properties: {
        info: { ...resumed, finish: 'stop', time: { ...resumed.time, completed: Date.now() } },
      },
    },
    { type: 'session.status', properties: { sessionID: session.id, status: { type: 'idle' } } },
  ]);
  await expect(page.locator('.assistant-dialog-summary')).toContainText('Worked for');
  await expect(page.locator('.loading-indicator')).toHaveCount(0);
  await expect(page.locator('.toolbar-turn-timer')).toHaveCount(0);
});
