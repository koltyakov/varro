import { existsSync, readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import type { SessionMessageInfo } from '@opencode/client';
import {
  projectV2Message,
  isV2TranscriptMessage,
} from '../../src/extension/opencode-v2-projection';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry } from '../../src/webview/types';

test('reported short transcript geometry', async ({ page }, testInfo) => {
  const transcriptPath = 'tmp/scroll-reported-messages.json';
  test.skip(
    !existsSync(transcriptPath),
    `Local diagnostic requires a captured transcript at ${transcriptPath}`
  );
  const raw: { data: SessionMessageInfo[] } = JSON.parse(readFileSync(transcriptPath, 'utf8'));
  const sessionID = 'reported-scroll-copy';
  const userID = raw.data.find((message) => message.type === 'user')!.id;
  const messages = raw.data
    .filter(isV2TranscriptMessage)
    .slice(0, 12)
    .map((message) => {
      // SAFETY: Transcript messages are projected into the canonical info/parts shape by projectV2Message.
      return projectV2Message(message, sessionID, '/workspace', userID) as MessageEntry;
    });
  const session = {
    id: sessionID,
    projectID: 'test',
    directory: '/workspace',
    title: 'Reported scrolling',
    version: '1',
    time: { created: Date.now(), updated: Date.now() },
  };
  await page.setViewportSize({ width: 476, height: 1272 });
  await page.addInitScript(
    (fixture) => {
      // SAFETY: The isolated E2E harness reads this fixture before mounting.
      (window as typeof window & { varroPlaybackCapture: typeof fixture }).varroPlaybackCapture =
        fixture;
    },
    { session, initialMessages: messages.slice(0, 1) }
  );
  await page.goto('/e2e/harness/index.html?scenario=session-playback');
  await expect(page.locator('.interactive-list')).toBeVisible();
  const geometry = await page.locator('.interactive-list').evaluate(
    async (list, { messages: replayMessages, sessionID: replaySessionID }) => {
      // SAFETY: The session-playback harness installs this transport before the list becomes visible.
      const harness = (
        window as typeof window & { __varroE2E: { replayServerEvent(event: ServerEvent): void } }
      ).__varroE2E;
      const emit = (event: ServerEvent) => harness.replayServerEvent(event);
      emit({
        type: 'session.status',
        properties: { sessionID: replaySessionID, status: { type: 'busy' } },
      });
      const samples: unknown[] = [];
      const wait = async (count: number) => {
        for (let frame = 0; frame < count; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          if (list.scrollHeight > list.clientHeight)
            samples.push({
              top: list.scrollTop,
              overflow: list.scrollHeight - list.clientHeight,
              reserve: list.querySelector<HTMLElement>('.append-scroll-bottom-reserve')
                ?.offsetHeight,
              exit: list.querySelector<HTMLElement>('.activity-exit-bottom-reserve')?.offsetHeight,
            });
        }
      };
      for (const message of replayMessages.slice(1)) {
        emit({
          type: 'message.updated',
          properties: {
            info:
              message.info.role === 'assistant'
                ? {
                    ...message.info,
                    time: { created: message.info.time.created },
                    finish: undefined,
                  }
                : message.info,
          },
        });
        for (const part of message.parts) {
          if (part.type === 'tool') {
            emit({
              type: 'message.part.updated',
              properties: {
                part: {
                  ...part,
                  state: {
                    ...part.state,
                    status: 'running' as const,
                    time: {
                      start:
                        'time' in part.state ? part.state.time.start : message.info.time.created,
                    },
                  },
                },
              },
            });
            await wait(12);
          }
          emit({ type: 'message.part.updated', properties: { part } });
          await wait(5);
        }
        emit({ type: 'message.updated', properties: { info: message.info } });
        await wait(20);
      }
      await wait(120);
      return {
        samples: samples.slice(0, 10),
        count: samples.length,
        top: list.scrollTop,
        height: list.clientHeight,
        scrollHeight: list.scrollHeight,
        text: list.textContent,
        children: [...list.querySelector('.interactive-list-track')!.children].map((e) => ({
          cls: e.className,
          height: e.getBoundingClientRect().height,
          top: e.getBoundingClientRect().top,
        })),
      };
    },
    { messages, sessionID }
  );
  await testInfo.attach('scroll-geometry', {
    body: JSON.stringify(geometry, null, 2),
    contentType: 'application/json',
  });
  await page.screenshot({ path: testInfo.outputPath('scroll-reported.png') });
});
