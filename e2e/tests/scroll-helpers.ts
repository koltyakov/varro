import type { Page } from '@playwright/test';

type StreamingPartTarget = {
  sessionID: string;
  messageID: string;
  partID: string;
};

async function appendStreamingDelta(page: Page, target: StreamingPartTarget, delta: string) {
  await page.evaluate(
    ({ part, nextDelta }) => {
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'message.part.delta',
            properties: {
              sessionID: part.sessionID,
              messageID: part.messageID,
              partID: part.partID,
              field: 'text',
              delta: nextDelta,
            },
          },
        },
        '*'
      );
    },
    { part: target, nextDelta: delta }
  );
}

export async function appendDeltaToLastLargeAssistant(page: Page, delta: string) {
  await appendStreamingDelta(
    page,
    {
      sessionID: 'session-large-transcript',
      messageID: 'message-large-assistant-239',
      partID: 'message-large-assistant-239-text-1',
    },
    delta
  );
}

export async function appendDeltaToRapidStreaming(page: Page, delta: string) {
  await appendStreamingDelta(
    page,
    {
      sessionID: 'session-rapid-streaming-jitter',
      messageID: 'message-rapid-assistant-streaming',
      partID: 'message-rapid-assistant-streaming-text-1',
    },
    delta
  );
}

export async function appendDeltaToMultiAgentStreaming(page: Page, delta: string) {
  await appendStreamingDelta(
    page,
    {
      sessionID: 'session-multi-agent-streaming',
      messageID: 'message-multi-agent-assistant-streaming',
      partID: 'message-multi-agent-assistant-streaming-text-1',
    },
    delta
  );
}

export async function appendDeltaToMultiAgentLargeStreaming(page: Page, delta: string) {
  await appendStreamingDelta(
    page,
    {
      sessionID: 'session-multi-agent-large-streaming',
      messageID: 'message-mla-assistant-streaming',
      partID: 'message-mla-assistant-streaming-text-1',
    },
    delta
  );
}
