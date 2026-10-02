import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry } from '../../src/webview/types';
import { verifySessionPlayback } from '../session-playback';
import type { PlaybackFixture } from '../session-playback';

function nativePlayback(): PlaybackFixture {
  const sessionID = 'session-native-playback';
  const model = { providerID: 'test', modelID: 'test' };
  const user: MessageEntry = {
    info: {
      id: 'user-native-playback',
      sessionID,
      role: 'user',
      time: { created: 1 },
      agent: 'build',
      model,
    },
    parts: [
      {
        id: 'prompt-native-playback',
        sessionID,
        messageID: 'user-native-playback',
        type: 'text',
        text: 'VFZ-REPLAY-INPUT',
      },
    ],
  };
  const assistant: MessageEntry = {
    info: {
      id: 'assistant-native-playback',
      sessionID,
      role: 'assistant',
      parentID: user.info.id,
      time: { created: 2, completed: 9 },
      finish: 'stop',
      agent: 'build',
      mode: 'build',
      ...model,
      path: { cwd: '/workspace/varro', root: '/workspace/varro' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: 'text-native-playback',
        sessionID,
        messageID: 'assistant-native-playback',
        type: 'text',
        text: 'VFZ-REPLAY-FIRST VFZ-REPLAY-LAST',
      },
    ],
  };
  const properties = {
    sessionID,
    assistantMessageID: assistant.info.id,
    textID: assistant.parts[0]!.id,
  };
  const events: ServerEvent[] = [
    { type: 'session.next.prompted', properties: { sessionID, messageID: user.info.id } },
    { type: 'session.status', properties: { sessionID, status: { type: 'busy' } } },
    {
      type: 'session.next.step.started',
      properties: { ...properties, model, agent: 'build', timestamp: 2 },
    },
    { type: 'session.next.text.started', properties },
    { type: 'session.next.text.delta', properties: { ...properties, delta: 'VFZ-REPLAY-FIRST ' } },
    { type: 'session.next.text.delta', properties: { ...properties, delta: 'VFZ-REPLAY-LAST' } },
    {
      type: 'session.next.text.ended',
      properties: { ...properties, text: 'VFZ-REPLAY-FIRST VFZ-REPLAY-LAST' },
    },
    { type: 'session.next.step.ended', properties: { ...properties, finish: 'stop' } },
    { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } },
  ];
  return {
    capture: {
      id: 1,
      label: 'Native v2 browser playback',
      scenario: 'TEST',
      session: {
        id: sessionID,
        projectID: 'playback-project',
        directory: '/workspace/varro',
        title: 'Native v2 browser playback',
        version: '2',
        time: { created: 1, updated: 9 },
      },
      initialMessages: [],
      finalMessages: [user, assistant],
    },
    timeline: events.map((event, index) => ({
      delayMs: 100,
      sourceGapMs: 100,
      offsetMs: (index + 1) * 100,
      event,
    })),
  };
}

test('native v2 browser playback updates fake REST state and paints the recorded response', async ({
  page,
}) => {
  const playback = nativePlayback();
  const original = structuredClone(playback);
  await verifySessionPlayback(page, playback);
  await expect(page.locator('[data-msg-id="user-native-playback"]')).toContainText(
    'VFZ-REPLAY-INPUT'
  );
  await expect(page.locator('[data-msg-id="assistant-native-playback"]')).toContainText(
    'VFZ-REPLAY-FIRST VFZ-REPLAY-LAST'
  );
  expect(playback).toEqual(original);
});

test('native browser playback rejects incompatible terminal text instead of substituting final history', async ({
  page,
}) => {
  const playback = nativePlayback();
  const end = playback.timeline.find((entry) => entry.event.type === 'session.next.text.ended');
  if (!end || end.event.type !== 'session.next.text.ended' || !end.event.properties)
    throw new Error('Missing test text end');
  end.event.properties = { ...end.event.properties, text: 'incorrect terminal text' };
  await expect(verifySessionPlayback(page, playback)).rejects.toThrow(
    'V2 terminal text differs from capture'
  );
});

test('native browser playback exposes only delivered text and does not repair an incomplete capture', async ({
  page,
}) => {
  const playback = nativePlayback();
  playback.timeline = playback.timeline.slice(0, 5);
  await expect(verifySessionPlayback(page, playback)).rejects.toThrow(/toEqual/);
  const messages = await page.evaluate(() => {
    // SAFETY: The controlled harness installs this read-only test API before playback.
    const harness = (
      window as typeof window & {
        __varroE2E: { getSessionMessages: (id: string) => MessageEntry[] };
      }
    ).__varroE2E;
    return harness.getSessionMessages('session-native-playback');
  });
  const assistant = messages.find((entry) => entry.info.role === 'assistant');
  expect(assistant?.parts).toEqual([
    {
      id: 'text-native-playback',
      sessionID: 'session-native-playback',
      messageID: 'assistant-native-playback',
      type: 'text',
      text: 'VFZ-REPLAY-FIRST ',
    },
  ]);
  expect(assistant?.info.time).toEqual({ created: 2 });
  await expect(page.locator('[data-msg-id="assistant-native-playback"]')).toContainText(
    'VFZ-REPLAY-FIRST'
  );
  await expect(page.locator('[data-msg-id="assistant-native-playback"]')).not.toContainText(
    'VFZ-REPLAY-LAST'
  );
});
