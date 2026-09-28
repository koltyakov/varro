import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import {
  projectV2Message,
  isV2TranscriptMessage,
} from '../../src/extension/opencode-v2-projection';
import type { SessionMessageInfo } from '@opencode/client';

test('reported short transcript geometry', async ({ page }) => {
  const raw: { data: SessionMessageInfo[] } = JSON.parse(
    readFileSync('tmp/scroll-reported-messages.json', 'utf8')
  );
  const sessionID = 'reported-scroll-copy';
  const userID = raw.data.find((message) => message.type === 'user')!.id;
  const messages = raw.data
    .filter(isV2TranscriptMessage)
    .slice(0, 12)
    .map((message) => projectV2Message(message, sessionID, '/workspace', userID));
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
      (window as typeof window & { varroPlaybackCapture: typeof fixture }).varroPlaybackCapture =
        fixture;
    },
    { session, initialMessages: messages.slice(0, 1) }
  );
  await page.goto('/e2e/harness/index.html?scenario=session-playback');
  await expect(page.locator('.interactive-list')).toBeVisible();
  console.log(
    await page.locator('.interactive-list').evaluate(
      async (list, { messages, sessionID }) => {
        const harness = (
          window as typeof window & { __varroE2E: { replayServerEvent(event: unknown): void } }
        ).__varroE2E;
        const emit = (type: string, properties: unknown) =>
          harness.replayServerEvent({ type, properties });
        emit('session.status', { sessionID, status: { type: 'busy' } });
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
                exit: list.querySelector<HTMLElement>('.activity-exit-bottom-reserve')
                  ?.offsetHeight,
              });
          }
        };
        for (const message of messages.slice(1)) {
          emit('message.updated', {
            info: {
              ...message.info,
              time: { created: (message.info.time as { created: number }).created },
              finish: undefined,
            },
          });
          for (const part of message.parts) {
            if (part.type === 'tool') {
              emit('message.part.updated', {
                part: { ...part, state: { ...(part.state as object), status: 'running' } },
              });
              await wait(12);
            }
            emit('message.part.updated', { part });
            await wait(5);
          }
          emit('message.updated', { info: message.info });
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
    )
  );
  await page.screenshot({ path: 'tmp/scroll-reported.png' });
});
