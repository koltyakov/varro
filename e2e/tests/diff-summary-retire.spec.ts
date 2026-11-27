import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { AssistantMessage, MessageEntry } from '../../src/webview/types';
import type { ServerEvent, WebviewMessage } from '../../src/shared/protocol';
import { installPlaybackCapture } from './helpers';

const sessionId = 'diff-summary-retire';
const created = 1_780_000_000_000;
const suggestions = {
  summary: 'Two gaps remain. Investigating the failure and adding a test would address them.',
  actions: [
    { title: 'Inspect parser failures', prompt: 'Investigate the parser issue.' },
    { title: 'Add regression coverage', prompt: 'Add focused regression tests.' },
  ],
  combinable: true,
};

function assistant(id: string, parentID: string, completed = true): AssistantMessage {
  return {
    id,
    parentID,
    sessionID: sessionId,
    role: 'assistant',
    mode: 'build',
    agent: 'build',
    providerID: 'test',
    modelID: 'test',
    time: completed ? { created, completed: created + 1 } : { created: Date.now() },
    finish: completed ? 'stop' : undefined,
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function history(turns: number): MessageEntry[] {
  return Array.from({ length: turns }, (_, i) => {
    const userId = i === turns - 1 ? 'prompt' : `user-${i}`;
    const assistantId = i === turns - 1 ? 'answer' : `assistant-${i}`;
    return [
      {
        info: {
          id: userId,
          sessionID: sessionId,
          role: 'user',
          agent: 'build',
          model: { providerID: 'test', modelID: 'test' },
          time: { created: created + i * 10 },
        },
        parts: [
          {
            id: `text-${userId}`,
            messageID: userId,
            sessionID: sessionId,
            type: 'text',
            text: 'Fix the parser and report any unresolved issues.',
          },
        ],
      },
      {
        info: assistant(assistantId, userId),
        parts: [
          {
            id: `text-${assistantId}`,
            messageID: assistantId,
            sessionID: sessionId,
            type: 'text',
            text:
              i === turns - 1
                ? `The empty-token parser issue remains unresolved.\n\n${'Verified the focused behavior and kept unrelated code unchanged. '.repeat(10)}`
                : `Completed task ${i}.\n\n${'Verified the focused behavior and kept unrelated code unchanged. '.repeat(10)}`,
          },
        ],
      },
    ] satisfies MessageEntry[];
  }).flat();
}

for (const width of [480, 1280]) {
  test(`a new reply retires the previous change summary without scrolling back at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await installPlaybackCapture(page, {
      session: {
        id: sessionId,
        projectID: 'test',
        directory: '/workspace',
        title: 'Diff summary retire fixture',
        version: '1',
        time: { created, updated: created },
      },
      initialMessages: history(12),
      followups: { cacheDelayMs: 0, cached: suggestions, generated: suggestions },
      messageDiffs: {
        delayMs: 50,
        files: [
          { file: 'src/a.ts', additions: 10, deletions: 2 },
          { file: 'src/b.ts', additions: 3, deletions: 1 },
        ],
      },
    });
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    const list = page.locator('.interactive-list');
    const sendAll = page.getByRole('button', { name: 'Send all 2 follow-ups' });
    await expect(sendAll).toBeVisible();
    await expect(list).not.toHaveClass(/is-session-hydrating/);
    await expect(page.locator('[data-msg-id="answer"] .diff-summary')).toContainText(
      '2 files changed'
    );
    await page.waitForTimeout(400);

    await page.evaluate(() => {
      // SAFETY: This hook belongs only to the fake extension transport.
      const harness = window as {
        __sendToExtension?: (message: WebviewMessage) => void;
      };
      const send = harness.__sendToExtension;
      harness.__sendToExtension = (message) => {
        if (message.type === 'api/request' && /\/prompt_async(?:\?|$)/.test(message.payload.path)) {
          document.documentElement.dataset.sentBody = JSON.stringify(message.payload.body);
          window.setTimeout(() => {
            window.dispatchEvent(
              new MessageEvent('message', {
                data: { type: 'api/response', payload: { id: message.payload.id, data: null } },
              })
            );
          }, 60);
          return;
        }
        send?.(message);
      };
      type Frame = Record<string, number | string | boolean | null>;
      const frames: Frame[] = [];
      const start = performance.now();
      const sample = () => {
        const element = document.querySelector<HTMLElement>('.interactive-list');
        if (element) {
          const action = element.querySelector('.followup-action');
          const answer = element.querySelector('[data-msg-id="answer"]');
          const reserve = element.querySelector<HTMLElement>('.append-scroll-bottom-reserve');
          frames.push({
            t: Math.round(performance.now() - start),
            scrollTop: Math.round(element.scrollTop * 10) / 10,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
            bottomGap:
              Math.round((element.scrollHeight - element.scrollTop - element.clientHeight) * 10) /
              10,
            answerTop: answer ? Math.round(answer.getBoundingClientRect().top) : null,
            actionTop: action ? Math.round(action.getBoundingClientRect().top) : null,
            card: !!element.querySelector('.followup-suggestions'),
            summary: !!element.querySelector('[data-msg-id="answer"] .diff-summary'),
            reserve: reserve ? reserve.getBoundingClientRect().height : 0,
          });
        }
        if (document.documentElement.dataset.stopFrames === 'true') {
          document.documentElement.dataset.frames = JSON.stringify(frames);
        } else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    await sendAll.click();
    await expect(page.locator('html')).toHaveAttribute('data-sent-body', /./);
    // SAFETY: The intercepted body is the follow-up prompt request this page just sent.
    const body = JSON.parse((await page.locator('html').getAttribute('data-sent-body'))!) as {
      messageID?: string;
      parts?: Array<{ type: string; text?: string }>;
      followupTitle?: string;
    };
    const userId = body.messageID ?? 'followup-user';
    const replay = (events: ServerEvent[]) =>
      page.evaluate((batch) => {
        // SAFETY: Replay events update only the generated fixture in the fake backend.
        const harness = (
          window as typeof window & {
            __varroE2E: { replayServerEvent(event: ServerEvent): void };
          }
        ).__varroE2E;
        for (const event of batch) harness.replayServerEvent(event);
      }, events);
    await page.waitForTimeout(80);
    // SAFETY: These fixture events follow the OpenCode server event shapes the webview consumes.
    await replay([
      {
        type: 'message.updated',
        properties: {
          info: {
            id: userId,
            sessionID: sessionId,
            role: 'user',
            agent: 'build',
            model: { providerID: 'test', modelID: 'test' },
            time: { created: Date.now() },
            followupTitle: body.followupTitle,
          },
        },
      },
      ...(body.parts ?? [])
        .filter((part) => part.type === 'text')
        .map(
          (part, index) =>
            // SAFETY: These fixture events follow the OpenCode server event shapes the webview consumes.
            ({
              type: 'message.part.updated',
              properties: {
                part: {
                  id: `followup-text-${index}`,
                  messageID: userId,
                  sessionID: sessionId,
                  type: 'text',
                  text: part.text ?? '',
                },
              },
            }) as ServerEvent
        ),
      {
        type: 'session.status',
        properties: { sessionID: sessionId, status: { type: 'busy' } },
      },
    ] as ServerEvent[]);
    await page.waitForTimeout(300);
    const reply = assistant('reply', userId, false);
    // SAFETY: These fixture events follow the OpenCode server event shapes the webview consumes.
    await replay([
      { type: 'message.updated', properties: { info: reply } },
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'reply-step', messageID: 'reply', sessionID: sessionId, type: 'step-start' },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'reply-reasoning',
            messageID: 'reply',
            sessionID: sessionId,
            type: 'reasoning',
            text: 'Planning the parser investigation.',
            time: { start: Date.now() },
          },
        },
      },
    ] as ServerEvent[]);
    await page.waitForTimeout(900);
    // SAFETY: These fixture events follow the OpenCode server event shapes the webview consumes.
    await replay([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'reply-reasoning',
            messageID: 'reply',
            sessionID: sessionId,
            type: 'reasoning',
            text: 'Planning the parser investigation.',
            time: { start: Date.now() - 900, end: Date.now() },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'reply-tool',
            messageID: 'reply',
            sessionID: sessionId,
            type: 'tool',
            callID: 'call-read',
            tool: 'read',
            state: {
              status: 'running',
              input: { filePath: '/workspace/src/webview/components/MessageList.tsx' },
              time: { start: Date.now() },
            },
          },
        },
      },
    ] as ServerEvent[]);
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      document.documentElement.dataset.stopFrames = 'true';
    });
    await expect(page.locator('html')).toHaveAttribute('data-frames', /./);
    // SAFETY: The page sampler above serializes exactly these frame fields.
    const frames = JSON.parse((await page.locator('html').getAttribute('data-frames'))!) as Array<{
      scrollTop: number;
      answerTop: number | null;
      actionTop: number | null;
      summary: boolean;
    }>;
    await writeFile(testInfo.outputPath('frames.json'), JSON.stringify(frames, null, 2));
    await page.screenshot({ path: testInfo.outputPath('final.png') });
    // The new reply takes over the summary. A bottom-followed reader keeps its position: no
    // clamp frame scrolls back, and the previous reply never moves.
    expect(frames.some((frame) => frame.actionTop !== null && !frame.summary)).toBe(true);
    const backward = frames.filter(
      (frame, index) => index > 0 && frame.scrollTop < frames[index - 1]!.scrollTop - 1
    );
    expect(backward).toEqual([]);
    const tops = frames.map((frame) => frame.answerTop!);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
  });
}
