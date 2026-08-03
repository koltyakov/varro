import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type HarnessApiResponse<T> = {
  data?: T;
  error?: string;
};

type MessagePage = {
  items: Array<{ info: { id: string } }>;
  nextCursor?: string;
};

async function requestHarnessApi<T>(page: Page, id: number, path: string) {
  return page.evaluate(
    async ({ requestId, requestPath }) => {
      const harnessWindow = window as Window & {
        __sendToExtension?: (message: unknown) => void | Promise<void>;
        __varroE2E?: {
          dispatchedMessages?: Array<{ type: string; payload?: unknown }>;
        };
      };
      const send = harnessWindow.__sendToExtension;
      const dispatchedMessages = harnessWindow.__varroE2E?.dispatchedMessages;
      if (!send || !dispatchedMessages) throw new Error('Harness bridge is unavailable');

      const firstNewMessage = dispatchedMessages.length;
      await send({
        type: 'api/request',
        payload: { id: requestId, method: 'GET', path: requestPath },
      });
      const response = dispatchedMessages.slice(firstNewMessage).find((message) => {
        if (message.type !== 'api/response' || !message.payload) return false;
        return (message.payload as { id?: number }).id === requestId;
      });
      if (!response?.payload) throw new Error(`Harness response ${requestId} is missing`);
      return response.payload as HarnessApiResponse<T> & { id: number };
    },
    { requestId: id, requestPath: path }
  );
}

test('windowed harness pagination is generic, opaque, and rejects invalid cursors', async ({
  page,
}) => {
  const sessionId = 'session-heterogeneous-large-transcript';
  const messagePath = `/session/${sessionId}/message`;
  await page.goto('/e2e/harness/index.html?scenario=heterogeneous-large-transcript&windowed=1');

  const first = await requestHarnessApi<MessagePage>(page, 91_001, `${messagePath}?limit=17`);
  expect(first.error).toBeUndefined();
  expect(Array.isArray(first.data)).toBe(false);
  if (!first.data || Array.isArray(first.data)) throw new Error('Expected a windowed message page');
  expect(first.data.items).toHaveLength(17);
  expect(first.data.nextCursor).toMatch(/^msg_cursor_[a-z0-9]+$/);
  expect(Number.isNaN(Number(first.data.nextCursor))).toBe(true);

  const firstCursor = first.data.nextCursor!;
  const second = await requestHarnessApi<MessagePage>(
    page,
    91_002,
    `${messagePath}?limit=17&before=${encodeURIComponent(firstCursor)}`
  );
  expect(second.error).toBeUndefined();
  if (!second.data) throw new Error('Expected a second windowed message page');
  expect(second.data.items).toHaveLength(17);
  expect(second.data.nextCursor).toMatch(/^msg_cursor_[a-z0-9]+$/);
  expect(second.data.nextCursor).not.toBe(firstCursor);

  const unknown = await requestHarnessApi<MessagePage>(
    page,
    91_003,
    `${messagePath}?limit=17&before=unknown-cursor`
  );
  expect(unknown).toMatchObject({
    error: 'Unknown message cursor "unknown-cursor"',
  });

  const mismatched = await requestHarnessApi<MessagePage>(
    page,
    91_004,
    `/session/session-other/message?limit=17&before=${encodeURIComponent(firstCursor)}`
  );
  expect(mismatched).toMatchObject({
    error: `Message cursor "${firstCursor}" belongs to session "${sessionId}", not "session-other"`,
  });

  await page.goto('/e2e/harness/index.html?scenario=heterogeneous-large-transcript');
  const allAtOnce = await requestHarnessApi<Array<{ info: { id: string } }>>(
    page,
    91_005,
    messagePath
  );
  expect(allAtOnce.error).toBeUndefined();
  expect(allAtOnce.data).toHaveLength(280);
});
